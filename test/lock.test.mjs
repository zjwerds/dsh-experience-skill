import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireDataLock, isLockHeld } from '../lib/lock.js';

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'exp-skill-lock-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('同一目录只允许一个写锁；释放后可重新获取', () => {
  const dir = tempDir();
  const first = acquireDataLock(dir);
  assert.ok(first !== null);
  assert.equal(isLockHeld(dir), true);
  assert.equal(acquireDataLock(dir), null);

  assert.equal(first.release(), true);
  assert.equal(isLockHeld(dir), false);
  const second = acquireDataLock(dir);
  assert.ok(second !== null);
  second.release();
});

test('owner 进程仍存活时，即使 startedAt 很旧也不抢锁', () => {
  const dir = tempDir();
  const first = acquireDataLock(dir);
  assert.ok(first !== null);
  const ownerPath = join(dir, '.writer.lock', 'owner.json');
  const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
  owner.startedAt = Date.now() - 24 * 60 * 60 * 1000;
  writeFileSync(ownerPath, JSON.stringify(owner));

  assert.equal(acquireDataLock(dir, { staleMs: 1000 }), null);
  first.release();
});

test('过期锁（owner 超时）可被清理并获取', () => {
  const dir = tempDir();
  const lockDir = join(dir, '.writer.lock');
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'owner.json'), JSON.stringify({
    token: 'old', pid: 1, host: 'x', startedAt: Date.now() - 3 * 60 * 60 * 1000,
  }));
  const lock = acquireDataLock(dir, { staleMs: 60_000 });
  assert.ok(lock !== null);
  const owner = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8'));
  assert.notEqual(owner.token, 'old');
  lock.release();
});
