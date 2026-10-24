/**
 * dsh-experience-skill — host-only DSH 插件（Phase 1 骨架）。
 *
 * 唯一 Skill List 入口：experience-retrieval（description 中文，正文按需加载）。
 * 本地工具：experience_search（0 模型调用，按筛选词+条件返回 ≤2 条经验）。
 * 旁路采集：session/event 白名单写 trace（不调用模型）。
 * 心跳：45min 只做 flush/统计，不调用模型。
 */
import { resolveConfig, resolveDataDir } from './config.js';
import { Store } from './store.js';
import { ENTRY_BODY, SKILL_DESCRIPTION, SKILL_NAME } from './skill.js';
import { createExperienceSearchTool } from './tools.js';
import { createTraceWriter } from './trace.js';
import { createScheduler } from './scheduler.js';
import { acquireDataLock } from './lock.js';
import { healthCheck } from './health.js';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'dsh-experience-skill';

/** 依赖 tools/skills/llm：检索与采集不调用 llm，但批量 Analyzer 需要。 */
export const inject = ['tools', 'skills', 'llm'];

function createLogger(config) {
  const write = (level, code, info) => {
    if (level === 'debug' && config.debug !== true) return;
    const suffix = info !== null && typeof info === 'object'
      ? ' (' + Object.entries(info)
        .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/.test(v)))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ') + ')'
      : '';
    const line = `dsh-experience-skill: ${code}${suffix}`;
    if (level === 'warn') console.warn(line);
    else if (level === 'debug') console.debug(line);
    else console.info(line);
  };
  return {
    debug: (code, info) => write('debug', code, info),
    info: (code, info) => write('info', code, info),
    warn: (code, info) => write('warn', code, info),
  };
}

/**
 * cordis apply。
 * @param {object} ctx
 * @param {object} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  if (config.enabled !== true) return;
  const logger = createLogger(config);

  const dataDir = resolveDataDir(config);
  let lock = null;
  let writable = false;
  try {
    lock = acquireDataLock(dataDir);
    writable = lock !== null;
  } catch {
    writable = false;
  }

  let store;
  try {
    store = new Store({ dataDir, logger, readOnly: !writable });
    store.init();
  } catch (error) {
    logger.warn('STORE_INIT_FAILED', { code: errorCode(error) });
    if (lock !== null) {
      try { lock.release(); } catch { /* 忽略 */ }
    }
    return;
  }

  if (writable) {
    const rebuildFlag = join(dataDir, '.rebuild-traces');
    if (existsSync(rebuildFlag)) {
      try {
        const checkpoints = store.loadCheckpoints();
        checkpoints.traceOffsets = {};
        store.saveCheckpoints(checkpoints);
        store.update((draft) => {
          const withExperience = new Set((draft.experiences ?? []).map((item) => item?.issueId));
          for (const issue of draft.issues ?? []) {
            if (!withExperience.has(issue.id) && Number.isFinite(issue.analyzedAt)) {
              delete issue.analyzedAt;
              delete issue.analysisBatchId;
              issue.analysisAttempts = 0;
            }
          }
          return undefined;
        });
        rmSync(rebuildFlag, { force: true });
        logger.warn('TRACE_REBUILD_ON_NEXT_TICK', { code: 'REBUILD' });
      } catch (error) {
        logger.warn('TRACE_REBUILD_FAILED', { code: errorCode(error) });
      }
    }
    try {
      const health = healthCheck(store, { repair: true });
      logger.debug('HEALTH', {
        missing: health.missing.length,
        repaired: health.repaired,
        orphans: health.orphans,
        terms: health.index.terms,
      });
    } catch (error) {
      logger.warn('HEALTH_CHECK_FAILED', { code: errorCode(error) });
    }
  } else {
    logger.warn('READ_ONLY_LOCK_HELD', { code: 'LOCK_HELD' });
  }

  const effect = (fn, label) => {
    try {
      return ctx.effect(fn, label);
    } catch (error) {
      logger.warn('EFFECT_REGISTER_FAILED', { code: errorCode(error), label });
      return () => {};
    }
  };

  // 唯一 Skill 入口（不把任何经验注册成 Skill）。
  effect(() => {
    const dispose = ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      source: 'dsh-experience-skill',
      content: ENTRY_BODY,
    });
    return typeof dispose === 'function' ? dispose : () => {};
  }, 'dsh-experience-skill: skill');

  // 本地检索工具。
  const tool = createExperienceSearchTool(store, config);
  effect(() => {
    const dispose = ctx.tools.register(tool);
    return typeof dispose === 'function' ? dispose : () => {};
  }, 'dsh-experience-skill: tool');

  // 只读降级：另一个窗口持有写锁时，仍提供检索，但不采集/不学习/不写反馈。
  if (writable) {
    // 轨迹采集（旁路；白名单；未知事件忽略）+ 调度器（回合结束轻量观察）。
    const writer = createTraceWriter(store, { logger, config });
    let scheduler;
    try {
      scheduler = createScheduler({ store, llm: ctx.llm, config, logger });
    } catch (error) {
      logger.warn('SCHEDULER_INIT_FAILED', { code: errorCode(error) });
    }
    if (scheduler !== undefined) {
      effect(() => {
        scheduler.start();
        return () => scheduler.stop();
      }, 'dsh-experience-skill: scheduler');
    }

    effect(() => {
      if (typeof ctx.on !== 'function') return () => {};
      const dispose = ctx.on('session/event', (session, event) => {
        try {
          writer.push(session, event);
        } catch {
          // 采集失败不影响会话。
        }
        try {
          scheduler?.handleEvent(session, event);
        } catch {
          // 观察失败不影响会话。
        }
      });
      return () => {
        writer.flushAll();
        if (typeof dispose === 'function') dispose();
      };
    }, 'dsh-experience-skill: trace');

    // 45min 心跳：只 flush trace + 轻量统计，不调用模型。
    effect(() => {
      const timer = setInterval(() => {
        try {
          writer.flushAll();
          const stats = writer.stats();
          logger.debug('HEARTBEAT', { sessions: stats.sessions, pending: stats.pending });
        } catch (error) {
          logger.warn('HEARTBEAT_FAILED', { code: errorCode(error) });
        }
      }, Math.max(60_000, config.scheduleIntervalMs));
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    }, 'dsh-experience-skill: heartbeat');
  }

  if (lock !== null) {
    effect(() => () => { lock.release(); }, 'dsh-experience-skill: writer-lock');
  }
}

function errorCode(error) {
  if (error === null || error === undefined) return 'UNKNOWN';
  const code = typeof error === 'string' ? error : error.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/.test(code)) return code;
  return 'UNKNOWN';
}
