/**
 * lock.js — 单写者目录锁（多 DSH 窗口共享 $DSH_HOME 时防止并发写 registry）。
 *
 * 用 mkdir 的原子性；锁目录里写 owner.json（pid/host/token/startedAt）。
 * 过期（默认 2h）或 owner 不存在时视为 stale，可清理后重试。
 * 释放时只删除自己 token 的锁，避免误删新 owner。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000;

function lockPaths(dataDir) {
  const dir = join(dataDir, '.writer.lock');
  return { dir, owner: join(dir, 'owner.json') };
}

function readOwner(ownerPath) {
  try {
    const parsed = JSON.parse(readFileSync(ownerPath, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isOwnerAlive(owner) {
  if (owner === null || !Number.isFinite(owner.pid)) return false;
  if (typeof owner.host === 'string' && owner.host !== hostname()) return true; // 跨主机无法探测，按存活处理
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function isStale(owner, staleMs, lockDir) {
  if (owner === null || !Number.isFinite(owner.startedAt)) {
    // owner.json 还没写完：10 秒内视为“正在初始化”，不抢锁。
    try {
      return Date.now() - statSync(lockDir).mtimeMs > 10_000;
    } catch {
      return true;
    }
  }
  if (typeof owner.host === 'string' && owner.host !== hostname()) {
    return Date.now() - owner.startedAt > staleMs;
  }
  // 本机 owner：只要进程还活着就不算过期（DSH 可以开一整天）。
  return !isOwnerAlive(owner);
}

/**
 * 尝试获取写锁。
 * @param {string} dataDir
 * @param {{staleMs?: number, now?: () => number}} [options]
 * @returns {{acquired: boolean, token: string, release: () => void, owner: object}|null}
 */
export function acquireDataLock(dataDir, options = {}) {
  const staleMs = Number.isFinite(options.staleMs) ? options.staleMs : DEFAULT_STALE_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  try { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); } catch { return null; }
  const { dir, owner } = lockPaths(dataDir);
  const token = randomBytes(8).toString('hex');

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(dir, { recursive: false, mode: 0o700 });
      const info = {
        token,
        pid: process.pid,
        host: hostname(),
        startedAt: now(),
      };
      try {
        writeFileSync(owner, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
      } catch {
        // owner 写入失败：删掉刚建的目录，避免留下空锁。
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
        return null;
      }
      return {
        acquired: true,
        token,
        owner: info,
        release() {
          const current = readOwner(owner);
          if (current === null || current.token !== token) return false;
          try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
          return true;
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return null;
      const current = readOwner(owner);
      if (!isStale(current, staleMs, dir)) return null;
      // stale：清理后重试一次。
      try { rmSync(dir, { recursive: true, force: true }); } catch { return null; }
    }
  }
  return null;
}

/** 只读检查：当前锁是否被持有（不修改）。 */
export function isLockHeld(dataDir) {
  const { dir } = lockPaths(dataDir);
  return existsSync(dir);
}
