/**
 * health.js — 启动/定期健康检查：文件存在性、hash、孤儿文件、索引统计。
 *
 * 原则：registry 是事实源；文件缺失时可从 registry 重建（repair=true）；
 * hash 不一致只标记、不静默覆盖（避免吞掉人工修改）。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { experiencePath, syncExperienceFiles } from './files.js';
import { indexStats } from './indexer.js';

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function filePathFor(root, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '') return null;
  const target = resolve(root, relativePath);
  if (!target.startsWith(root)) return null;
  return target;
}

function listMarkdown(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * @param {import('./store.js').Store} store
 * @param {{repair?: boolean, verifyHash?: boolean, now?: number}} [options]
 */
export function healthCheck(store, options = {}) {
  const repair = options.repair === true;
  const verifyHash = options.verifyHash === true;
  const root = resolve(store.dataDir);
  const registry = store.snapshot();
  const experiences = Array.isArray(registry.experiences) ? registry.experiences : [];
  const missing = [];
  const mismatched = [];
  let repaired = 0;

  for (const experience of experiences) {
    if (experience === null || typeof experience !== 'object') continue;
    if (experience.status !== 'active') continue;
    const rel = typeof experience.file === 'string' ? experience.file : experiencePath(experience);
    const target = rel === null ? null : filePathFor(root, rel);
    if (target === null || !existsSync(target)) {
      missing.push(experience.id);
      continue;
    }
    if (verifyHash && typeof experience.contentSha256 === 'string' && experience.contentSha256 !== '') {
      try {
        if (sha256(readFileSync(target, 'utf8')) !== experience.contentSha256) mismatched.push(experience.id);
      } catch {
        missing.push(experience.id);
      }
    }
  }

  if (repair && (missing.length > 0 || experiences.some((item) => item?.status === 'active' && !item.file))) {
    try {
      const stats = syncExperienceFiles(store);
      repaired = stats.written;
    } catch {
      // 修复失败保持 missing。
    }
  }

  const unresolved = missing.filter((id) => {
    const current = store.snapshot().experiences.find((entry) => entry?.id === id);
    const rel = typeof current?.file === 'string' ? current.file : experiencePath(current ?? {});
    const target = rel === null ? null : filePathFor(root, rel);
    return target === null || !existsSync(target);
  });

  if (unresolved.length > 0 || mismatched.length > 0) {
    try {
      store.update((draft) => {
        for (const item of draft.experiences) {
          if (item === null || typeof item !== 'object') continue;
          if (unresolved.includes(item.id)) {
            item.flags = Array.isArray(item.flags) ? item.flags : [];
            if (!item.flags.includes('unavailable')) item.flags.push('unavailable');
          }
          if (mismatched.includes(item.id)) {
            item.flags = Array.isArray(item.flags) ? item.flags : [];
            if (!item.flags.includes('file_mismatch')) item.flags.push('file_mismatch');
          }
        }
      });
    } catch {
      // 只读/写失败：返回检测结果即可。
    }
  }

  const referenced = new Set(experiences.map((item) => item?.file).filter((value) => typeof value === 'string'));
  const orphans = listMarkdown(join(root, 'active')).filter((file) => {
    const rel = file.slice(root.length + 1).split('\\').join('/');
    return !referenced.has(rel);
  }).length;

  return {
    ok: unresolved.length === 0 && mismatched.length === 0,
    missing,
    unresolved,
    mismatched,
    repaired,
    orphans,
    index: indexStats(store.indexSnapshot()),
  };
}
