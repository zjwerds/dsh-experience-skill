/**
 * retrieve.js — 本地经验检索（0 模型调用）。
 *
 * 职责：归一化查询 → 硬过滤 → 条件三值求值 → 六维打分 → 去重/冲突 → 截断 → 渲染。
 * 首版直接扫描 active 经验（规模 <10k 足够）；倒排索引留到 Phase 1.2。
 */
import { randomBytes } from 'node:crypto';
import {
  codePointLength, jaccard, normalizeText, tokenSet, truncate,
} from './text.js';
import { matchCandidateIds } from './indexer.js';

const CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

/** 构造规范化查询。 */
export function buildQuery(input) {
  const raw = input !== null && typeof input === 'object' ? input : {};
  const symptoms = Array.isArray(raw.symptoms) ? raw.symptoms.filter((x) => typeof x === 'string') : [];
  const technology = Array.isArray(raw.technology) ? raw.technology.filter((x) => typeof x === 'string') : [];
  const parts = [
    typeof raw.task === 'string' ? raw.task : '',
    typeof raw.error_text === 'string' ? raw.error_text : '',
    symptoms.join(' '),
    technology.join(' '),
    typeof raw.problem_type === 'string' ? raw.problem_type : '',
    typeof raw.stage === 'string' ? raw.stage : '',
    typeof raw.action_intent === 'string' ? raw.action_intent : '',
  ];
  const envText = normalizeText(
    [raw.os, raw.cwd, raw.environment].filter((x) => typeof x === 'string').join(' '),
  );
  return {
    text: normalizeText(parts.join(' ')),
    problemType: normalizeText(raw.problem_type ?? ''),
    stage: normalizeText(raw.stage ?? ''),
    technology: technology.map((x) => normalizeText(x)).filter(Boolean),
    envText,
    limit: Number.isInteger(raw.limit) ? raw.limit : undefined,
    includeLowConfidence: raw.include_low_confidence === true,
    allowHighRisk: raw.allow_high_risk === true,
  };
}

/** 单条经验的归一化字段。 */
function termsOf(entry) {
  const arr = (name) => (Array.isArray(entry?.[name]) ? entry[name].filter((x) => typeof x === 'string') : []);
  return {
    signatures: arr('errorSignatures'),
    triggers: [...arr('triggerTerms'), ...arr('symptomTerms')],
    problemTypes: arr('problemTypes'),
    technology: [...arr('technologyTerms'), ...arr('environmentTerms')],
    stages: arr('stageTerms'),
    actions: arr('actionTerms'),
    aliases: arr('aliases'),
  };
}

function hit(text, term) {
  const t = normalizeText(term);
  if (t.length < 2) return false;
  return text.includes(t);
}

/** 三值条件求值：true / false / 'unknown'。 */
export function evalCondition(condition, query) {
  if (condition === null || typeof condition !== 'object') return 'unknown';
  const anyOf = Array.isArray(condition.anyOf)
    ? condition.anyOf.filter((x) => typeof x === 'string').map((x) => normalizeText(x)).filter(Boolean)
    : [];
  if (anyOf.length === 0) return 'unknown';
  switch (condition.kind) {
    case 'technology': {
      if (anyOf.some((t) => query.text.includes(t))) return true;
      if (query.technology.length === 0) return 'unknown';
      return anyOf.some((t) => query.technology.includes(t)) ? true : false;
    }
    case 'task_contains': {
      if (query.text === '') return 'unknown';
      return anyOf.some((t) => query.text.includes(t)) ? true : false;
    }
    case 'stage': {
      if (query.stage === '') return 'unknown';
      return anyOf.includes(query.stage) ? true : false;
    }
    case 'environment': {
      if (query.envText === '') return 'unknown';
      return anyOf.some((t) => query.envText.includes(t)) ? true : false;
    }
    default:
      return 'unknown';
  }
}

function evalAll(conditions, query) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  let unknown = false;
  for (const condition of conditions) {
    const value = evalCondition(condition, query);
    if (value === false) return false;
    if (value === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : true;
}

function avoidHit(avoidWhen, query) {
  if (!Array.isArray(avoidWhen)) return false;
  return avoidWhen.some((condition) => evalCondition(condition, query) === true);
}

/** 计算某术语的文档频率（用于 idf）；优先用倒排索引的 df。 */
function makeDf(entries, index) {
  const cache = new Map();
  const indexedDf = index?.df instanceof Map ? index.df : null;
  return (term) => {
    const key = normalizeText(term);
    if (cache.has(key)) return cache.get(key);
    if (indexedDf !== null && indexedDf.has(key)) {
      const value = indexedDf.get(key);
      cache.set(key, value);
      return value;
    }
    let count = 0;
    for (const entry of entries) {
      const t = termsOf(entry);
      const all = [...t.signatures, ...t.triggers, ...t.technology, ...t.problemTypes];
      if (all.some((x) => normalizeText(x) === key)) count += 1;
    }
    cache.set(key, count);
    return count;
  };
}

function matchEntry(entry, query, dfFn, total) {
  const t = termsOf(entry);
  const matched = new Set();

  let signatureHit = null;
  for (const sig of t.signatures) {
    if (hit(query.text, sig)) {
      signatureHit = sig;
      matched.add(sig);
      break;
    }
  }
  const triggerHits = t.triggers.filter((term) => hit(query.text, term));
  for (const term of triggerHits.slice(0, 4)) matched.add(term);

  const problemHit = t.problemTypes.some((term) => {
    const n = normalizeText(term);
    return n === query.problemType || query.text.includes(n);
  });
  if (problemHit) {
    const first = t.problemTypes.find((term) => {
      const n = normalizeText(term);
      return n === query.problemType || query.text.includes(n);
    });
    if (first) matched.add(first);
  }

  const techHits = t.technology.filter((term) => {
    const n = normalizeText(term);
    return query.technology.includes(n) || query.text.includes(n);
  });
  for (const term of techHits.slice(0, 2)) matched.add(term);

  const stageHit = query.stage !== '' && t.stages.some((term) => normalizeText(term) === query.stage);
  if (stageHit) matched.add(query.stage);
  const actionHit = t.actions.some((term) => hit(query.text, term));
  if (actionHit) {
    const first = t.actions.find((term) => hit(query.text, term));
    if (first) matched.add(first);
  }

  const any = signatureHit !== null || triggerHits.length > 0 || problemHit || techHits.length > 0 || stageHit || actionHit;
  if (!any) return null;

  // 签名唯一性：df===1 时 1.5×
  let sigWeight = 0;
  if (signatureHit !== null) {
    const df = dfFn(signatureHit);
    sigWeight = 10 * (df <= 1 && total > 1 ? 1.5 : 1);
  }
  const trigWeight = triggerHits.length > 0
    ? 4 * Math.min(1.5, 1 + 0.25 * (triggerHits.length - 1))
    : 0;
  const raw = Math.min(20, sigWeight + trigWeight + (problemHit ? 3 : 0) + 2 * Math.min(2, techHits.length) + (stageHit || actionHit ? 1 : 0));

  const dfValues = [...matched].map((term) => dfFn(term));
  const avgIdf = dfValues.length > 0
    ? dfValues.reduce((sum, df) => sum + Math.log(1 + total / (1 + df)) / Math.log(1 + total), 0) / dfValues.length
    : 0.5;

  return {
    raw,
    idfFactor: 0.85 + 0.3 * avgIdf,
    matched: [...matched],
    signatureHit,
    triggerHits,
    problemHit,
    techHits,
  };
}

function recencyFactor(entry, now) {
  const verified = Number.isFinite(entry.lastVerifiedAt) ? entry.lastVerifiedAt : entry.updatedAt;
  if (!Number.isFinite(verified)) return 1;
  const days = Math.max(0, (now - verified) / 86400000);
  return 1 - 0.1 * Math.min(1, days / 365);
}

function hardFiltered(entry, query, config) {
  if (entry === null || typeof entry !== 'object') return true;
  if (config.requireActive && entry.status !== 'active') return true;
  if (Array.isArray(entry.flags) && entry.flags.includes('unavailable')) return true;
  const risk = entry.riskLevel ?? 'low';
  if (risk !== 'low' && !config.allowHighRisk && !query.allowHighRisk) return true;
  if (entry.confidence === 'low' && !config.includeLowConfidence && !query.includeLowConfidence) {
    if (!Array.isArray(entry.flags) || !entry.flags.includes('verify_on_use')) return true;
  }
  return false;
}

function branchFor(entry, query) {
  const branches = Array.isArray(entry.branches) ? entry.branches : [];
  for (const branch of branches) {
    if (branch === null || typeof branch !== 'object') continue;
    if (evalCondition(branch.when, query) === true) return branch;
  }
  return null;
}

function toResult(item, query, config) {
  const branch = branchFor(item.entry, query);
  const strategy = branch?.strategy ?? item.entry.strategy ?? '';
  const risks = Array.isArray(item.entry.risks) ? item.entry.risks : [];
  const conditions = Array.isArray(item.entry.requiredConditions)
    ? item.entry.requiredConditions.map((c) => (Array.isArray(c?.anyOf) ? c.anyOf.join('/') : c?.kind)).filter(Boolean)
    : [];
  return {
    id: item.entry.id,
    name: item.entry.name,
    score: item.score,
    matched: item.matched.slice(0, 8),
    confidence: item.entry.confidence ?? 'medium',
    status: item.entry.status,
    version: item.entry.version ?? 1,
    branch: branch?.id ?? null,
    conditions,
    strategy: truncate(strategy, 400),
    risks: risks.slice(0, 3),
    evidence: Array.isArray(item.entry.evidenceRefs) ? item.entry.evidenceRefs.slice(0, 3) : [],
    conflicts: Array.isArray(item.entry.conflictsWith) ? item.entry.conflictsWith.slice(0, 3) : [],
    flags: Array.isArray(item.entry.flags) ? item.entry.flags.slice(0, 3) : [],
    condition_unknown: item.conditionUnknown,
  };
}

/**
 * 主检索。
 * @param {object} registry
 * @param {object} input 原始查询参数
 * @param {object} config 归一化配置
 * @param {{index?: object}} [options] 可选倒排索引；缺省时扫描全部 active
 * @returns {{retrieval_id:string, query_echo:object, results:object[], no_match:boolean, hint:string}}
 */
export function retrieve(registry, input, config, options = {}) {
  const query = buildQuery(input);
  const now = Date.now();
  const all = Array.isArray(registry?.experiences) ? registry.experiences : [];
  const active = all.filter((entry) => !hardFiltered(entry, query, config));
  const index = options.index !== null && typeof options.index === 'object' ? options.index : null;
  let candidates = active;
  let total = active.length;
  if (index !== null && Number(index.total) > 0) {
    const matched = matchCandidateIds(index, query.text);
    candidates = active.filter((entry) => matched.has(entry.id));
    total = Number(index.total);
  }
  const dfFn = makeDf(candidates.length > 0 ? candidates : active, index);
  const scored = [];

  for (const entry of candidates) {
    if (avoidHit(entry.avoidWhen, query)) continue;
    const condition = evalAll(entry.requiredConditions, query);
    if (condition === false) continue;
    const match = matchEntry(entry, query, dfFn, total);
    if (match === null) continue;
    const score = Math.min(100, 100 * (match.raw / 20) * match.idfFactor * recencyFactor(entry, now) * (condition === 'unknown' ? 0.7 : 1));
    if (score < config.minScore) continue;
    scored.push({ entry, score: Math.round(score * 10) / 10, matched: match.matched, conditionUnknown: condition === 'unknown' });
  }

  // 去重：同 problemType 且正文相似度 ≥0.6，保留高分。
  scored.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const item of scored) {
    const duplicate = kept.find((other) =>
      (other.entry.problemTypes?.[0] ?? '') === (item.entry.problemTypes?.[0] ?? '') &&
      jaccard(tokenSet(other.entry.strategy ?? ''), tokenSet(item.entry.strategy ?? '')) >= 0.6);
    if (duplicate === undefined) kept.push(item);
  }

  kept.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const rc = (CONFIDENCE_RANK[b.entry.confidence] ?? 0) - (CONFIDENCE_RANK[a.entry.confidence] ?? 0);
    if (rc !== 0) return rc;
    return (b.entry.lastVerifiedAt ?? 0) - (a.entry.lastVerifiedAt ?? 0);
  });

  const limit = Math.min(3, Math.max(1, query.limit ?? config.maxResults));
  const results = kept.slice(0, limit).map((item) => toResult(item, query, config));
  return {
    retrieval_id: `RET-${now}-${randomBytes(2).toString('hex')}`,
    query_echo: {
      problem_type: typeof input?.problem_type === 'string' ? input.problem_type : null,
      symptoms: Array.isArray(input?.symptoms) ? input.symptoms.slice(0, 5) : [],
      technology: Array.isArray(input?.technology) ? input.technology.slice(0, 5) : [],
      error_text: typeof input?.error_text === 'string' ? truncate(input.error_text, 120) : null,
    },
    results,
    no_match: results.length === 0,
    hint: results.length === 0
      ? '没有可靠匹配。不要硬套经验，按正常流程排查；不要编造经验。'
      : '经验是历史假设，请结合当前证据判断；采用后可调用 feedback 记录结果。',
  };
}

const CONDITION_LABEL = { technology: '技术', task_contains: '任务包含', stage: '阶段', environment: '环境' };

/** 渲染成给模型看的紧凑文本（≤ maxResultChars 码点）。 */
export function renderResults(payload, config = {}) {
  const max = Number.isInteger(config.maxResultChars) ? config.maxResultChars : 1200;
  const lines = [];
  if (payload?.action === 'feedback') {
    return payload.ok === true ? '[experience-search] feedback 已记录。' : `[experience-search] feedback 未记录：${payload.code ?? 'UNKNOWN'}`;
  }
  if (!Array.isArray(payload?.results)) {
    return truncate(`[experience-search] 检索结果不可用${payload?.error ? `：${payload.error}` : ''}；按正常流程排查。`, max);
  }
  if (payload?.no_match) {
    lines.push(`[experience-retrieval] NO_MATCH（retrieval_id=${payload.retrieval_id ?? '-'}）`);
    if (payload.error) lines.push(`检索不可用：${payload.error}`);
    lines.push(payload.hint ?? '没有可靠匹配。按正常流程排查，不要编造经验。');
    return truncate(lines.join('\n'), max);
  }
  lines.push(`[experience-retrieval] 命中 ${payload.results.length} 条（retrieval_id=${payload.retrieval_id}）`);
  payload.results.forEach((item, index) => {
    lines.push(`${index + 1}) ${item.id} ${item.name}｜得分 ${item.score}｜置信 ${item.confidence}｜v${item.version}${item.branch ? `｜分支 ${item.branch}` : ''}`);
    if (item.matched.length > 0) lines.push(`   命中：${item.matched.join(' / ')}`);
    if (item.conditions.length > 0) lines.push(`   适用：${item.conditions.join('；')}${item.condition_unknown ? '（部分前提未验证）' : ''}`);
    lines.push(`   做法：${truncate(item.strategy, 240)}`);
    if (item.risks.length > 0) lines.push(`   风险：${item.risks.join('；')}`);
    if (item.evidence.length > 0) lines.push(`   证据：${item.evidence.join('，')}`);
    if (item.conflicts.length > 0) lines.push(`   冲突：${item.conflicts.join('，')}`);
  });
  lines.push('提示：经验是假设，不是结论；不适用就直接忽略。');
  return truncate(lines.join('\n'), max);
}

/** 供日志/测试使用：结果条数/耗时。 */
export function summarize(payload) {
  return {
    returned: payload.results.length,
    ids: payload.results.map((r) => r.id),
    chars: payload.results.reduce((sum, r) => sum + codePointLength(r.strategy), 0),
  };
}
