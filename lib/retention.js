/**
 * retention.js — trace 保留期清理。
 * 只删除超过 retentionTraceDays 的 trace 文件，并同步移除 checkpoints 偏移。
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function findTraceFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.trace.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * @param {import('./store.js').Store} store
 * @param {object} config
 * @param {number} [now]
 */
export function pruneTraces(store, config, now = Date.now()) {
  const days = Number.isFinite(config.retentionTraceDays) ? config.retentionTraceDays : 90;
  if (days <= 0) return { removed: 0, bytes: 0 };
  const root = join(store.dataDir, 'traces');
  const cutoff = now - days * 86400000;
  const files = findTraceFiles(root);
  if (files.length === 0) return { removed: 0, bytes: 0 };

  const checkpoints = store.loadCheckpoints();
  const offsets = checkpoints.traceOffsets !== null && typeof checkpoints.traceOffsets === 'object'
    ? { ...checkpoints.traceOffsets }
    : {};
  let removed = 0;
  let bytes = 0;

  for (const file of files) {
    let stat;
    try { stat = statSync(file); } catch { continue; }
    if (stat.mtimeMs >= cutoff) continue;
    const key = relative(store.dataDir, file).split('\\').join('/');
    const rawKey = relative(store.dataDir, file);
    try {
      bytes += stat.size;
      rmSync(file, { force: true });
      delete offsets[key];
      delete offsets[rawKey];
      removed += 1;
    } catch {
      // 删除失败保留偏移，下次再试。
    }
  }

  if (removed > 0) {
    checkpoints.traceOffsets = offsets;
    try { store.saveCheckpoints(checkpoints); } catch { /* 忽略 */ }
  }
  return { removed, bytes };
}
