import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.js';
import { correlate } from '../lib/correlate.js';
import { createScheduler } from '../lib/scheduler.js';
import { readTraceIncrement } from '../lib/trace-reader.js';
import { resolveConfig } from '../lib/config.js';

const NOW = 1_800_000_000_000;
let seq = 0;

function rec(turn, type, data = {}) {
  seq += 1;
  return { sessionId: 'session-a', turn, type, seq, ts: NOW + seq, ...data };
}

function traceRecords() {
  seq = 0;
  return [
    rec(1, 'user/message', { text: '修复 MCP 连接失败' }),
    rec(1, 'tool/call', { callId: 'c1', tool: 'pwsh', args: 'python mcp_client.py' }),
    rec(1, 'tool/result', { callId: 'c1', isError: true, text: 'ECONNREFUSED 127.0.0.1:8765' }),
    rec(1, 'turn/end', { reason: 'completed' }),
  ];
}

function seedTraceFile(store) {
  const records = traceRecords();
  store.appendJsonlMany(store.tracePathFor('session-a', NOW), records.map((item) => JSON.stringify(item)));
  return records;
}

function candidateFor(issue) {
  return {
    issueId: issue.id,
    name: 'MCP 连接排查',
    problemTypes: ['network'],
    triggerTerms: ['ECONNREFUSED'],
    symptomTerms: ['连接失败'],
    aliases: [],
    errorSignatures: ['econnrefused'],
    technologyTerms: ['MCP'],
    stageTerms: ['debug'],
    actionTerms: ['locate_root_cause'],
    requiredConditions: [{ kind: 'technology', anyOf: ['MCP'] }],
    avoidWhen: [],
    strategy: '先确认 MCP 进程与端口，再重启并健康检查。',
    risks: [],
    evidenceRefs: [issue.evidenceRefs[0]],
    evaluation: { result: 4, method: 4, evidence: 4, transfer: 3, efficiency: 3, risk: 1, verdict: 'EFFECTIVE' },
    confidence: 'medium',
    riskLevel: 'low',
  };
}

function llmFor(issue) {
  const text = JSON.stringify({ candidates: [candidateFor(issue)] });
  return {
    stream() {
      return (async function* generate() {
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 500, outputTokens: 100 } };
      })();
    },
  };
}

function tempStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'exp-skill-scheduler-'));
  const store = new Store({ dataDir });
  store.init();
  return { dataDir, store };
}

test('tick：增量 trace → 关联 → 1 次批量 → candidate→observing', async () => {
  const { dataDir, store } = tempStore();
  const records = seedTraceFile(store);
  const issue = correlate(records, { now: () => NOW }).issues[0];
  const scheduler = createScheduler({ store, llm: llmFor(issue), config: resolveConfig({ dataDir, provider: 'test', model: 'test' }), now: () => NOW });

  const summary = await scheduler.tick({ force: true });
  assert.equal(summary.ok, true, JSON.stringify(summary));
  assert.equal(summary.calls, 1, JSON.stringify(summary));
  assert.equal(summary.created.length, 1);
  const experience = store.snapshot().experiences[0];
  assert.equal(experience.status, 'observing');
  assert.equal(store.snapshot().issues[0].analyzedAt, NOW);

  const second = await scheduler.tick({ force: true });
  assert.equal(second.calls, 0);
  assert.equal(second.skipped, 'NO_ELIGIBLE_ISSUES');
});

test('路由：从 session.requestHeader 捕获 provider/model 并传给 llm.stream', async () => {
  const { dataDir, store } = tempStore();
  const records = seedTraceFile(store);
  const issue = correlate(records, { now: () => NOW }).issues[0];
  let seen = null;
  const inner = llmFor(issue);
  const llm = {
    stream(options) {
      seen = options;
      return inner.stream();
    },
  };
  const scheduler = createScheduler({ store, llm, config: resolveConfig({ dataDir }), now: () => NOW });
  scheduler.handleEvent(
    { id: 's-route', requestHeader: () => ({ config: { provider: 'deepseek-official', model: 'deepseek-flash' } }) },
    { type: 'turn/start', data: { turn: 1 } },
  );
  const summary = await scheduler.tick({ force: true });
  assert.equal(summary.calls, 1, JSON.stringify(summary));
  assert.equal(seen.provider, 'deepseek-official');
  assert.equal(seen.model, 'deepseek-flash');
});

test('没有路由也没有 config provider/model：跳过批量，不调用模型', async () => {
  const { dataDir, store } = tempStore();
  seedTraceFile(store);
  let calls = 0;
  const scheduler = createScheduler({
    store,
    llm: { stream() { calls += 1; return (async function* generate() { yield { type: 'text-delta', text: '{}' }; })(); } },
    config: resolveConfig({ dataDir }),
    now: () => NOW,
  });
  const summary = await scheduler.tick({ force: true });
  assert.equal(summary.skipped, 'ROUTE_UNAVAILABLE');
  assert.equal(calls, 0);
});

test('未达批次阈值：非 force tick 返回 BELOW_THRESHOLD，不调用模型', async () => {
  const { dataDir, store } = tempStore();
  seedTraceFile(store);
  let calls = 0;
  const scheduler = createScheduler({
    store,
    llm: { stream() { calls += 1; return (async function* generate() { yield { type: 'text-delta', text: '{}' }; })(); } },
    config: resolveConfig({ dataDir, batchThresholdTurns: 8 }),
    now: () => NOW,
  });
  const summary = await scheduler.tick();
  assert.equal(summary.skipped, 'BELOW_THRESHOLD');
  assert.equal(calls, 0);
});

test('批次上限：maxBatchesPerDay=0 时不调用模型', async () => {
  const { dataDir, store } = tempStore();
  seedTraceFile(store);
  let calls = 0;
  const scheduler = createScheduler({
    store,
    llm: { stream() { calls += 1; return (async function* generate() { yield { type: 'text-delta', text: '{}' }; })(); } },
    config: resolveConfig({ dataDir, provider: 'test', model: 'test', maxBatchesPerDay: 0 }),
    now: () => NOW,
  });
  const summary = await scheduler.tick({ force: true });
  assert.equal(summary.skipped, 'BUDGET_BATCHES');
  assert.equal(calls, 0);
});

test('预算耗尽：tick 直接返回 BUDGET_CALLS，不读 trace、不调用模型', async () => {
  const { dataDir, store } = tempStore();
  const records = seedTraceFile(store);
  const issue = correlate(records).issues[0];
  let calls = 0;
  const llm = { stream() { calls += 1; return llmFor(issue).stream(); } };
  const scheduler = createScheduler({
    store, llm, config: resolveConfig({ dataDir, maxExtraCallsPerDay: 0 }), now: () => NOW,
  });
  const summary = await scheduler.tick({ force: true });
  assert.equal(summary.skipped, 'BUDGET_CALLS');
  assert.equal(calls, 0);
});

test('前台忙：非 force tick 返回 BUSY', async () => {
  const { dataDir, store } = tempStore();
  const scheduler = createScheduler({ store, llm: llmFor({ id: 'ISS-x', evidenceRefs: [] }), config: resolveConfig({ dataDir }), now: () => NOW });
  scheduler.handleEvent({ id: 's1', header: { origin: 'user' } }, { type: 'turn/start', data: { turn: 1 } });
  const summary = await scheduler.tick();
  assert.equal(summary.skipped, 'BUSY');
});

test('回合结束观察：命中再现 → cleanRounds 归零、追加证据', () => {
  const { dataDir, store } = tempStore();
  const experience = {
    id: 'EXP-1', issueId: 'ISS-1', status: 'observing', name: 'MCP 连接排查',
    triggerTerms: ['ECONNREFUSED'], symptomTerms: ['连接失败'], errorSignatures: ['econnrefused'],
    technologyTerms: ['MCP'], evidenceRefs: ['EV-1', 'EV-2'], evaluation: { method: 4, verdict: 'EFFECTIVE' },
    confidence: 'medium', riskLevel: 'low', flags: [], conflictsWith: [], stats: { harmful: 0 },
    observation: {
      validRounds: 0, cleanRounds: 1, requiredCleanRounds: 2,
      firstSeenAt: NOW, deadlineAt: NOW + 86400000, resetCount: 0,
    },
  };
  store.update((draft) => { draft.experiences.push(experience); });

  const session = {
    id: 's1',
    header: { origin: 'user' },
    snapshotEvents: () => [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '又出现 ECONNREFUSED，连接失败' }] } },
      { type: 'tool/call', data: { turn: 1, callId: 'c1', name: 'pwsh', arguments: 'python mcp_client.py' } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  };
  const scheduler = createScheduler({ store, llm: llmFor({ id: 'ISS-1', evidenceRefs: [] }), config: resolveConfig({ dataDir }), now: () => NOW });
  scheduler.handleEvent(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 3 });

  const item = store.snapshot().experiences[0];
  assert.equal(item.observation.cleanRounds, 0);
  assert.equal(item.observation.resetCount, 1);
  assert.ok(item.evidenceRefs.length > 2);
});

test('trace-reader：偏移增量读取，重复读不重复返回', () => {
  const { store } = tempStore();
  seedTraceFile(store);
  const first = readTraceIncrement(store, { offsets: {} });
  assert.equal(first.records.length, 4);
  const second = readTraceIncrement(store, { offsets: first.offsets });
  assert.equal(second.records.length, 0);

  store.appendJsonlMany(store.tracePathFor('session-a', NOW), [JSON.stringify({ sessionId: 'session-a', seq: 99, type: 'turn/start', turn: 2, ts: NOW })]);
  const third = readTraceIncrement(store, { offsets: first.offsets });
  assert.equal(third.records.length, 1);
  assert.equal(third.records[0].seq, 99);
});
