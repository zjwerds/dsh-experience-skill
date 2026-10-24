/**
 * correlate.js — 轨迹 → Task / Issue / Attempt / Evidence（0 模型调用）。
 *
 * 输入：trace 记录数组（来自 trace.js 的 JSONL，或测试 fixture）。
 * 输出：可确定性复现的关联结果；同签名跨会话合并到同一 Issue。
 *
 * 规则（见设计 B.6）：
 *  - 以 turn 为单位解析，失败工具结果/问题型用户消息作为 Issue 种子；
 *  - signature + 工具 + 文件 basename 生成稳定 issueKey；
 *  - 同一 Issue 在一个 turn 内只产生 1 个 Attempt（多轮 = 多 Attempt）；
 *  - 每条失败/成功结果都生成 Evidence，保留 seq 引用；
 *  - 无明确签名时 confidence=tentative，不进入候选。
 */
import { normalizeText, redact, shortHash, truncate } from './text.js';

const USER_PROBLEM_CUE = /(失败|报错|异常|错误|无法|不能|不生效|超时|崩溃|卡住|卡死|没反应|error|fail|failed|exception|timeout|refused|broken)/i;
const SUCCESS_CUE = /(passed|pass\b|all tests? pass|0 failed|success|succeeded|\bok\b|\bdone\b|http\/?[12]\d{2}|exit code 0|好了|可以了|成功|没问题|解决了)/i;
const ERROR_SIGNATURE_PATTERNS = [
  /\b(econnrefused|econnreset|etimedout|enotfound|eai_again|enoent|eacces|eperm|eaddrinuse|ebusy|emfile)\b/i,
  /\b(column|table|relation) [\w."']{1,40} does not exist\b/i,
  /\b([a-z][a-z0-9_]*error)\b/i,
  /\b([a-z]+exception)\b/i,
  /\bexit code ([1-9]\d*)\b/i,
  /\bhttp[/ ]?([45]\d{2})\b/i,
];

const TECHNOLOGY_VOCAB = ['MCP', 'Python', 'Java', 'Node', 'TypeScript', 'Git', 'SQLite', 'PostgreSQL', 'MySQL', 'Docker', 'pytest', 'Redis', 'Alembic', 'Windows', 'Linux', 'macOS'];

/** 从文本抽错误签名（归一化后的短标识）。 */
export function extractSignature(text) {
  const value = normalizeText(text);
  if (value === '') return '';
  for (const [index, pattern] of ERROR_SIGNATURE_PATTERNS.entries()) {
    const match = value.match(pattern);
    if (match === null) continue;
    if (index === 1) return match[0].slice(0, 80);
    if (index === 4) return `exit code ${match[1]}`.slice(0, 80);
    if (index === 5) return `http ${match[1]}`.slice(0, 80);
    const raw = match[1] ?? match[0];
    return String(raw).replace(/\b\d{2,5}\b/g, '<n>').slice(0, 80);
  }
  return '';
}

/** 根据签名/文本判断问题类型（受控枚举）。 */
export function classifyProblem(signature, text) {
  const both = `${signature} ${normalizeText(text)}`;
  if (/\b(econnrefused|econnreset|etimedout|enotfound|eai_again|timeout|refused)\b/.test(both)) return 'network';
  if (/\b(eacces|eperm)\b/.test(both)) return 'permission';
  if (/(migration|schema|column .*does not exist|alembic|字段.*不存在|迁移)/i.test(both)) return 'db_migration';
  if (/(test.*fail|failing tests?|断言失败|测试失败)/i.test(both)) return 'test';
  if (/\bexit code [1-9]\d*\b/.test(both)) return 'build';
  if (/\benoent\b/.test(both)) return 'tool_call_failure';
  return 'tool_call_failure';
}

function detectTechnology(text) {
  const value = normalizeText(text);
  return TECHNOLOGY_VOCAB.filter((tech) => value.includes(normalizeText(tech))).slice(0, 6);
}

function extractFile(args) {
  if (typeof args !== 'string') return null;
  const match = args.match(/[\w./\\-]+\.(?:py|ts|tsx|js|jsx|json|ya?ml|md|sql|toml|ini)/i);
  if (match === null) return null;
  return match[0].split(/[\\/]/).pop().slice(0, 80);
}

function groupByTurn(records) {
  const groups = new Map();
  for (const record of records) {
    const turn = Number.isInteger(record.turn) ? record.turn : 0;
    if (!groups.has(turn)) groups.set(turn, []);
    groups.get(turn).push(record);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}

function textOf(record) {
  return record !== null && typeof record === 'object' && typeof record.text === 'string' ? record.text : '';
}

function collectTurn(records) {
  const users = [];
  const assistants = [];
  const calls = new Map();
  const results = [];
  let endReason = null;
  let startedAt = null;
  let endedAt = null;
  for (const record of records) {
    if (Number.isFinite(record.ts)) {
      startedAt = startedAt === null ? record.ts : Math.min(startedAt, record.ts);
      endedAt = endedAt === null ? record.ts : Math.max(endedAt, record.ts);
    }
    if (record.type === 'user/message') users.push(textOf(record));
    else if (record.type === 'assistant/message') assistants.push(textOf(record));
    else if (record.type === 'tool/call') calls.set(record.callId ?? `call-${record.seq}`, record);
    else if (record.type === 'tool/result') results.push(record);
    else if (record.type === 'turn/end') endReason = record.reason ?? 'unknown';
  }
  return { users, assistants, calls, results, endReason, startedAt, endedAt };
}

function isSuccessText(record) {
  if (record.isError === true) return false;
  return SUCCESS_CUE.test(textOf(record));
}

function buildAttempt({ issueKey, issueId, attemptIndex, turn, sessionId, parsed }) {
  const failed = parsed.results.filter((result) => result.isError === true);
  const successes = parsed.results.filter((result) => isSuccessText(result));
  const actions = [];
  for (const call of parsed.calls.values()) {
    actions.push({
      seq: Number.isInteger(call.seq) ? call.seq : null,
      tool: typeof call.tool === 'string' ? call.tool : null,
      action: truncate(redact(typeof call.args === 'string' ? call.args : '', 120), 120),
    });
  }
  const signals = [];
  for (const result of failed) {
    signals.push({ kind: 'tool_error', seq: result.seq ?? null, value: extractSignature(textOf(result)) || truncate(textOf(result), 80) });
  }
  for (const result of successes) {
    signals.push({ kind: 'success', seq: result.seq ?? null, value: truncate(textOf(result), 80) });
  }
  const lastFailure = failed.reduce((max, item) => Math.max(max, Number.isInteger(item.seq) ? item.seq : -1), -1);
  const successAfterFailure = successes.some((item) => !Number.isInteger(item.seq) || item.seq > lastFailure);
  let result = 'unknown';
  if (successAfterFailure) result = failed.length > 0 ? 'partial' : 'success';
  else if (failed.length > 0) result = 'failed';

  const hypothesis = parsed.assistants.length > 0
    ? truncate(redact(parsed.assistants[0], 120), 120)
    : '';

  const pairs = actions.map((action) => `${action.tool}|${action.action}`);
  const repeatCalls = pairs.length - new Set(pairs).size;

  const seqs = actions.map((action) => action.seq).filter((seq) => Number.isInteger(seq));
  const minSeq = seqs.length > 0 ? Math.min(...seqs) : null;
  const maxSeq = seqs.length > 0 ? Math.max(...seqs) : null;

  return {
    id: `ATT-${shortHash(issueKey).slice(0, 8).toUpperCase()}-${attemptIndex}`,
    issueId,
    sessionId,
    turn,
    seqRange: [minSeq, maxSeq],
    hypothesis,
    actions: actions.slice(0, 12),
    result,
    signals: signals.slice(0, 12),
    efficiency: { repeatCalls, durationMs: parsed.startedAt !== null && parsed.endedAt !== null ? parsed.endedAt - parsed.startedAt : null },
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
  };
}

function makeEvidence(issueKey, issueId, attemptId, record, kind, supports) {
  const quote = redact(textOf(record), 300);
  return {
    id: `EV-${shortHash(issueKey).slice(0, 8).toUpperCase()}-${Number.isInteger(record.seq) ? record.seq : shortHash(quote).slice(0, 6)}`,
    issueId,
    attemptId,
    kind,
    seq: Number.isInteger(record.seq) ? record.seq : null,
    turn: Number.isInteger(record.turn) ? record.turn : null,
    quote,
    digest: shortHash(quote),
    trust: kind === 'success' ? 'high' : 'medium',
    supports,
    createdAt: Number.isFinite(record.ts) ? record.ts : Date.now(),
  };
}

/**
 * 主关联函数。
 * @param {object[]} traces
 * @param {{now?: () => number}} [options]
 */
export function correlate(traces, options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const records = (Array.isArray(traces) ? traces : [])
    .filter((item) => item !== null && typeof item === 'object' && typeof item.sessionId === 'string')
    .sort((a, b) => (a.sessionId === b.sessionId ? (a.seq ?? 0) - (b.seq ?? 0) : a.sessionId.localeCompare(b.sessionId)));

  const bySession = new Map();
  for (const record of records) {
    if (!bySession.has(record.sessionId)) bySession.set(record.sessionId, []);
    bySession.get(record.sessionId).push(record);
  }

  const tasks = [];
  const issueMap = new Map();
  const attempts = [];
  const evidence = [];

  for (const [sessionId, sessionRecords] of bySession) {
    const taskId = `TASK-${shortHash(sessionId)}`;
    const firstUser = sessionRecords.find((item) => item.type === 'user/message' && textOf(item).trim() !== '');
    const allTurns = groupByTurn(sessionRecords);
    const task = {
      id: taskId,
      sessionId,
      goal: firstUser ? truncate(redact(textOf(firstUser), 200), 200) : '',
      turns: allTurns.map(([turn]) => turn),
      startedAt: sessionRecords[0]?.ts ?? null,
      endedAt: sessionRecords[sessionRecords.length - 1]?.ts ?? null,
      outcome: { status: 'unknown', signals: [] },
      issues: [],
    };

    let anyFailed = false;
    for (const [turn, turnRecords] of allTurns) {
      const parsed = collectTurn(turnRecords);
      const userText = parsed.users.join('\n');
      const failed = parsed.results.filter((result) => result.isError === true);
      const occurrences = [];

      if (failed.length > 0) {
        const seen = new Set();
        for (const result of failed) {
          const signature = extractSignature(textOf(result));
          const call = [...parsed.calls.values()].find((item) => item.callId !== undefined && item.callId === result.callId)
            ?? [...parsed.calls.values()].find((item) => item.tool !== undefined);
          const problemType = classifyProblem(signature || userText, `${textOf(result)} ${userText}`);
          const file = extractFile(call?.args);
          const key = `${problemType}|${signature || 'unknown'}|${file ?? ''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          occurrences.push({ signature, problemType, file, tool: call?.tool ?? null, userText, failed: result, fallbackText: `${textOf(result)} ${userText}` });
        }
      } else if (USER_PROBLEM_CUE.test(userText)) {
        const signature = extractSignature(userText);
        const problemType = classifyProblem(signature, userText);
        occurrences.push({ signature, problemType, file: null, tool: null, userText, failed: null, fallbackText: userText });
      }

      for (const occurrence of occurrences) {
        const fallback = normalizeText(occurrence.fallbackText);
        if (occurrence.signature === '' && fallback === '') continue;
        const issueKey = occurrence.signature === ''
          ? `${occurrence.problemType}|${shortHash(fallback)}|${occurrence.file ?? ''}`
          : `${occurrence.problemType}|${occurrence.signature}|${occurrence.file ?? ''}`;
        let issue = issueMap.get(issueKey);
        if (issue === undefined) {
          issue = {
            schema: 1,
            id: `ISS-${shortHash(issueKey).slice(0, 10).toUpperCase()}`,
            issueKey,
            taskIds: [],
            sessionIds: [],
            title: truncate(occurrence.userText || `${occurrence.tool ?? 'tool'} ${occurrence.signature}`.trim(), 40),
            problemType: occurrence.problemType,
            signature: occurrence.signature,
            symptoms: [],
            technology: [],
            stage: occurrence.failed ? 'debug' : 'coding',
            status: 'open',
            confidence: occurrence.signature === '' ? 'tentative' : 'correlated',
            attempts: [],
            evidenceRefs: [],
            createdAt: turnRecords[0]?.ts ?? nowFn(),
            updatedAt: turnRecords[0]?.ts ?? nowFn(),
          };
          issueMap.set(issueKey, issue);
        }
        if (!issue.taskIds.includes(taskId)) issue.taskIds.push(taskId);
        if (!issue.sessionIds.includes(sessionId)) issue.sessionIds.push(sessionId);
        const symptom = truncate(redact(textOf(occurrence.failed) || userText, 160), 160);
        if (symptom !== '' && !issue.symptoms.includes(symptom)) issue.symptoms.push(symptom);
        for (const tech of detectTechnology(`${userText} ${textOf(occurrence.failed)}`)) {
          if (!issue.technology.includes(tech)) issue.technology.push(tech);
        }
        if (!task.issues.includes(issue.id)) task.issues.push(issue.id);

        const attemptId = `ATT-${shortHash(issueKey).slice(0, 8).toUpperCase()}-${issue.attempts.length + 1}`;
        const attempt = buildAttempt({ issueKey, issueId: issue.id, attemptIndex: issue.attempts.length + 1, turn, sessionId, parsed });
        attempt.id = attemptId;
        attempts.push(attempt);
        issue.attempts.push(attemptId);

        if (occurrence.failed !== null) {
          const failedEvidence = makeEvidence(issueKey, issue.id, attemptId, occurrence.failed, 'tool_error', `attempt ${attempt.result}`);
          evidence.push(failedEvidence);
          issue.evidenceRefs.push(failedEvidence.id);
        }
        for (const result of parsed.results.filter((item) => isSuccessText(item)).slice(0, 2)) {
          const successEvidence = makeEvidence(issueKey, issue.id, attemptId, result, 'success', 'verification signal');
          evidence.push(successEvidence);
          issue.evidenceRefs.push(successEvidence.id);
        }

        if (attempt.result === 'success' || attempt.result === 'partial') {
          issue.status = 'resolved';
        } else if (attempt.result === 'failed') {
          anyFailed = true;
          if (issue.status === 'resolved') issue.status = 'open';
        }
        issue.updatedAt = turnRecords[turnRecords.length - 1]?.ts ?? issue.updatedAt;
      }
    }

    if (anyFailed) task.outcome.status = 'partial';
    else if (task.issues.length > 0) task.outcome.status = 'success';
    task.outcome.signals = attempts
      .filter((attempt) => attempt.sessionId === sessionId)
      .map((attempt) => ({ kind: attempt.result, id: attempt.id }));
    tasks.push(task);
  }

  // 状态收尾：有成功尝试的 Issue 视为 resolved；无证据的保持 tentative。
  for (const issue of issueMap.values()) {
    if (issue.confidence === 'tentative' && issue.attempts.length > 0) issue.confidence = 'correlated';
    if (issue.evidenceRefs.length === 0 && issue.signature === '') issue.confidence = 'tentative';
  }

  return { tasks, issues: [...issueMap.values()], attempts, evidence };
}

/** 把 trace 记录按 session 分组（供 CLI/测试复用）。 */
export function groupBySession(traces) {
  const map = new Map();
  for (const record of Array.isArray(traces) ? traces : []) {
    if (typeof record?.sessionId !== 'string') continue;
    if (!map.has(record.sessionId)) map.set(record.sessionId, []);
    map.get(record.sessionId).push(record);
  }
  return map;
}

/**
 * 把一次 correlate 的结果并入 registry draft（幂等：按 id/issueKey 去重）。
 * 用于 scheduler 的增量 trace 回填。
 * @param {object} draft
 * @param {{tasks:object[], issues:object[], attempts:object[], evidence:object[]}} linked
 * @param {number} [now]
 */
export function mergeCorrelation(draft, linked, now = Date.now()) {
  if (!Array.isArray(draft.tasks)) draft.tasks = [];
  if (!Array.isArray(draft.issues)) draft.issues = [];
  if (!Array.isArray(draft.attempts)) draft.attempts = [];
  if (!Array.isArray(draft.evidence)) draft.evidence = [];

  const summary = { newIssues: 0, mergedIssues: 0, newAttempts: 0, newEvidence: 0 };

  const taskIds = new Set(draft.tasks.map((item) => item?.id));
  for (const task of linked.tasks ?? []) {
    if (!taskIds.has(task.id)) {
      draft.tasks.push(task);
      taskIds.add(task.id);
    }
  }

  const evidenceIds = new Set(draft.evidence.map((item) => item?.id));
  for (const item of linked.evidence ?? []) {
    if (!evidenceIds.has(item.id)) {
      draft.evidence.push(item);
      evidenceIds.add(item.id);
      summary.newEvidence += 1;
    }
  }

  const attemptIds = new Set(draft.attempts.map((item) => item?.id));
  for (const attempt of linked.attempts ?? []) {
    if (!attemptIds.has(attempt.id)) {
      draft.attempts.push(attempt);
      attemptIds.add(attempt.id);
      summary.newAttempts += 1;
    }
  }

  const issueByKey = new Map(draft.issues.map((item) => [item?.issueKey, item]));
  for (const issue of linked.issues ?? []) {
    const existing = issueByKey.get(issue.issueKey);
    if (existing === undefined) {
      draft.issues.push(issue);
      issueByKey.set(issue.issueKey, issue);
      summary.newIssues += 1;
      continue;
    }
    summary.mergedIssues += 1;
    existing.taskIds = union(existing.taskIds, issue.taskIds);
    existing.sessionIds = union(existing.sessionIds, issue.sessionIds);
    existing.symptoms = union(existing.symptoms, issue.symptoms).slice(0, 8);
    existing.technology = union(existing.technology, issue.technology);
    existing.attempts = union(existing.attempts, issue.attempts);
    existing.evidenceRefs = union(existing.evidenceRefs, issue.evidenceRefs);
    if (issue.status === 'resolved') existing.status = 'resolved';
    if (existing.confidence === 'tentative' && issue.confidence === 'correlated') existing.confidence = 'correlated';
    existing.updatedAt = now;
  }
  return summary;
}

function union(a, b) {
  const out = Array.isArray(a) ? [...a] : [];
  for (const item of Array.isArray(b) ? b : []) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
