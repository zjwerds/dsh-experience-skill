import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.js';
import { syncExperienceFiles } from '../lib/files.js';
import { healthCheck } from '../lib/health.js';

function tempStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'exp-skill-health-'));
  const store = new Store({ dataDir });
  store.init();
  return { dataDir, store };
}

function experience() {
  return {
    id: 'EXP-1',
    name: 'MCP 连接排查',
    status: 'active',
    version: 1,
    problemTypes: ['tool_call_failure'],
    triggerTerms: ['ECONNREFUSED'],
    symptomTerms: ['连接失败'],
    errorSignatures: ['econnrefused'],
    technologyTerms: ['MCP'],
    requiredConditions: [{ kind: 'technology', anyOf: ['MCP'] }],
    avoidWhen: [],
    strategy: '先确认进程与端口，再重启并健康检查。',
    risks: [],
    evidenceRefs: ['EV-1', 'EV-2'],
    confidence: 'medium',
    riskLevel: 'low',
    flags: [],
    updatedAt: Date.now(),
  };
}

test('缺失文件：repair=true 从 registry 重建', () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(experience()); });
  syncExperienceFiles(store);
  const activeFile = join(dataDir, 'active', 'agent', 'EXP-1.md');
  assert.equal(existsSync(activeFile), true);
  unlinkSync(activeFile);

  const health = healthCheck(store, { repair: true });
  assert.equal(health.missing.length, 1);
  assert.equal(health.repaired, 1);
  assert.equal(health.ok, true);
  assert.equal(existsSync(activeFile), true);
});

test('缺失且不修复：标 unavailable', () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(experience()); });
  syncExperienceFiles(store);
  unlinkSync(join(dataDir, 'active', 'agent', 'EXP-1.md'));

  const health = healthCheck(store, { repair: false });
  assert.equal(health.ok, false);
  assert.deepEqual(health.unresolved, ['EXP-1']);
  const item = store.snapshot().experiences[0];
  assert.ok(item.flags.includes('unavailable'));
});

test('hash 不一致：只标记 file_mismatch，不覆盖文件', () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(experience()); });
  syncExperienceFiles(store);
  const activeFile = join(dataDir, 'active', 'agent', 'EXP-1.md');
  writeFileSync(activeFile, '人工修改的内容', 'utf8');

  const health = healthCheck(store, { repair: true, verifyHash: true });
  assert.deepEqual(health.mismatched, ['EXP-1']);
  assert.equal(health.ok, false);
  assert.equal(readFileSync(activeFile, 'utf8'), '人工修改的内容');
  assert.ok(store.snapshot().experiences[0].flags.includes('file_mismatch'));
});

test('孤儿文件计数（不自动删除）', () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(experience()); });
  syncExperienceFiles(store);
  mkdirSync(join(dataDir, 'active', 'agent'), { recursive: true });
  writeFileSync(join(dataDir, 'active', 'agent', 'ORPHAN.md'), '# orphan', 'utf8');

  const health = healthCheck(store, { repair: false });
  assert.equal(health.orphans, 1);
  assert.equal(existsSync(join(dataDir, 'active', 'agent', 'ORPHAN.md')), true);
});
