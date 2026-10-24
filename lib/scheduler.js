/**
 * scheduler.js — 45min 心跳 + 回合结束轻量检查 + 预算门 + 观察推进。
 *
 * 阶段严格分开：
 *  ① tick()：本地检查/增量 trace/条件判断（0 模型）
 *  ② 仅当预算/忙/间隔都通过，才调用 runBatch（≤1 次语义调用/批）
 *  ③ 写回候选 → 推进 observing/门禁（0 模型）
 */
import { readTraceIncrement } from './trace-reader.js';
import { correlate, mergeCorrelation } from './correlate.js';
import { runBatch } from './analyzer.js';
import {
  activateReadyDraft, observeDraft, startObservationDraft, sweepObservationsDraft,
} from './lifecycle.js';
import { syncExperienceFiles } from './files.js';
import { pruneTraces } from './retention.js';
import { messageText, redact, shortHash, truncate } from './text.js';

const BUSY_STALE_MS = 30 * 60 * 1000;

function dayKey(now) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isSubagent(session) {
  const header = session?.header;
  if (header === null || typeof header !== 'object') return false;
  if (header.origin === 'subagent') return true;
  return Number(header.delegationDepth ?? 0) > 0;
}

/** 从会话快照取某个回合的用户/助手/工具结果文本（脱敏、截断）。 */
export function collectTurnText(session, turn) {
  try {
    if (typeof session?.snapshotEvents !== 'function') return '';
    const events = session.snapshotEvents();
    if (!Array.isArray(events)) return '';
    let currentTurn;
    const parts = [];
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue;
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
      if (event.type === 'turn/start') {
        if (Number.isInteger(data.turn)) currentTurn = data.turn;
        continue;
      }
      if (event.type === 'turn/end') {
        currentTurn = undefined;
        continue;
      }
      const eventTurn = Number.isInteger(data.turn) ? data.turn : currentTurn;
      if (eventTurn !== turn) continue;
      if (event.type === 'user/message') parts.push(messageText(data.content));
      else if (event.type === 'assistant/message') parts.push(messageText(data.message?.content));
      else if (event.type === 'tool/result') {
        parts.push(truncate(messageText(data.message?.content), 300));
      }
    }
    return truncate(redact(parts.filter((part) => part.trim() !== '').join('\n'), 1200), 1200);
  } catch {
    return '';
  }
}

/** 统计某个回合的工具调用数（用于“有效任务交互”判定）。 */
export function countTurnToolCalls(session, turn) {
  try {
    if (typeof session?.snapshotEvents !== 'function') return 0;
    const events = session.snapshotEvents();
    if (!Array.isArray(events)) return 0;
    let currentTurn;
    let count = 0;
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue;
      const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
      if (event.type === 'turn/start') {
        if (Number.isInteger(data.turn)) currentTurn = data.turn;
        continue;
      }
      if (event.type === 'turn/end') {
        currentTurn = undefined;
        continue;
      }
      const eventTurn = Number.isInteger(data.turn) ? data.turn : currentTurn;
      if (eventTurn === turn && event.type === 'tool/call') count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * @param {{store: import('./store.js').Store, llm?: object, config: object, logger?: object, now?: () => number}} options
 */
export function createScheduler(options) {
  const { store, llm, config } = options;
  const logger = options.logger ?? { debug: () => {}, warn: () => {} };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const state = {
    running: false,
    timer: null,
    busy: new Map(),
    traceOffsets: {},
    route: null,
    scheduler: { day: dayKey(now()), calls: 0, tokens: 0, batches: 0, pendingTurns: 0, lastBatchAt: 0, lastTickAt: 0, lastPruneAt: 0, lastError: null },
    lastResult: null,
  };

  /** 从会话请求头捕获当前模型路由（Analyzer 必须显式带 provider/model）。 */
  function captureRoute(session) {
    try {
      const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : session?.header;
      const route = header?.config;
      if (route !== null && typeof route === 'object' && typeof route.provider === 'string' && typeof route.model === 'string') {
        state.route = { provider: route.provider, model: route.model };
      }
    } catch {
      // 路由拿不到就保留旧值；最后回退 config。
    }
  }

  function load() {
    const checkpoints = store.loadCheckpoints();
    state.traceOffsets = checkpoints.traceOffsets ?? {};
    const saved = checkpoints.scheduler ?? {};
    state.scheduler = {
      day: typeof saved.day === 'string' ? saved.day : dayKey(now()),
      calls: Number.isFinite(saved.calls) ? saved.calls : 0,
      tokens: Number.isFinite(saved.tokens) ? saved.tokens : 0,
      batches: Number.isFinite(saved.batches) ? saved.batches : 0,
      pendingTurns: Number.isFinite(saved.pendingTurns) ? saved.pendingTurns : 0,
      lastBatchAt: Number.isFinite(saved.lastBatchAt) ? saved.lastBatchAt : 0,
      lastTickAt: Number.isFinite(saved.lastTickAt) ? saved.lastTickAt : 0,
      lastPruneAt: Number.isFinite(saved.lastPruneAt) ? saved.lastPruneAt : 0,
      lastError: typeof saved.lastError === 'string' ? saved.lastError : null,
    };
    ensureDay();
  }

  function ensureDay() {
    const today = dayKey(now());
    if (state.scheduler.day !== today) {
      state.scheduler.day = today;
      state.scheduler.calls = 0;
      state.scheduler.tokens = 0;
      state.scheduler.batches = 0;
    }
  }

  function persist() {
    try {
      const checkpoints = store.loadCheckpoints();
      checkpoints.traceOffsets = state.traceOffsets;
      checkpoints.scheduler = state.scheduler;
      store.saveCheckpoints(checkpoints);
    } catch (error) {
      logger.warn('CHECKPOINT_SAVE_FAILED', { code: error?.code ?? 'UNKNOWN' });
    }
  }

  function busyCount() {
    const timestamp = now();
    for (const [sessionId, startedAt] of state.busy) {
      if (timestamp - startedAt > BUSY_STALE_MS) state.busy.delete(sessionId);
    }
    return state.busy.size;
  }

  function observeTurn(session, turn, event) {
    if (typeof session?.id !== 'string' || session.id === '') return null;
    const text = collectTurnText(session, turn);
    if (text.trim() === '') return null;
    if (countTurnToolCalls(session, turn) === 0) return null;
    const evidence = {
      id: `EV-OBS-${shortHash(`${session.id}|${turn}`).slice(0, 8)}`,
      seq: Number.isInteger(event?.seq) ? event.seq : null,
      turn,
      kind: 'observation',
      quote: truncate(text, 200),
      digest: shortHash(text),
      trust: 'medium',
      supports: 'recurrence observation',
      createdAt: now(),
    };
    let outcome = null;
    let activation = { activated: [] };
    store.update((draft) => {
      outcome = observeDraft(draft, { sessionId: session.id, turn, text, valid: true, evidence }, config, now());
      sweepObservationsDraft(draft, config, now());
      activation = activateReadyDraft(draft, config, now());
      return undefined;
    });
    if (outcome !== null) outcome.activated = activation.activated;
    if (outcome !== null && (
      outcome.recurrences.length > 0 || outcome.promoted.length > 0 ||
      outcome.expired.length > 0 || activation.activated.length > 0
    )) {
      try { syncExperienceFiles(store); } catch { /* 文件失败不影响观察 */ }
    }
    return outcome;
  }

  async function tick(options = {}) {
    const force = options.force === true;
    if (state.running) return { ok: false, skipped: 'RUNNING' };
    ensureDay();
    // 每天最多执行一次 trace 保留期清理（不调用模型）。
    if (now() - state.scheduler.lastPruneAt > 6 * 60 * 60 * 1000) {
      try {
        const pruned = pruneTraces(store, config, now());
        if (pruned.removed > 0) {
          state.traceOffsets = store.loadCheckpoints().traceOffsets ?? state.traceOffsets;
        }
        state.scheduler.lastPruneAt = now();
        persist();
      } catch {
        // 清理失败不影响后续 tick。
      }
    }
    if (config.localOnly === true) return { ok: true, skipped: 'LOCAL_ONLY' };
    if (config.autoLearn !== true) return { ok: true, skipped: 'AUTOLEARN_DISABLED' };
    if (llm === null || typeof llm !== 'object' || typeof llm.stream !== 'function') {
      return { ok: false, skipped: 'LLM_UNAVAILABLE' };
    }
    if (!force && busyCount() > 0) return { ok: false, skipped: 'BUSY' };
    if (state.scheduler.batches >= config.maxBatchesPerDay) return { ok: false, skipped: 'BUDGET_BATCHES' };
    if (state.scheduler.calls >= config.maxExtraCallsPerDay) return { ok: false, skipped: 'BUDGET_CALLS' };
    if (state.scheduler.tokens >= config.dailyLearningTokens) return { ok: false, skipped: 'BUDGET_TOKENS' };
    if (!force && state.scheduler.lastBatchAt > 0 && now() - state.scheduler.lastBatchAt < config.minBatchGapMs) {
      return { ok: false, skipped: 'GAP' };
    }

    state.running = true;
    try {
      // ① 增量 trace → 关联（0 模型）
      const trace = readTraceIncrement(store, { offsets: state.traceOffsets });
      if (trace.records.length > 0) {
        const linked = correlate(trace.records, { now });
        store.update((draft) => {
          mergeCorrelation(draft, linked, now());
          return undefined;
        });
        state.traceOffsets = trace.offsets;
      }
      // ② 观察超期/门禁（0 模型；即使未达阈值也先推进生命周期）
      let activated = [];
      store.update((draft) => {
        sweepObservationsDraft(draft, config, now());
        activated = activateReadyDraft(draft, config, now()).activated;
        return undefined;
      });
      if (activated.length > 0) syncExperienceFiles(store);
      state.scheduler.lastError = null;
      const newTurns = trace.records.filter((record) => record.type === 'turn/end').length;
      state.scheduler.pendingTurns += newTurns;
      if (!force && state.scheduler.pendingTurns < config.batchThresholdTurns) {
        state.scheduler.lastTickAt = now();
        persist();
        return {
          ok: true, calls: 0, skipped: 'BELOW_THRESHOLD',
          ingested: trace.records.length, newTurns, pendingTurns: state.scheduler.pendingTurns, activated,
        };
      }

      // ③ 是否有可整理 Issue（0 模型判断）
      const registry = store.snapshot();
      const attemptIssueIds = new Set((Array.isArray(registry.attempts) ? registry.attempts : []).map((attempt) => attempt?.issueId));
      const eligible = (Array.isArray(registry.issues) ? registry.issues : [])
        .filter((issue) => issue !== null && typeof issue === 'object')
        .filter((issue) => issue.confidence !== 'tentative' && !Number.isFinite(issue.analyzedAt))
        .filter((issue) => attemptIssueIds.has(issue.id))
        .filter((issue) => (Array.isArray(issue.evidenceRefs) ? issue.evidenceRefs.length : 0) > 0);
      if (eligible.length === 0) {
        state.scheduler.lastTickAt = now();
        persist();
        return { ok: true, calls: 0, skipped: 'NO_ELIGIBLE_ISSUES', ingested: trace.records.length, activated };
      }
      // 没有会话路由就不调用模型，避免一次注定失败的 LLM_FINISH_ERROR。
      if (state.route === null && (config.provider === '' || config.model === '')) {
        state.scheduler.lastTickAt = now();
        persist();
        return { ok: true, calls: 0, skipped: 'ROUTE_UNAVAILABLE', ingested: trace.records.length, activated };
      }

      // ④ 单次批量提炼（显式带会话模型路由；否则 ctx.llm.stream 会 finish error）
      const batchConfig = state.route !== null
        ? { ...config, provider: state.route.provider, model: state.route.model }
        : config;
      const summary = await runBatch({ store, llm, config: batchConfig, now: now() });
      state.scheduler.calls += Number.isFinite(summary.calls) ? summary.calls : 0;
      if (Number.isFinite(summary.tokensIn)) state.scheduler.tokens += summary.tokensIn + (summary.tokensOut ?? 0);
      if (summary.calls > 0) {
        state.scheduler.pendingTurns = 0;
        state.scheduler.batches += 1;
      }
      state.scheduler.lastBatchAt = now();
      state.scheduler.lastTickAt = now();
      if (summary.ok !== true) state.scheduler.lastError = summary.error ?? 'BATCH_FAILED';
      else state.scheduler.lastError = null;

      if (Array.isArray(summary.created) && summary.created.length > 0) {
        let started = [];
        store.update((draft) => {
          started = startObservationDraft(draft, summary.batchId, config, now()).started;
          activated = activateReadyDraft(draft, config, now()).activated;
        });
        summary.started = started;
      }
      if ((summary.created?.length ?? 0) > 0 || activated.length > 0) syncExperienceFiles(store);
      summary.activated = activated;
      summary.ingested = trace.records.length;
      state.lastResult = summary;
      persist();
      return summary;
    } catch (error) {
      state.scheduler.lastTickAt = now();
      state.scheduler.lastError = typeof error?.code === 'string' ? error.code : 'TICK_FAILED';
      persist();
      logger.warn('TICK_FAILED', { code: state.scheduler.lastError });
      return { ok: false, error: state.scheduler.lastError };
    } finally {
      state.running = false;
    }
  }

  function handleEvent(session, event) {
    if (session === null || typeof session !== 'object') return;
    const sessionId = typeof session.id === 'string' ? session.id : null;
    if (sessionId === null) return;
    captureRoute(session);
    if (event?.type === 'turn/start') {
      state.busy.set(sessionId, now());
      return;
    }
    if (event?.type !== 'turn/end') return;
    state.busy.delete(sessionId);
    if (event.data?.reason?.kind !== 'completed') return;
    if (isSubagent(session)) return;
    const turn = Number.isInteger(event.data?.turn) ? event.data.turn : null;
    if (turn === null) return;
    try {
      observeTurn(session, turn, event);
    } catch (error) {
      logger.warn('OBSERVE_FAILED', { code: error?.code ?? 'UNKNOWN' });
    }
    // 轻量检查：不强制跳过 45min 间隔，tick 内部会判断。
    void tick().catch(() => {});
  }

  function start() {
    load();
    const interval = Math.max(60_000, config.scheduleIntervalMs);
    state.timer = setInterval(() => {
      void tick().catch(() => {});
    }, interval);
    if (typeof state.timer?.unref === 'function') state.timer.unref();
    const kickoff = setTimeout(() => { void tick().catch(() => {}); }, 2000);
    if (typeof kickoff?.unref === 'function') kickoff.unref();
  }

  function stop() {
    if (state.timer !== null) clearInterval(state.timer);
    state.timer = null;
    persist();
  }

  return {
    start,
    stop,
    tick,
    handleEvent,
    state: () => ({
      busy: state.busy.size,
      scheduler: { ...state.scheduler },
      lastResult: state.lastResult,
    }),
    _collectTurnText: collectTurnText,
  };
}
