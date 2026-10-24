import test from 'node:test';
import assert from 'node:assert/strict';
import { buildQuery, evalCondition, renderResults, retrieve } from '../lib/retrieve.js';
import { resolveConfig } from '../lib/config.js';

const NOW = Date.now();

function entry(overrides = {}) {
  return {
    id: 'EXP-0042',
    name: '先探端口再重启 MCP',
    status: 'active',
    version: 2,
    problemTypes: ['tool_call_failure'],
    triggerTerms: ['MCP 工具无响应'],
    symptomTerms: ['连接失败', 'ECONNREFUSED'],
    aliases: ['MCP 连不上'],
    errorSignatures: ['ECONNREFUSED 127.0.0.1:8765'],
    technologyTerms: ['MCP', 'Python'],
    stageTerms: ['debug'],
    actionTerms: ['locate_root_cause'],
    requiredConditions: [{ kind: 'technology', anyOf: ['MCP'] }],
    avoidWhen: [{ kind: 'task_contains', anyOf: ['纯前端样式'] }],
    strategy: '确认进程与端口；核对客户端配置；重启后健康检查；再重试工具调用。',
    risks: ['远程 MCP 需先查网络'],
    evidenceRefs: ['TASK-1/ATT-1/seq 118-150'],
    confidence: 'medium',
    riskLevel: 'low',
    flags: [],
    lastVerifiedAt: NOW - 86400000,
    stats: {},
    ...overrides,
  };
}

function registry(experiences) {
  return { schema: 1, rev: 1, experiences };
}

const query = {
  task: '修复 MCP 工具连接失败',
  problem_type: 'tool_call_failure',
  symptoms: ['连接失败', 'ECONNREFUSED'],
  technology: ['MCP'],
  error_text: 'ECONNREFUSED 127.0.0.1:8765',
  stage: 'debug',
};

test('命中：签名+症状+技术+阶段 → 返回 EXP-0042 且分数过阈值', () => {
  const config = resolveConfig({});
  const payload = retrieve(registry([entry()]), query, config);
  assert.equal(payload.no_match, false);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].id, 'EXP-0042');
  assert.ok(payload.results[0].score >= config.minScore);
  assert.ok(payload.results[0].matched.includes('ECONNREFUSED 127.0.0.1:8765'));
});

test('条件不满足：required_conditions=deploy 在 debug 查询下被排除', () => {
  const config = resolveConfig({});
  const blocked = entry({
    id: 'EXP-9000',
    requiredConditions: [{ kind: 'stage', anyOf: ['deploy'] }],
  });
  const payload = retrieve(registry([blocked]), query, config);
  assert.equal(payload.no_match, true);
  assert.equal(payload.results.length, 0);
});

test('avoid_when 命中：即使关键词高分也不返回', () => {
  const config = resolveConfig({});
  const payload = retrieve(registry([entry()]), {
    ...query,
    task: '纯前端样式修改 MCP 图标',
  }, config);
  assert.equal(payload.no_match, true);
});

test('non-active（candidate）默认不参与检索', () => {
  const config = resolveConfig({});
  const payload = retrieve(registry([entry({ status: 'observing' })]), query, config);
  assert.equal(payload.no_match, true);
});

test('高风险默认不返回，allow_high_risk 才返回', () => {
  const config = resolveConfig({});
  const high = entry({ riskLevel: 'high' });
  assert.equal(retrieve(registry([high]), query, config).no_match, true);
  const allowed = retrieve(registry([high]), { ...query, allow_high_risk: true }, config);
  assert.equal(allowed.no_match, false);
});

test('无匹配：普通样式调整返回 NO_MATCH', () => {
  const config = resolveConfig({});
  const payload = retrieve(registry([entry()]), { task: '把按钮颜色改成蓝色' }, config);
  assert.equal(payload.no_match, true);
  assert.match(renderResults(payload, config), /NO_MATCH/);
});

test('limit 生效，且渲染不超过字符预算', () => {
  const config = resolveConfig({ maxResultChars: 600 });
  const second = entry({
    id: 'EXP-0043',
    name: '端口占用排查',
    strategy: '用 netstat 查端口占用，结束占用进程后重启服务。',
  });
  const payload = retrieve(registry([entry(), second]), { ...query, limit: 2 }, config);
  assert.equal(payload.results.length, 2);
  assert.ok(renderResults(payload, config).length <= 600);
});

test('条件三值：没提供技术栈且文本不含 MCP 时 technology 条件为 unknown', () => {
  const q = buildQuery({ task: '某个工具连不上', error_text: 'ECONNREFUSED' });
  assert.equal(evalCondition({ kind: 'technology', anyOf: ['MCP'] }, q), 'unknown');
  const withText = buildQuery({ task: 'MCP 连接失败' });
  assert.equal(evalCondition({ kind: 'technology', anyOf: ['MCP'] }, withText), true);
});
