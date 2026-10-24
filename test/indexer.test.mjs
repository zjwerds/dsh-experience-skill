import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, indexStats, matchCandidateIds, termGrams } from '../lib/indexer.js';
import { resolveConfig } from '../lib/config.js';
import { retrieve } from '../lib/retrieve.js';

const NOW = Date.now();
const active = {
  id: 'EXP-1',
  status: 'active',
  problemTypes: ['tool_call_failure'],
  triggerTerms: ['MCP 工具无响应'],
  symptomTerms: ['连接失败'],
  errorSignatures: ['ECONNREFUSED'],
  technologyTerms: ['MCP'],
  stageTerms: ['debug'],
  actionTerms: ['locate_root_cause'],
  requiredConditions: [{ kind: 'technology', anyOf: ['MCP'] }],
  avoidWhen: [],
  strategy: '先确认进程与端口，再重启并健康检查。',
  risks: [],
  evidenceRefs: ['EV-1', 'EV-2'],
  confidence: 'medium',
  riskLevel: 'low',
  flags: [],
  lastVerifiedAt: NOW,
};

test('gram 拆分：中文 2–4 字、英文词', () => {
  const grams = termGrams('MCP 连接失败');
  assert.equal(grams.has('mcp'), true);
  assert.equal(grams.has('连接'), true);
  assert.equal(grams.has('连接失败'), true);
});

test('索引只收 active，df 按完整术语，候选集按 gram 召回', () => {
  const index = buildIndex([active, { ...active, id: 'EXP-2', status: 'candidate' }]);
  assert.equal(index.total, 1);
  assert.equal(index.ids.has('EXP-1'), true);
  assert.equal(index.ids.has('EXP-2'), false);
  assert.equal(index.df.get('econnrefused'), 1);
  assert.equal(index.df.get('连接失败'), 1);
  const ids = matchCandidateIds(index, 'ECONNREFUSED 连接失败');
  assert.equal(ids.has('EXP-1'), true);
  assert.equal(matchCandidateIds(index, '完全无关的文本').size, 0);
  assert.ok(indexStats(index).postings > 0);
});

test('带索引检索与全量扫描结果一致；无关查询 NO_MATCH', () => {
  const registry = { schema: 1, rev: 1, experiences: [active] };
  const config = resolveConfig({});
  const index = buildIndex(registry.experiences);
  const query = {
    task: '修复 MCP 连接失败',
    problem_type: 'tool_call_failure',
    symptoms: ['连接失败'],
    technology: ['MCP'],
    error_text: 'ECONNREFUSED',
    stage: 'debug',
  };
  const withIndex = retrieve(registry, query, config, { index });
  const without = retrieve(registry, query, config);
  assert.equal(withIndex.results[0].id, 'EXP-1');
  assert.deepEqual(withIndex.results.map((item) => item.id), without.results.map((item) => item.id));

  const miss = retrieve(registry, { task: '调整 CSS 颜色' }, config, { index });
  assert.equal(miss.no_match, true);
});
