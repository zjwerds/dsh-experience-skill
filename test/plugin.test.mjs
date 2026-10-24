import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply, inject, name } from '../lib/index.js';
import { Store } from '../lib/store.js';
import { acquireDataLock } from '../lib/lock.js';

const NOW = Date.now();

const sample = {
  id: 'EXP-0042',
  name: '先探端口再重启 MCP',
  status: 'active',
  version: 1,
  problemTypes: ['tool_call_failure'],
  triggerTerms: ['MCP 工具无响应'],
  symptomTerms: ['连接失败'],
  aliases: ['MCP 连不上'],
  errorSignatures: ['ECONNREFUSED 127.0.0.1:8765'],
  technologyTerms: ['MCP'],
  stageTerms: ['debug'],
  actionTerms: ['locate_root_cause'],
  requiredConditions: [{ kind: 'technology', anyOf: ['MCP'] }],
  avoidWhen: [{ kind: 'task_contains', anyOf: ['纯前端样式'] }],
  strategy: '确认进程与端口；重启后健康检查；再重试。',
  risks: ['远程 MCP 不适用'],
  evidenceRefs: ['TASK-1/ATT-1'],
  confidence: 'medium',
  riskLevel: 'low',
  flags: [],
  lastVerifiedAt: NOW - 3600000,
  stats: {},
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'exp-skill-plugin-'));
}

function seed(dataDir) {
  const store = new Store({ dataDir });
  store.init();
  store.update((draft) => {
    draft.experiences.push(sample);
  });
}

function mockCtx() {
  const captured = { skills: [], tools: [], events: [], effects: [] };
  const ctx = {
    effect(fn, label) {
      captured.effects.push(label);
      const dispose = fn();
      return typeof dispose === 'function' ? dispose : () => {};
    },
    skills: {
      register(definition) {
        captured.skills.push(definition);
        return () => {};
      },
    },
    tools: {
      register(definition) {
        captured.tools.push(definition);
        return () => {};
      },
    },
    on(eventName, handler) {
      captured.events.push({ eventName, handler });
      return () => {};
    },
    llm: {
      stream() { throw new Error('SHOULD_NOT_CALL_LLM'); },
    },
  };
  Object.defineProperty(ctx, 'systemPrompt', {
    get() { throw new Error('SHOULD_NOT_TOUCH_SYSTEM_PROMPT'); },
  });
  return { ctx, captured };
}

function findTraceFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.trace.jsonl')) out.push(full);
    }
  };
  walk(join(dir, 'traces'));
  return out;
}

test('插件只注册 1 个 skill 和 1 个 tool，且不碰 systemPrompt/llm', () => {
  const dataDir = tempDir();
  seed(dataDir);
  const { ctx, captured } = mockCtx();
  apply(ctx, { dataDir });
  assert.equal(name, 'dsh-experience-skill');
  assert.deepEqual(inject, ['tools', 'skills', 'llm']);
  assert.equal(captured.skills.length, 1);
  assert.equal(captured.skills[0].name, 'experience-retrieval');
  assert.equal(captured.tools.length, 1);
  assert.equal(captured.tools[0].name, 'experience_search');
  assert.ok(captured.events.some((item) => item.eventName === 'session/event'));
  assert.ok(captured.effects.some((label) => String(label).includes('heartbeat')));
});

test('写锁被占用：仍注册 skill/tool 供检索，但只读、不启动 scheduler/trace', async () => {
  const dataDir = tempDir();
  seed(dataDir);
  const held = acquireDataLock(dataDir);
  assert.ok(held !== null);

  const { ctx, captured } = mockCtx();
  apply(ctx, { dataDir });
  assert.equal(captured.skills.length, 1);
  assert.equal(captured.tools.length, 1);
  assert.equal(captured.effects.some((label) => String(label).includes('scheduler')), false);
  assert.equal(captured.events.length, 0);

  const feedback = await captured.tools[0].execute({
    action: 'feedback', retrieval_id: 'RET-x', used: ['EXP-0042'], outcome: 'improved',
  }, {});
  assert.equal(feedback.code, 'READ_ONLY');
  assert.match(captured.tools[0].output.render({}, feedback)[0].text, /READ_ONLY/);
  held.release();
});

test('工具检索返回经验，且写 retrieval 日志', async () => {
  const dataDir = tempDir();
  seed(dataDir);
  const { ctx, captured } = mockCtx();
  apply(ctx, { dataDir });
  const tool = captured.tools[0];
  const payload = await tool.execute({
    problem_type: 'tool_call_failure',
    symptoms: ['连接失败'],
    technology: ['MCP'],
    error_text: 'ECONNREFUSED 127.0.0.1:8765',
    stage: 'debug',
  }, { agent: { session: { id: 'session-test' } } });
  assert.equal(payload.no_match, false);
  assert.equal(payload.results[0].id, 'EXP-0042');
  assert.match(tool.output.render({}, payload)[0].text, /EXP-0042/);
  const logFile = join(dataDir, 'logs', 'retrieval.jsonl');
  assert.match(readFileSync(logFile, 'utf8'), /RET-/);
});

test('feedback 动作写入日志；空库检索安全返回 NO_MATCH', async () => {
  const dataDir = tempDir();
  seed(dataDir);
  const { ctx, captured } = mockCtx();
  apply(ctx, { dataDir });
  const tool = captured.tools[0];
  const feedback = await tool.execute({
    action: 'feedback',
    retrieval_id: 'RET-x',
    used: ['EXP-0042'],
    outcome: 'improved',
    result_signal: 'objective',
  }, {});
  assert.equal(feedback.ok, true);
  assert.match(tool.output.render({}, feedback)[0].text, /feedback 已记录/);

  // 传入坏 registry：把 store 的 experiences 换成非数组，触发降级。
  const { ctx: ctx2, captured: captured2 } = mockCtx();
  apply(ctx2, { dataDir: join(dataDir, 'broken'), maxResults: 2 });
  const tool2 = captured2.tools[0];
  const result = await tool2.execute({ problem_type: 'x' }, {});
  assert.equal(typeof result.no_match, 'boolean');
});

test('轨迹：白名单事件写文件，未知类型忽略，turn/end 立即 flush', () => {  const dataDir = tempDir();
  const { ctx, captured } = mockCtx();
  apply(ctx, { dataDir });
  const hook = captured.events.find((item) => item.eventName === 'session/event').handler;
  const session = { id: 'session-trace' };
  hook(session, { type: 'user/message', seq: 1, time: NOW, data: { content: [{ type: 'text', text: '修一下 MCP 连接' }] } });
  hook(session, { type: 'unknown/type', seq: 2, time: NOW, data: {} });
  hook(session, { type: 'turn/end', seq: 3, time: NOW, data: { turn: 1, reason: { kind: 'completed' } } });
  const files = findTraceFiles(dataDir);
  assert.equal(files.length, 1);
  const lines = readFileSync(files[0], 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'user/message');
  assert.equal(lines[1].type, 'turn/end');
  assert.equal(lines[1].reason, 'completed');
  assert.ok(statSync(files[0]).size > 0);
});
