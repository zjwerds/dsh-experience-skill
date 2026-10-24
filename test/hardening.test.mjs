import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.js';
import { resolveConfig } from '../lib/config.js';
import { createTraceWriter } from '../lib/trace.js';
import { pruneTraces } from '../lib/retention.js';
import { createScheduler } from '../lib/scheduler.js';
import { createExperienceSearchTool } from '../lib/tools.js';

function tempStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'exp-skill-hard-'));
  const store = new Store({ dataDir });
  store.init();
  return { dataDir, store };
}

function activeExperience(overrides = {}) {
  return {
    id: 'EXP-1',
    name: 'MCP 排查',
    status: 'active',
    version: 1,
    problemTypes: ['tool_call_failure'],
    triggerTerms: ['ECONNREFUSED'],
    symptomTerms: ['连接失败'],
    errorSignatures: ['econnrefused'],
    technologyTerms: ['MCP'],
    requiredConditions: [],
    avoidWhen: [],
    strategy: '先查端口再重启。',
    risks: [],
    evidenceRefs: ['EV-1', 'EV-2'],
    confidence: 'medium',
    riskLevel: 'low',
    flags: [],
    stats: { retrieved: 0, adopted: 0, improved: 0, neutral: 0, harmful: 0, falsePositive: 0 },
    ...overrides,
  };
}

test('检索日预算：次数用尽拒绝；token 不足只给 1 条', () => {
  const { dataDir, store } = tempStore();
  const countCfg = resolveConfig({ dataDir, maxRetrievalsPerDay: 1 });
  assert.equal(store.reserveRetrieval(countCfg, 100).allowed, true);
  assert.equal(store.reserveRetrieval(countCfg, 100).allowed, false);

  const { store: store2 } = tempStore();
  const tokenCfg = resolveConfig({ dataDir: store2.dataDir, maxRetrievalsPerDay: 8, dailyRetrievalTokens: 1000 });
  assert.equal(store2.reserveRetrieval(tokenCfg, 900).allowed, true);
  const limited = store2.reserveRetrieval(tokenCfg, 200);
  assert.equal(limited.allowed, true);
  assert.equal(limited.limit, 1);
  assert.equal(limited.reason, 'TOKENS');
});

test('检索命中后 stats.retrieved / lastUsedAt 更新', () => {
  const { store } = tempStore();
  store.update((draft) => { draft.experiences.push(activeExperience()); });
  const now = 1_800_000_000_000;
  assert.equal(store.recordRetrievalStats(['EXP-1'], now), true);
  const item = store.snapshot().experiences[0];
  assert.equal(item.stats.retrieved, 1);
  assert.equal(item.lastUsedAt, now);
});

test('负反馈累计：active → pending_review + needs_review；note 脱敏', () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(activeExperience()); });
  for (let i = 0; i < 3; i++) {
    store.recordFeedback({
      retrievalId: 'RET-1',
      used: ['EXP-1'],
      outcome: 'harmful',
      resultSignal: 'user',
      note: 'token sk-abcdefghijklmnopqrstuvwx',
    });
  }
  const item = store.snapshot().experiences[0];
  assert.equal(item.stats.harmful, 3);
  assert.equal(item.status, 'pending_review');
  assert.ok(item.flags.includes('needs_review'));
  const log = readFileSync(join(dataDir, 'logs', 'feedback.jsonl'), 'utf8');
  assert.equal(log.includes('sk-abcdefghijklmnopqrstuvwx'), false);
  assert.match(log, /redacted/);
});

test('trace 保留期清理：旧文件删除并移除 offsets', () => {
  const { dataDir, store } = tempStore();
  const old = Date.now() - 5 * 86400000;
  const rel = store.tracePathFor('session-old', old);
  store.appendJsonlMany(rel, [JSON.stringify({ sessionId: 'session-old', type: 'turn/end' })]);
  const checkpoints = store.loadCheckpoints();
  checkpoints.traceOffsets[rel] = 42;
  store.saveCheckpoints(checkpoints);
  const file = join(dataDir, rel);
  const oldSec = Math.floor(old / 1000);
  utimesSync(file, oldSec, oldSec);

  const result = pruneTraces(store, resolveConfig({ retentionTraceDays: 1 }), Date.now());
  assert.equal(result.removed, 1);
  assert.equal(existsSync(file), false);
  assert.equal(store.loadCheckpoints().traceOffsets[rel], undefined);
});

test('subagent 默认不采集 trace', () => {
  const { dataDir, store } = tempStore();
  const config = resolveConfig({ captureSubagents: false });
  const writer = createTraceWriter(store, { config, flushMs: 1 });
  writer.push({ id: 'sub', header: { origin: 'subagent' } }, {
    type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } },
  });
  writer.push({ id: 'main' }, {
    type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } },
  });
  writer.flushAll();
  assert.equal(existsSync(join(dataDir, 'traces')), true);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.trace.jsonl')) files.push(full);
    }
  };
  walk(join(dataDir, 'traces'));
  assert.equal(files.length, 1);
  assert.match(files[0], /main/);
});

test('autoLearn=false：tick 不调用模型', async () => {
  const { dataDir, store } = tempStore();
  let calls = 0;
  const scheduler = createScheduler({
    store,
    llm: { stream() { calls += 1; throw new Error('SHOULD_NOT_CALL'); } },
    config: resolveConfig({ dataDir, autoLearn: false }),
    now: () => Date.now(),
  });
  const summary = await scheduler.tick({ force: true });
  assert.equal(summary.skipped, 'AUTOLEARN_DISABLED');
  assert.equal(calls, 0);
});

test('检索日志中的 error_text 脱敏', async () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(activeExperience()); });
  const config = resolveConfig({ dataDir });
  const tool = createExperienceSearchTool(store, config);
  const payload = await tool.execute({
    error_text: 'auth sk-abcdefghijklmnopqrstuvwx failed',
    problem_type: 'tool_call_failure',
  }, {});
  assert.equal(typeof payload.no_match, 'boolean');
  const log = readFileSync(join(dataDir, 'logs', 'retrieval.jsonl'), 'utf8');
  assert.equal(log.includes('sk-abcdefghijklmnopqrstuvwx'), false);
});
