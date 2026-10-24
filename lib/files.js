/**
 * files.js — 经验正文落盘（candidates/active/archive）+ registry 文件引用同步。
 *
 * - 只写登记过的字段，正文来自 registry（已脱敏），不复制原始日志；
 * - 原子写（tmp + rename）；旧路径文件在状态迁移后删除；
 * - 路径只允许 [A-Za-z0-9_-]，防止目录穿越；
 * - 同步后把 file/contentSha256 写回 registry（rev CAS）。
 */
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { redact, truncate } from './text.js';

const ID_SAFE = /^[A-Za-z0-9_-]{1,80}$/;
const DOMAIN_MAP = new Map([
  ['network', 'network'],
  ['db_migration', 'database'],
  ['dependency_conflict', 'coding'],
  ['build', 'coding'],
  ['test', 'coding'],
  ['performance', 'coding'],
  ['tool_call_failure', 'agent'],
  ['context_loss', 'agent'],
  ['repeat_call', 'agent'],
  ['permission', 'security'],
]);

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function domainOf(experience) {
  const problem = Array.isArray(experience.problemTypes) ? experience.problemTypes[0] : '';
  return DOMAIN_MAP.get(problem) ?? 'general';
}

function safeId(id) {
  return typeof id === 'string' && ID_SAFE.test(id) ? id : null;
}

/** 相对路径（不依赖 cwd）。 */
export function experiencePath(experience) {
  const id = safeId(experience?.id);
  if (id === null) return null;
  const status = experience.status;
  if (status === 'active') return ['active', domainOf(experience), `${id}.md`].join('/');
  if (status === 'candidate' || status === 'observing' || status === 'pending_review') {
    return ['candidates', `${id}.md`].join('/');
  }
  return ['archive', `${id}.md`].join('/');
}

/** 渲染经验 Markdown（≤2KB 左右，不复制完整日志）。 */
export function renderExperienceMarkdown(experience) {
  const lines = [];
  lines.push('---');
  lines.push(`id: ${experience.id}`);
  lines.push(`name: ${redact(experience.name ?? '', 80)}`);
  lines.push(`status: ${experience.status}`);
  lines.push(`version: ${experience.version ?? 1}`);
  lines.push(`confidence: ${experience.confidence ?? 'medium'}`);
  lines.push(`risk: ${experience.riskLevel ?? 'low'}`);
  lines.push(`updated: ${new Date(experience.updatedAt ?? Date.now()).toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${redact(experience.name ?? experience.id, 80)}`);
  lines.push('');
  if (Array.isArray(experience.problemTypes) && experience.problemTypes.length > 0) {
    lines.push(`- 问题类型：${experience.problemTypes.join('、')}`);
  }
  const conditions = Array.isArray(experience.requiredConditions)
    ? experience.requiredConditions.map((item) => (Array.isArray(item?.anyOf) ? item.anyOf.join('/') : '')).filter(Boolean)
    : [];
  if (conditions.length > 0) lines.push(`- 适用：${conditions.join('；')}`);
  const avoid = Array.isArray(experience.avoidWhen)
    ? experience.avoidWhen.map((item) => (Array.isArray(item?.anyOf) ? item.anyOf.join('/') : '')).filter(Boolean)
    : [];
  if (avoid.length > 0) lines.push(`- 不适用：${avoid.join('；')}`);
  lines.push('');
  lines.push('## 做法');
  lines.push(redact(truncate(experience.strategy ?? '', 800), 800));
  if (Array.isArray(experience.branches) && experience.branches.length > 0) {
    lines.push('');
    lines.push('## 分支');
    for (const branch of experience.branches.slice(0, 3)) {
      const when = Array.isArray(branch?.when?.anyOf) ? branch.when.anyOf.join('/') : '条件';
      lines.push(`- ${branch.id ?? 'branch'}（${when}）：${redact(truncate(branch.strategy ?? '', 240), 240)}`);
    }
  }
  if (Array.isArray(experience.verifiedSteps) && experience.verifiedSteps.length > 0) {
    lines.push('');
    lines.push('## 已验证');
    for (const step of experience.verifiedSteps.slice(0, 5)) lines.push(`- ${redact(truncate(step, 120), 120)}`);
  }
  if (Array.isArray(experience.unverifiedSteps) && experience.unverifiedSteps.length > 0) {
    lines.push('');
    lines.push('## 未验证');
    for (const step of experience.unverifiedSteps.slice(0, 5)) lines.push(`- ${redact(truncate(step, 120), 120)}`);
  }
  if (Array.isArray(experience.risks) && experience.risks.length > 0) {
    lines.push('');
    lines.push('## 风险');
    for (const risk of experience.risks.slice(0, 5)) lines.push(`- ${redact(truncate(risk, 160), 160)}`);
  }
  if (Array.isArray(experience.evidenceRefs) && experience.evidenceRefs.length > 0) {
    lines.push('');
    lines.push('## 证据');
    for (const ref of experience.evidenceRefs.slice(0, 8)) lines.push(`- ${ref}`);
  }
  if (Array.isArray(experience.conflictsWith) && experience.conflictsWith.length > 0) {
    lines.push('');
    lines.push('## 冲突');
    for (const conflict of experience.conflictsWith.slice(0, 5)) lines.push(`- ${conflict}`);
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows 忽略 */ }
  renameSync(tmp, filePath);
  try { chmodSync(filePath, 0o600); } catch { /* 忽略 */ }
}

/**
 * 把 registry 里的经验同步成 Markdown 文件。
 * @param {import('./store.js').Store} store
 * @returns {{written:number, removed:number, skipped:number}}
 */
export function syncExperienceFiles(store) {
  const registry = store.snapshot();
  const experiences = Array.isArray(registry.experiences) ? registry.experiences : [];
  const stats = { written: 0, removed: 0, skipped: 0, unchanged: 0 };
  const updates = new Map();
  const root = resolve(store.dataDir);

  for (const experience of experiences) {
    if (experience === null || typeof experience !== 'object') continue;
    const rel = experiencePath(experience);
    if (rel === null) {
      stats.skipped += 1;
      continue;
    }
    const target = resolve(root, rel);
    if (!target.startsWith(root)) {
      stats.skipped += 1;
      continue;
    }
    const previous = typeof experience.file === 'string' ? experience.file : null;
    const body = renderExperienceMarkdown(experience);
    const digest = sha256(body);
    if (experience.file === rel && experience.contentSha256 === digest && existsSync(target)) {
      stats.unchanged += 1;
      continue;
    }
    try {
      atomicWrite(target, body);
      stats.written += 1;
    } catch {
      stats.skipped += 1;
      continue;
    }
    if (previous !== null && previous !== rel && !isAbsolute(previous)) {
      const oldPath = resolve(root, previous);
      if (oldPath.startsWith(root) && oldPath !== target) {
        try { unlinkSync(oldPath); stats.removed += 1; } catch { /* 不存在忽略 */ }
      }
    }
    if (experience.file !== rel || experience.contentSha256 !== digest) {
      updates.set(experience.id, { file: rel, contentSha256: digest });
    }
  }

  if (updates.size > 0) {
    store.update((draft) => {
      for (const item of draft.experiences) {
        const patch = updates.get(item?.id);
        if (patch !== undefined) {
          item.file = patch.file;
          item.contentSha256 = patch.contentSha256;
        }
      }
      return undefined;
    });
  }
  return stats;
}

/** 校验文件是否存在（健康检查用；不读内容）。 */
export function relativeFileExists(store, relativePath) {
  if (typeof relativePath !== 'string' || relativePath === '' || isAbsolute(relativePath)) return false;
  const target = resolve(store.dataDir, relativePath);
  const root = resolve(store.dataDir);
  if (!target.startsWith(root)) return false;
  return existsSync(target);
}
