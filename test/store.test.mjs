import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'exp-skill-store-'));
}

test('init 创建 registry，update 递增 rev，重新加载一致', () => {
  const dir = tempDir();
  const store = new Store({ dataDir: dir });
  const first = store.init();
  assert.equal(first.rev, 0);
  assert.equal(first.experiences.length, 0);
  store.update((draft) => {
    draft.experiences.push({ id: 'EXP-1', status: 'active' });
    draft.issues.push({ id: 'ISS-1', attempts: ['ATT-1'], evidenceRefs: ['EV-1'] });
    draft.attempts.push({ id: 'ATT-1' });
    draft.evidence.push({ id: 'EV-1' });
  });
  const second = store.snapshot();
  assert.equal(second.rev, 1);
  assert.equal(second.experiences.length, 1);
  const reloaded = new Store({ dataDir: dir });
  reloaded.init();
  assert.equal(reloaded.snapshot().rev, 1);
  assert.equal(reloaded.snapshot().experiences[0].id, 'EXP-1');
  assert.equal(reloaded.snapshot().attempts.length, 1);
  assert.equal(reloaded.snapshot().evidence.length, 1);
});

test('CAS：expectedRev 不匹配抛 REV_CONFLICT，且不覆盖', () => {
  const store = new Store({ dataDir: tempDir() });
  store.init();
  store.update((draft) => { draft.experiences.push({ id: 'A' }); });
  assert.throws(
    () => store.update((draft) => { draft.experiences.push({ id: 'B' }); }, { expectedRev: 0 }),
    (error) => error.code === 'REV_CONFLICT',
  );
  assert.equal(store.snapshot().experiences.length, 1);
});

test('坏 registry 备份为 .corrupt-* 后从空库继续', () => {
  const dir = tempDir();
  const store = new Store({ dataDir: dir });
  store.init();
  writeFileSync(join(dir, 'registry.json'), '{not json', 'utf8');
  const warnings = [];
  const reloaded = new Store({ dataDir: dir, logger: { warn: (code) => warnings.push(code) } });
  const registry = reloaded.init();
  assert.equal(registry.experiences.length, 0);
  assert.ok(warnings.includes('REGISTRY_CORRUPT'));
  const backups = readdirSync(dir).filter((name) => name.startsWith('registry.json.corrupt-'));
  assert.equal(backups.length, 1);
});

test('未来 schema：拒绝写入并保留备份', () => {
  const dir = tempDir();
  const store = new Store({ dataDir: dir });
  store.init();
  writeFileSync(join(dir, 'registry.json'), JSON.stringify({
    schema: 999, rev: 1, experiences: [],
  }), 'utf8');
  const reloaded = new Store({ dataDir: dir });
  assert.throws(() => reloaded.init(), (error) => error.code === 'REGISTRY_SCHEMA_TOO_NEW');
  const future = readdirSync(dir).filter((name) => name.startsWith('registry.json.future-'));
  assert.equal(future.length, 1);
});

test('appendJsonlMany 追加多行，trace 路径按日期分片', () => {
  const dir = tempDir();
  const store = new Store({ dataDir: dir });
  store.init();
  const rel = store.tracePathFor('session-abc', Date.UTC(2026, 9, 22));
  store.appendJsonlMany(rel, [JSON.stringify({ a: 1 }), JSON.stringify({ b: 2 })]);
  const file = join(dir, rel);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
  assert.ok(readdirSync(join(dir, 'traces')).length >= 1);
});

test('recordFeedback 写入日志并更新 stats', () => {
  const dir = tempDir();
  const store = new Store({ dataDir: dir });
  store.init();
  store.update((draft) => {
    draft.experiences.push({ id: 'EXP-1', status: 'active', stats: {} });
  });
  const result = store.recordFeedback({
    retrievalId: 'RET-1',
    used: ['EXP-1'],
    outcome: 'improved',
    resultSignal: 'objective',
  });
  assert.equal(result.changed, true);
  const item = store.snapshot().experiences[0];
  assert.equal(item.stats.adopted, 1);
  assert.equal(item.stats.improved, 1);
  const log = readFileSync(join(dir, 'logs', 'feedback.jsonl'), 'utf8').trim();
  assert.match(log, /RET-1/);
  assert.ok(statSync(join(dir, 'logs', 'feedback.jsonl')).size > 0);
});
