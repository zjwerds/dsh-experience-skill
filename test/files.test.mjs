import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../lib/store.js';
import { experiencePath, renderExperienceMarkdown, syncExperienceFiles } from '../lib/files.js';

function tempStore() {
  const dataDir = mkdtempSync(join(tmpdir(), 'exp-skill-files-'));
  const store = new Store({ dataDir });
  store.init();
  return { dataDir, store };
}

function experience(overrides = {}) {
  return {
    id: 'EXP-1',
    name: 'MCP 连接排查',
    status: 'candidate',
    version: 1,
    problemTypes: ['tool_call_failure'],
    triggerTerms: ['ECONNREFUSED'],
    symptomTerms: ['连接失败'],
    errorSignatures: ['econnrefused'],
    technologyTerms: ['MCP'],
    requiredConditions: [{ kind: 'technology', anyOf: ['MCP'] }],
    avoidWhen: [],
    strategy: '先确认 MCP 进程与端口，再重启并健康检查。',
    risks: ['远程 MCP 不适用'],
    evidenceRefs: ['EV-1', 'EV-2'],
    confidence: 'medium',
    riskLevel: 'low',
    flags: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

test('候选写 candidates/，状态变 active 后移到 active/<domain>/ 并删旧文件', () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(experience()); });
  const first = syncExperienceFiles(store);
  assert.equal(first.written, 1);
  const candidateFile = join(dataDir, 'candidates', 'EXP-1.md');
  assert.equal(existsSync(candidateFile), true);
  const item = store.snapshot().experiences[0];
  assert.equal(item.file, 'candidates/EXP-1.md');
  assert.equal(item.contentSha256.length, 64);

  store.update((draft) => { draft.experiences[0].status = 'active'; });
  const second = syncExperienceFiles(store);
  assert.equal(second.written, 1);
  assert.equal(existsSync(candidateFile), false);
  const activeFile = join(dataDir, 'active', 'agent', 'EXP-1.md');
  assert.equal(existsSync(activeFile), true);
  assert.equal(store.snapshot().experiences[0].file, 'active/agent/EXP-1.md');
  const text = readFileSync(activeFile, 'utf8');
  assert.match(text, /## 做法/);
  assert.match(text, /先确认 MCP 进程/);
});

test('非法 id 跳过，不写出数据目录', () => {
  const { dataDir, store } = tempStore();
  store.update((draft) => { draft.experiences.push(experience({ id: '../evil' })); });
  const result = syncExperienceFiles(store);
  assert.equal(result.skipped, 1);
  assert.equal(existsSync(join(dataDir, '..', 'evil.md')), false);
  assert.equal(experiencePath({ id: '../evil', status: 'active' }), null);
});

test('Markdown 模板包含条件/风险/证据，且脱敏', () => {
  const text = renderExperienceMarkdown(experience({ strategy: '用 sk-abcdefghijklmnopqrstuvwx 调用' }));
  assert.match(text, /MCP 连接排查/);
  assert.match(text, /适用/);
  assert.match(text, /风险/);
  assert.match(text, /EV-1/);
  assert.equal(text.includes('sk-abcdefghijklmnopqrstuvwx'), false);
  assert.match(text, /redacted/);
});
