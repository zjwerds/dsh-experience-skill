import test from 'node:test';
import assert from 'node:assert/strict';
import { correlate, extractSignature, classifyProblem } from '../lib/correlate.js';

let seq = 0;
const rec = (sessionId, turn, type, data = {}, ts) => ({
  sessionId,
  turn,
  type,
  seq: ++seq,
  ts: ts ?? 1_700_000_000_000 + seq,
  ...data,
});

function networkTrace() {
  seq = 0;
  const a = [
    rec('session-a', 1, 'user/message', { text: '修复 MCP 连接失败' }),
    rec('session-a', 1, 'tool/call', { callId: 'c1', tool: 'pwsh', args: 'python mcp_client.py' }),
    rec('session-a', 1, 'tool/result', { callId: 'c1', isError: true, text: 'ECONNREFUSED 127.0.0.1:8765' }),
    rec('session-a', 1, 'assistant/message', { text: '先检查端口' }),
    rec('session-a', 1, 'tool/call', { callId: 'c2', tool: 'pwsh', args: 'netstat -ano | findstr 8765' }),
    rec('session-a', 1, 'tool/result', { callId: 'c2', isError: false, text: 'no listener' }),
    rec('session-a', 1, 'turn/end', { reason: 'completed' }),
    rec('session-a', 2, 'user/message', { text: '再试一次' }),
    rec('session-a', 2, 'tool/call', { callId: 'c3', tool: 'pwsh', args: 'python mcp_client.py' }),
    rec('session-a', 2, 'tool/result', { callId: 'c3', isError: true, text: 'ECONNREFUSED 127.0.0.1:8765' }),
    rec('session-a', 2, 'assistant/message', { text: '重启 MCP 服务' }),
    rec('session-a', 2, 'tool/call', { callId: 'c4', tool: 'pwsh', args: 'start mcp-server' }),
    rec('session-a', 2, 'tool/result', { callId: 'c4', isError: false, text: 'exit code 0' }),
    rec('session-a', 2, 'tool/call', { callId: 'c5', tool: 'pwsh', args: 'python mcp_client.py' }),
    rec('session-a', 2, 'tool/result', { callId: 'c5', isError: false, text: 'HTTP 200 OK' }),
    rec('session-a', 2, 'turn/end', { reason: 'completed' }),
    rec('session-a', 3, 'user/message', { text: '迁移报错 column does not exist' }),
    rec('session-a', 3, 'tool/call', { callId: 'c6', tool: 'pwsh', args: 'alembic upgrade head' }),
    rec('session-a', 3, 'tool/result', { callId: 'c6', isError: true, text: 'column user_id does not exist' }),
    rec('session-a', 3, 'turn/end', { reason: 'completed' }),
  ];
  const b = [
    rec('session-b', 1, 'user/message', { text: 'MCP 工具无响应' }),
    rec('session-b', 1, 'tool/call', { callId: 'b1', tool: 'pwsh', args: 'python mcp_client.py' }),
    rec('session-b', 1, 'tool/result', { callId: 'b1', isError: true, text: 'ECONNREFUSED 127.0.0.1:8765' }),
    rec('session-b', 1, 'turn/end', { reason: 'completed' }),
  ];
  return [...a, ...b];
}

test('签名抽取与问题类型', () => {
  assert.equal(extractSignature('connect ECONNREFUSED 127.0.0.1:8765'), 'econnrefused');
  assert.equal(extractSignature('column user_id does not exist'), 'column user_id does not exist');
  assert.equal(classifyProblem('econnrefused', ''), 'network');
  assert.equal(classifyProblem('column user_id does not exist', '迁移失败'), 'db_migration');
});

test('同签名跨会话合并成一个 Issue，两次失败+一次成功 → 3 个 Attempt', () => {
  const result = correlate(networkTrace());
  assert.equal(result.tasks.length, 2);
  const issue = result.issues.find((item) => item.signature === 'econnrefused');
  assert.ok(issue, 'network issue exists');
  assert.equal(issue.problemType, 'network');
  assert.equal(issue.taskIds.length, 2);
  assert.equal(new Set(issue.taskIds).size, 2);
  assert.equal(issue.sessionIds.length, 2);
  assert.equal(issue.attempts.length, 3);
  // session-b 在 session-a 之后处理，其失败尝试把已 resolved 的 Issue 重新打开。
  assert.equal(issue.status, 'open');
  assert.ok(issue.evidenceRefs.length >= 3);

  const attemptsOfIssue = result.attempts.filter((item) => item.issueId === issue.id);
  assert.equal(attemptsOfIssue.length, 3);
  assert.equal(attemptsOfIssue[0].result, 'failed');
  assert.ok(['partial', 'success'].includes(attemptsOfIssue[1].result));
  assert.equal(attemptsOfIssue[2].result, 'failed');
});

test('一个任务内多个问题拆成多个 Issue，不压成一条', () => {
  const result = correlate(networkTrace());
  assert.equal(result.issues.length, 2);
  const db = result.issues.find((item) => item.problemType === 'db_migration');
  assert.ok(db);
  assert.equal(db.attempts.length, 1);
  assert.equal(db.status, 'open');
});

test('确定性：同输入两次运行 ID 与数量一致', () => {
  const a = correlate(networkTrace());
  const b = correlate(networkTrace());
  assert.deepEqual(a.issues.map((item) => item.id), b.issues.map((item) => item.id));
  assert.equal(a.attempts.length, b.attempts.length);
  assert.deepEqual(a.evidence.map((item) => item.id), b.evidence.map((item) => item.id));
});

test('空输入返回空结构', () => {
  const result = correlate([]);
  assert.deepEqual(result, { tasks: [], issues: [], attempts: [], evidence: [] });
});

test('只有用户问题描述（无工具失败）不抛错，Issue/Attempt ID 安全且不冲突', () => {
  seq = 0;
  const records = [
    rec('session-c', 1, 'user/message', { text: '页面加载失败' }),
    rec('session-c', 1, 'turn/end', { reason: 'completed' }),
    rec('session-c', 2, 'user/message', { text: '按钮点击异常' }),
    rec('session-c', 2, 'turn/end', { reason: 'completed' }),
  ];
  const result = correlate(records);
  assert.equal(result.issues.length, 2);
  for (const issue of result.issues) {
    assert.match(issue.id, /^ISS-[A-F0-9]{10}$/);
    assert.match(issue.issueKey, /^tool_call_failure\|/);
  }
  assert.notEqual(result.issues[0].id, result.issues[1].id);
  const attemptIds = result.attempts.map((item) => item.id);
  assert.equal(new Set(attemptIds).size, attemptIds.length);
  for (const id of attemptIds) assert.match(id, /^ATT-[A-F0-9]{8}-\d+$/);
});
