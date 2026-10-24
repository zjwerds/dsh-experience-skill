/**
 * indexer.js — 经验倒排索引（0 模型调用）。
 *
 * 设计：
 *  - 只索引 active 经验；candidate/observing 不进普通检索。
 *  - 每个术语拆成 2–4 字 CJK gram + 英文词，查询侧同样拆 gram；
 *    先取候选集，再由 retrieve.js 做完整术语匹配与打分。
 *  - df 按完整术语统计（用于 idf），postings 按 gram 统计（用于召回）。
 */
import { normalizeText } from './text.js';

const CJK = /[\u4e00-\u9fff]/;

/** 把一个术语拆成查询/索引共用的 gram。 */
export function termGrams(term) {
  const value = normalizeText(term);
  const grams = new Set();
  if (value === '') return grams;
  const latin = value.match(/[a-z0-9_.:/-]{2,}/g) ?? [];
  for (const word of latin) grams.add(word);
  const cjkRuns = value.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of cjkRuns) {
    const chars = [...run];
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= chars.length; i++) grams.add(chars.slice(i, i + n).join(''));
    }
    if (chars.length === 1) grams.add(chars[0]);
  }
  return grams;
}

function fieldTerms(experience) {
  const list = [];
  for (const name of ['problemTypes', 'triggerTerms', 'symptomTerms', 'aliases', 'errorSignatures', 'technologyTerms', 'stageTerms', 'actionTerms']) {
    const value = experience?.[name];
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') list.push(item);
    }
  }
  return list;
}

/**
 * 构建索引。
 * @param {object[]} experiences
 * @param {{now?: number}} [options]
 */
export function buildIndex(experiences, options = {}) {
  const entries = (Array.isArray(experiences) ? experiences : []).filter((item) => item?.status === 'active');
  const postings = new Map();
  const df = new Map();
  const ids = new Set();
  for (const experience of entries) {
    if (typeof experience.id !== 'string') continue;
    ids.add(experience.id);
    const seenTerms = new Set();
    for (const term of fieldTerms(experience)) {
      const normalized = normalizeText(term);
      if (normalized.length < 2) continue;
      if (!seenTerms.has(normalized)) {
        seenTerms.add(normalized);
        df.set(normalized, (df.get(normalized) ?? 0) + 1);
      }
      for (const gram of termGrams(term)) {
        if (!postings.has(gram)) postings.set(gram, new Set());
        postings.get(gram).add(experience.id);
      }
    }
  }
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return { rev: 1, builtAt: now, total: ids.size, ids, postings, df };
}

/** 查询文本 → 候选经验 ID 集合（gram 召回，不做打分）。 */
export function matchCandidateIds(index, text) {
  const out = new Set();
  if (index === null || typeof index !== 'object' || !(index.postings instanceof Map)) return out;
  const value = normalizeText(text);
  if (value === '') return out;
  for (const gram of termGrams(value)) {
    const hit = index.postings.get(gram);
    if (hit === undefined) continue;
    for (const id of hit) out.add(id);
  }
  return out;
}

/** 索引占用统计（日志/健康检查用）。 */
export function indexStats(index) {
  if (index === null || typeof index !== 'object') return { total: 0, terms: 0, postings: 0 };
  let postings = 0;
  for (const value of index.postings.values()) postings += value.size;
  return { total: index.total ?? 0, terms: index.postings.size, postings };
}

/** CJK 判断（测试/调试用）。 */
export function isCjk(text) {
  return CJK.test(String(text ?? ''));
}
