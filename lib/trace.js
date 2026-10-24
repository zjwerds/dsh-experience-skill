/**
 * trace.js — 轨迹采集（旁路、白名单、脱敏、缓冲追加）。
 *
 * 只记录复盘需要的最小字段；未知事件类型直接忽略（DSH 新版本可能加事件）。
 * 不调用模型；写盘失败只影响本批 trace，不影响会话。
 */
import { messageText, redact, truncate } from './text.js';

export const CAPTURE_TYPES = Object.freeze(new Set([
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'job/registered',
  'job/settled',
]));

/**
 * 把 session 事件压成 trace 记录；不需要的事件返回 null。
 * @param {object} event
 * @param {(offsetMs?: number) => number} now
 */
export function toTraceRecord(event, now = Date.now) {
  if (event === null || typeof event !== 'object' || !CAPTURE_TYPES.has(event.type)) return null;
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
  const record = {
    type: event.type,
    seq: Number.isInteger(event.seq) ? event.seq : null,
    ts: Number.isFinite(event.time) ? event.time : now(),
    turn: Number.isInteger(data.turn) ? data.turn : null,
    step: Number.isInteger(data.step) ? data.step : null,
  };

  if (event.type === 'user/message') {
    record.text = redact(messageText(data.content), 500);
  } else if (event.type === 'assistant/message') {
    record.text = redact(messageText(data.message?.content), 300);
  } else if (event.type === 'tool/call') {
    record.tool = typeof data.name === 'string' ? data.name : null;
    record.callId = typeof data.callId === 'string' ? data.callId : null;
    record.args = redact(typeof data.arguments === 'string' ? data.arguments : '', 200);
  } else if (event.type === 'tool/result') {
    const message = data.message !== null && typeof data.message === 'object' ? data.message : {};
    record.callId = typeof message.toolCallId === 'string'
      ? message.toolCallId
      : (typeof message.source?.callId === 'string' ? message.source.callId : null);
    record.isError = message.isError === true || data.isError === true;
    record.text = redact(messageText(message.content), 300);
  } else if (event.type === 'turn/end') {
    record.reason = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown';
  } else if (event.type === 'job/registered' || event.type === 'job/settled') {
    record.jobId = typeof data.jobId === 'string' ? data.jobId : null;
    record.kind = typeof data.kind === 'string' ? data.kind : null;
    record.status = typeof data.status === 'string' ? data.status : null;
  } else if (event.type === 'turn/start') {
    record.turn = Number.isInteger(data.turn) ? data.turn : record.turn;
  }
  return record;
}

/**
 * 缓冲写入器：按 session 聚合，turn/end 立即 flush，其余 300ms 防抖。
 * @param {import('./store.js').Store} store
 * @param {{flushMs?: number, logger?: object, config?: object}} [options]
 */
export function createTraceWriter(store, options = {}) {
  const flushMs = Number.isInteger(options.flushMs) ? options.flushMs : 300;
  const logger = options.logger ?? { warn: () => {} };
  const config = options.config ?? {};
  /** @type {Map<string, {lines: string[], timer: any, lastSeq: number}>} */
  const buffers = new Map();

  function isSubagent(session) {
    const header = session?.header;
    if (header === null || typeof header !== 'object') return false;
    if (header.origin === 'subagent') return true;
    return Number(header.delegationDepth ?? 0) > 0;
  }

  function flush(sessionId) {
    const buffer = buffers.get(sessionId);
    if (buffer === undefined || buffer.lines.length === 0) return;
    try {
      store.appendJsonlMany(store.tracePathFor(sessionId), buffer.lines);
      buffer.lines = [];
    } catch {
      logger.warn('TRACE_WRITE_FAILED', { code: 'WRITE' });
      buffer.lines = [];
    }
    if (buffer.timer !== null) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
  }

  function schedule(sessionId) {
    const buffer = buffers.get(sessionId);
    if (buffer === undefined || buffer.timer !== null) return;
    buffer.timer = setTimeout(() => {
      buffer.timer = null;
      flush(sessionId);
    }, flushMs);
    if (typeof buffer.timer?.unref === 'function') buffer.timer.unref();
  }

  return {
    /** 记录一个事件；重复 seq 直接跳过。 */
    push(session, event) {
      if (config.captureSubagents !== true && isSubagent(session)) return;
      const sessionId = typeof session?.id === 'string' && session.id !== '' ? session.id : null;
      if (sessionId === null) return;
      let buffer = buffers.get(sessionId);
      if (buffer === undefined) {
        buffer = { lines: [], timer: null, lastSeq: 0 };
        buffers.set(sessionId, buffer);
      }
      const seq = Number.isInteger(event?.seq) ? event.seq : null;
      if (seq !== null && seq <= buffer.lastSeq) return;
      if (seq !== null) buffer.lastSeq = seq;
      const record = toTraceRecord(event);
      if (record === null) return;
      record.sessionId = sessionId;
      buffer.lines.push(JSON.stringify(record));
      if (event.type === 'turn/end') flush(sessionId);
      else schedule(sessionId);
    },
    flushAll() {
      for (const sessionId of buffers.keys()) flush(sessionId);
    },
    stats() {
      let pending = 0;
      for (const buffer of buffers.values()) pending += buffer.lines.length;
      return { sessions: buffers.size, pending };
    },
  };
}
