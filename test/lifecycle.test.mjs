import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activateReadyDraft, detectRecurrence, evaluateGates, observeDraft,
  startObservationDraft, sweepObservationsDraft,
} from '../lib/lifecycle.js';
import { resolveConfig } from '../lib/config.js';

const NOW = 1_800_000_000_000;
const config = resolveConfig({});

function experience(overrides = {}) {
  return {
    id: 'EXP-1',
    issueId: 'ISS-1',
    name: 'MCP 连接排查',
    status: 'candidate',
    createdBy: 'batch-1',
    version: 1,
    problemTypes: ['network'],
    triggerTerms: ['ECONNREFUSED'],
    symptomTerms: ['连接失败'],
    errorSignatures: ['econnrefused'],
    technologyTerms: ['MCP'],
    stageTerms: ['debug'],
    actionTerms: ['locate_root_cause'],
    evidenceRefs: ['EV-1', 'EV-2'],
    evaluation: { result: 4, method: 4, evidence: 4, transfer: 3, efficiency: 3, risk: 1, verdict: 'EFFECTIVE' },
    confidence: 'medium',
    riskLevel: 'low',
    flags: [],
    conflictsWith: [],
    stats: { harmful: 0, improved: 0 },
    observation: {
      validRounds: 0,
      cleanRounds: 0,
      requiredCleanRounds: 2,
      firstSeenAt: NOW,
      deadlineAt: NOW + 14 * 86400000,
      lastRecurrenceAt: null,
      resetCount: 0,
    },
    ...overrides,
  };
}

function draftWith(item) {
  return { experiences: [item], evidence: [], issues: [], tasks: [] };
}

test('candidate → observing：只处理指定 batch 创建的候选', () => {
  const draft = { experiences: [experience(), experience({ id: 'EXP-2', createdBy: 'batch-2' })] };
  const started = startObservationDraft(draft, 'batch-1', config, NOW);
  assert.deepEqual(started.started, ['EXP-1']);
  assert.equal(draft.experiences[0].status, 'observing');
  assert.equal(draft.experiences[1].status, 'candidate');
});

test('两轮有效交互 → pending_review；门禁通过 → active', () => {
  const draft = draftWith(experience());
  startObservationDraft(draft, 'batch-1', config, NOW);
  observeDraft(draft, { sessionId: 's1', turn: 2, text: '处理一个普通任务', valid: true }, config, NOW + 1000);
  const item = draft.experiences[0];
  assert.equal(item.status, 'observing');
  assert.equal(item.observation.cleanRounds, 1);

  observeDraft(draft, { sessionId: 's1', turn: 3, text: '继续做别的事情', valid: true }, config, NOW + 2000);
  assert.equal(item.status, 'pending_review');
  assert.ok(item.flags.includes('observation_complete'));

  const activated = activateReadyDraft(draft, config, NOW + 3000);
  assert.deepEqual(activated.activated, ['EXP-1']);
  assert.equal(item.status, 'active');
  assert.equal(item.review.mode, 'auto');
  assert.ok(item.lastVerifiedAt > 0);
});

test('同类问题再现：重置 cleanRounds、追加观察证据、不激活', () => {
  const draft = draftWith(experience());
  startObservationDraft(draft, 'batch-1', config, NOW);
  observeDraft(draft, { sessionId: 's1', turn: 2, text: '普通任务', valid: true }, config, NOW + 1000);
  const item = draft.experiences[0];
  const before = item.evidenceRefs.length;

  const result = observeDraft(draft, {
    sessionId: 's2',
    turn: 1,
    text: '又出现 ECONNREFUSED，连接失败，MCP 无响应',
    valid: true,
    evidence: { id: 'EV-OBS-1', seq: 9, quote: 'ECONNREFUSED', trust: 'medium', createdAt: NOW + 2000 },
  }, config, NOW + 2000);

  assert.deepEqual(result.recurrences, ['EXP-1']);
  assert.equal(item.observation.cleanRounds, 0);
  assert.equal(item.observation.resetCount, 1);
  assert.ok(item.evidenceRefs.length > before);
  assert.equal(item.evidenceRefs.includes('EV-OBS-1'), true);
  assert.equal(item.status, 'observing');
});

test('FAILED_USEFUL / 高风险 / 负反馈：门禁拒绝', () => {
  const failedUseful = experience({
    status: 'pending_review',
    evaluation: { result: 1, method: 4, evidence: 3, transfer: 4, efficiency: 3, risk: 1, verdict: 'FAILED_USEFUL' },
  });
  assert.equal(evaluateGates(failedUseful, config).pass, false);
  assert.ok(evaluateGates(failedUseful, config).failed.includes('VERDICT_NOT_ACTIVATABLE'));

  const highRisk = experience({ status: 'pending_review', riskLevel: 'high' });
  assert.ok(evaluateGates(highRisk, config).failed.includes('RISK_NOT_LOW'));

  const harmful = experience({ status: 'pending_review', stats: { harmful: 1, improved: 2 } });
  assert.ok(evaluateGates(harmful, config).failed.includes('NEGATIVE_FEEDBACK'));
});

test('观察超期：转 pending_review 并标 observation_timeout', () => {
  const item = experience();
  item.status = 'observing';
  item.observation.deadlineAt = NOW - 1;
  const draft = draftWith(item);
  const result = sweepObservationsDraft(draft, config, NOW);
  assert.deepEqual(result.expired, ['EXP-1']);
  assert.equal(item.status, 'pending_review');
  assert.ok(item.flags.includes('observation_timeout'));
});

test('再检测：签名/两词命中/技术+一词都算再现', () => {
  const item = experience();
  assert.equal(detectRecurrence(item, '又报 ECONNREFUSED 了'), true);
  assert.equal(detectRecurrence(item, '连接失败，MCP 工具无响应'), true);
  assert.equal(detectRecurrence(item, 'MCP 正常但这次是别的问题'), false);
  assert.equal(detectRecurrence(item, '今天天气不错'), false);
});
