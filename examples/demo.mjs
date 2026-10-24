// 本地检索 demo：不加载 DSH、不调用模型，直接看渲染结果。
import { renderResults, retrieve } from '../lib/retrieve.js';
import { resolveConfig } from '../lib/config.js';

const now = Date.now();
const entry = {
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
  branches: [
    { id: 'local', when: { kind: 'environment', anyOf: ['local'] }, strategy: '确认进程与端口；查客户端配置；重启后健康检查；再重试。' },
  ],
  strategy: '确认进程与端口；查客户端配置；重启后健康检查；再重试。',
  risks: ['远程 MCP 需先查网络'],
  evidenceRefs: ['TASK-20261021-3e192056 / ATT-2 / seq 118-150'],
  confidence: 'medium',
  riskLevel: 'low',
  flags: [],
  lastVerifiedAt: now - 86400000,
  stats: {},
};

const registry = { schema: 1, rev: 1, experiences: [entry] };
const config = resolveConfig({});
const payload = retrieve(registry, {
  task: '修复 Agent 调用 MCP 工具失败的问题',
  problem_type: 'tool_call_failure',
  symptoms: ['连接失败', 'MCP 工具无响应'],
  technology: ['MCP'],
  error_text: 'ECONNREFUSED 127.0.0.1:8765',
  stage: 'debug',
  action_intent: 'locate_root_cause',
}, config);

const text = renderResults(payload, config);
console.log(text);
console.log('\n---');
console.log('returned:', payload.results.length, 'chars:', [...text].length, 'approx_tokens:', Math.ceil([...text].length * 0.7));
