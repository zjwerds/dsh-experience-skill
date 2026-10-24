/**
 * store.js — 本地 registry + 日志的读写。
 *
 * 设计要点（MVP）：
 *  - registry.json 是唯一事实源；写入走「临时文件 + rename」原子替换；
 *  - 每次写入 rev+1，调用方可用 expectedRev 做 CAS（冲突抛 REV_CONFLICT）；
 *  - 坏文件备份为 .corrupt-<ts> 后从空库继续（可重建）；不静默覆盖；
 *  - 日志 JSONL 只追加；trace/目录带日期分片。
 *
 * 单写者：MVP 假设同一 $DSH_HOME 只有一个 DSH 进程写；多窗口时后续加目录锁。
 */
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync,
  statSync, unlinkSync, writeFileSync, appendFileSync, copyFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildIndex } from './indexer.js';
import { redact } from './text.js';

export const REGISTRY_FILE = 'registry.json';
export const SCHEMA_VERSION = 1;

/** 空 registry。 */
export function emptyRegistry(now = Date.now()) {
  return {
    schema: SCHEMA_VERSION,
    rev: 0,
    createdAt: now,
    updatedAt: now,
    experiences: [],
    issues: [],
    tasks: [],
    attempts: [],
    evidence: [],
    meta: { indexRev: 0 },
  };
}

function tmpPathFor(filePath) {
  return `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function bestEffortChmod(target, mode) {
  try {
    chmodSync(target, mode);
  } catch {
    // Windows 上通常无效，忽略。
  }
}

export class Store {
  /**
   * @param {{dataDir: string, now?: () => number, logger?: {warn: Function, debug: Function}}} options
   */
  constructor(options) {
    if (typeof options?.dataDir !== 'string' || options.dataDir === '') {
      throw new Error('STORE_DATA_DIR_REQUIRED');
    }
    this.dataDir = options.dataDir;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.readOnly = options.readOnly === true;
    this.logger = options.logger ?? { warn: () => {}, debug: () => {} };
    this.registry = null;
    this.index = null;
    this.retrievalUsage = { day: null, count: 0, tokens: 0 };
    this.registryPath = join(this.dataDir, REGISTRY_FILE);
  }

  init() {
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    bestEffortChmod(this.dataDir, 0o700);
    mkdirSync(join(this.dataDir, 'logs'), { recursive: true, mode: 0o700 });
    mkdirSync(join(this.dataDir, 'traces'), { recursive: true, mode: 0o700 });
    if (!existsSync(this.registryPath)) {
      this.registry = emptyRegistry(this.now());
      if (!this.readOnly) this.writeRegistry();
      this.rebuildIndex();
      this.loadRetrievalUsage();
      return this.registry;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.registryPath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.experiences)) {
        throw new Error('BAD_SHAPE');
      }
      if (Number.isInteger(parsed.schema) && parsed.schema > SCHEMA_VERSION) {
        const error = new Error('REGISTRY_SCHEMA_TOO_NEW');
        error.code = 'REGISTRY_SCHEMA_TOO_NEW';
        throw error;
      }
      this.registry = {
        schema: Number.isInteger(parsed.schema) ? parsed.schema : SCHEMA_VERSION,
        rev: Number.isInteger(parsed.rev) ? parsed.rev : 0,
        createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : this.now(),
        updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : this.now(),
        experiences: parsed.experiences,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
        attempts: Array.isArray(parsed.attempts) ? parsed.attempts : [],
        evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
        meta: parsed.meta !== null && typeof parsed.meta === 'object' ? parsed.meta : { indexRev: 0 },
      };
    } catch (error) {
      if (error?.code === 'REGISTRY_SCHEMA_TOO_NEW') {
        try { copyFileSync(this.registryPath, `${this.registryPath}.future-${this.now()}`); } catch { /* 忽略 */ }
        this.logger.warn('REGISTRY_SCHEMA_TOO_NEW', { code: 'SCHEMA' });
        throw error;
      }
      const backup = `${this.registryPath}.corrupt-${this.now()}`;
      try { copyFileSync(this.registryPath, backup); } catch { /* 忽略 */ }
      this.logger.warn('REGISTRY_CORRUPT', { code: 'CORRUPT', backup: 1 });
      this.registry = emptyRegistry(this.now());
      if (!this.readOnly) this.writeRegistry();
    }
    this.rebuildIndex();
    this.loadRetrievalUsage();
    return this.registry;
  }

  usageDay() {
    const date = new Date(this.now());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  loadRetrievalUsage() {
    const saved = this.loadCheckpoints().retrieval;
    const day = this.usageDay();
    if (saved !== null && typeof saved === 'object' && saved.day === day) {
      this.retrievalUsage = {
        day,
        count: Number.isFinite(saved.count) ? saved.count : 0,
        tokens: Number.isFinite(saved.tokens) ? saved.tokens : 0,
      };
    } else {
      this.retrievalUsage = { day, count: 0, tokens: 0 };
    }
    return this.retrievalUsage;
  }

  /** 检索预算门：按天计数。token 预算不足时允许 1 条结果。 */
  reserveRetrieval(config, estimateTokens) {
    const usage = this.loadRetrievalUsage();
    const maxCount = Number.isFinite(config.maxRetrievalsPerDay) ? config.maxRetrievalsPerDay : 8;
    const maxTokens = Number.isFinite(config.dailyRetrievalTokens) ? config.dailyRetrievalTokens : 25000;
    if (usage.count >= maxCount) return { allowed: false, reason: 'COUNT' };
    const limited = usage.tokens + estimateTokens > maxTokens;
    usage.count += 1;
    usage.tokens += Math.max(0, Number.isFinite(estimateTokens) ? estimateTokens : 0);
    this.retrievalUsage = usage;
    if (!this.readOnly) {
      try {
        const checkpoints = this.loadCheckpoints();
        checkpoints.retrieval = usage;
        this.saveCheckpoints(checkpoints);
      } catch { /* 忽略 */ }
    }
    return { allowed: true, limit: limited ? 1 : undefined, reason: limited ? 'TOKENS' : undefined };
  }

  /** 用实际结果 token 修正占位估算。 */
  adjustRetrievalTokens(delta) {
    if (!Number.isFinite(delta) || delta === 0) return;
    const usage = this.loadRetrievalUsage();
    usage.tokens = Math.max(0, usage.tokens + delta);
    this.retrievalUsage = usage;
    if (this.readOnly) return;
    try {
      const checkpoints = this.loadCheckpoints();
      checkpoints.retrieval = usage;
      this.saveCheckpoints(checkpoints);
    } catch { /* 忽略 */ }
  }

  /** 检索命中后更新使用统计（不因统计失败影响检索）。 */
  recordRetrievalStats(ids, now = this.now()) {
    const wanted = new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string'));
    if (wanted.size === 0 || this.readOnly) return false;
    try {
      this.update((draft) => {
        for (const item of draft.experiences) {
          if (item === null || typeof item !== 'object' || !wanted.has(item.id)) continue;
          const stats = item.stats !== null && typeof item.stats === 'object' ? item.stats : {};
          stats.retrieved = (stats.retrieved ?? 0) + 1;
          item.stats = stats;
          item.lastUsedAt = now;
        }
        return undefined;
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 重建 active 经验的内存倒排索引。 */
  rebuildIndex() {
    this.index = buildIndex(
      Array.isArray(this.registry?.experiences) ? this.registry.experiences : [],
      { now: this.now() },
    );
    return this.index;
  }

  /** 当前索引快照（只读）。 */
  indexSnapshot() {
    if (this.index === null) this.rebuildIndex();
    return this.index;
  }

  /** 当前快照（只读，别改）。 */
  snapshot() {
    if (this.registry === null) throw new Error('STORE_NOT_INITIALIZED');
    return this.registry;
  }

  /** 覆盖写 registry（rev 由调用方维护）。 */
  writeRegistry() {
    const body = JSON.stringify(this.registry, null, 2) + '\n';
    const tmp = tmpPathFor(this.registryPath);
    writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    bestEffortChmod(tmp, 0o600);
    renameSync(tmp, this.registryPath);
    bestEffortChmod(this.registryPath, 0o600);
  }

  /**
   * 事务式更新：mutator 收到深拷贝，返回新 registry 或原地修改；
   * expectedRev 不匹配时抛 REV_CONFLICT（不覆盖）。
   * @param {(draft: object, now: number) => object|void} mutator
   * @param {{expectedRev?: number}} [options]
   */
  update(mutator, options = {}) {
    if (this.registry === null) throw new Error('STORE_NOT_INITIALIZED');
    if (this.readOnly) {
      const error = new Error('READ_ONLY');
      error.code = 'READ_ONLY';
      throw error;
    }
    const expected = options.expectedRev;
    if (Number.isInteger(expected) && expected !== this.registry.rev) {
      const error = new Error('REV_CONFLICT');
      error.code = 'REV_CONFLICT';
      throw error;
    }
    const draft = structuredClone(this.registry);
    const result = mutator(draft, this.now());
    const next = result !== null && typeof result === 'object' ? result : draft;
    next.rev = this.registry.rev + 1;
    next.updatedAt = this.now();
    this.registry = next;
    this.writeRegistry();
    this.rebuildIndex();
    return next;
  }

  /** 追加一行 JSONL；自动建目录。 */
  appendJsonl(relativePath, value) {
    this.appendJsonlMany(relativePath, [JSON.stringify(value)]);
  }

  /** 批量追加（value 为已序列化行或对象）。 */
  appendJsonlMany(relativePath, lines) {
    if (this.readOnly) return;
    if (!Array.isArray(lines) || lines.length === 0) return;
    const filePath = join(this.dataDir, relativePath);
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const body = lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\n') + '\n';
    appendFileSync(filePath, body, { encoding: 'utf8', mode: 0o600 });
    bestEffortChmod(filePath, 0o600);
  }

  /** trace 文件路径（按日期分片，sessionId 只保留安全字符）。 */
  tracePathFor(sessionId, now = this.now()) {
    const date = new Date(now);
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const safe = String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96);
    return join('traces', `${yyyy}${mm}${dd}`, `${safe}.trace.jsonl`);
  }

  /** checkpoints.json：trace 文件偏移 + 调度器预算/批次状态。 */
  loadCheckpoints() {
    const filePath = join(this.dataDir, 'checkpoints.json');
    const empty = { version: 1, traceOffsets: {}, scheduler: {}, retrieval: {} };
    if (!existsSync(filePath)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
      return {
        version: 1,
        traceOffsets: parsed?.traceOffsets !== null && typeof parsed?.traceOffsets === 'object' ? parsed.traceOffsets : {},
        scheduler: parsed?.scheduler !== null && typeof parsed?.scheduler === 'object' ? parsed.scheduler : {},
        retrieval: parsed?.retrieval !== null && typeof parsed?.retrieval === 'object' ? parsed.retrieval : {},
      };
    } catch {
      return empty;
    }
  }

  saveCheckpoints(checkpoints) {
    if (this.readOnly) return;
    const filePath = join(this.dataDir, 'checkpoints.json');
    const tmp = tmpPathFor(filePath);
    writeFileSync(tmp, JSON.stringify(checkpoints, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    bestEffortChmod(tmp, 0o600);
    renameSync(tmp, filePath);
    bestEffortChmod(filePath, 0o600);
  }

  /** 记录一次检索（只存摘要，不存原文）。 */
  recordRetrieval(entry) {
    this.appendJsonl(join('logs', 'retrieval.jsonl'), entry);
  }

  /**
   * 记录反馈：日志 + 更新条目 stats。
   * @param {{retrievalId: string, used?: string[], irrelevant?: string[], outcome?: string, resultSignal?: string, note?: string}} feedback
   */
  recordFeedback(feedback) {
    const now = this.now();
    const used = Array.isArray(feedback.used) ? feedback.used.filter((x) => typeof x === 'string') : [];
    const irrelevant = Array.isArray(feedback.irrelevant) ? feedback.irrelevant.filter((x) => typeof x === 'string') : [];
    const outcome = typeof feedback.outcome === 'string' ? feedback.outcome : 'unknown';
    const resultSignal = ['objective', 'user', 'model'].includes(feedback.resultSignal)
      ? feedback.resultSignal
      : 'model';
    this.appendJsonl(join('logs', 'feedback.jsonl'), {
      ts: now,
      retrievalId: feedback.retrievalId ?? null,
      used,
      irrelevant,
      outcome,
      resultSignal,
      note: typeof feedback.note === 'string' ? redact(feedback.note, 300) : '',
    });
    if (used.length === 0 && irrelevant.length === 0) return { changed: false };
    const usedSet = new Set(used);
    const irrelevantSet = new Set(irrelevant);
    const updated = this.update((draft) => {
      for (const item of draft.experiences) {
        if (item === null || typeof item !== 'object') continue;
        const stats = item.stats !== null && typeof item.stats === 'object' ? item.stats : {};
        if (usedSet.has(item.id)) {
          stats.adopted = (stats.adopted ?? 0) + 1;
          item.lastUsedAt = now;
          if (resultSignal !== 'model') {
            if (outcome === 'improved') stats.improved = (stats.improved ?? 0) + 1;
            if (outcome === 'harmful') stats.harmful = (stats.harmful ?? 0) + 1;
          }
          const adopted = stats.adopted;
          const harmful = stats.harmful ?? 0;
          if (item.status === 'active' && (harmful >= 3 || (adopted >= 5 && harmful / adopted >= 0.5))) {
            item.status = 'pending_review';
            item.flags = Array.isArray(item.flags) ? item.flags : [];
            if (!item.flags.includes('needs_review')) item.flags.push('needs_review');
            item.updatedAt = now;
          }
        }
        if (irrelevantSet.has(item.id)) {
          stats.falsePositive = (stats.falsePositive ?? 0) + 1;
        }
        item.stats = stats;
      }
    });
    return { changed: true, rev: updated.rev };
  }

  /** 健康检查：文件存在性 + 大小（不读内容）。 */
  health() {
    const problems = [];
    if (!existsSync(this.registryPath)) problems.push('REGISTRY_MISSING');
    else {
      try {
        const size = statSync(this.registryPath).size;
        if (size === 0) problems.push('REGISTRY_EMPTY');
      } catch {
        problems.push('REGISTRY_UNREADABLE');
      }
    }
    return { ok: problems.length === 0, problems };
  }
}

/** 删除临时文件（测试/异常清理用）。 */
export function removeIfExists(filePath) {
  try { unlinkSync(filePath); } catch { /* 忽略 */ }
}
