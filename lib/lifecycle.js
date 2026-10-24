/**
 * lifecycle.js — 候选/观察/待复核/活跃的状态机与门禁（0 模型调用）。
 *
 * 所有函数都直接改 registry draft（配合 store.update 的 CAS），便于单测与回滚。
 * 关键边界：
 *  - 两轮观察按“有效任务回合”计；再现会重置 cleanRounds，但不重置已有证据；
 *  - 观察期满只进 pending_review，不自动 active；
 *  - 激活门禁不满足就保留 pending_review，绝不“为了进化”强行激活。
 */
import { normalizeText } from './text.js';

const VERDICT_OK = new Set(['EFFECTIVE', 'PARTIAL']);

/** 候选 → observing（analyzer 批次写回后调用一次）。 */
export function startObservationDraft(draft, batchId, config, now = Date.now()) {
  if (!Array.isArray(draft.experiences)) return { started: [] };
  const started = [];
  for (const item of draft.experiences) {
    if (item === null || typeof item !== 'object') continue;
    if (item.status !== 'candidate') continue;
    if (typeof batchId === 'string' && item.createdBy !== batchId) continue;
    item.status = 'observing';
    item.observation = item.observation !== null && typeof item.observation === 'object' ? item.observation : {};
    item.observation.startedAt = now;
    item.observation.validRounds = Number.isInteger(item.observation.validRounds) ? item.observation.validRounds : 0;
    item.observation.cleanRounds = Number.isInteger(item.observation.cleanRounds) ? item.observation.cleanRounds : 0;
    item.observation.requiredCleanRounds = Number.isInteger(item.observation.requiredCleanRounds)
      ? item.observation.requiredCleanRounds
      : config.requiredCleanRounds;
    item.observation.deadlineAt = Number.isFinite(item.observation.deadlineAt)
      ? item.observation.deadlineAt
      : now + config.observationMaxDays * 86400000;
    item.observation.resetCount = Number.isInteger(item.observation.resetCount) ? item.observation.resetCount : 0;
    item.updatedAt = now;
    started.push(item.id);
  }
  return { started };
}

/** 同类问题是否再现（程序规则，0 模型）。 */
export function detectRecurrence(experience, text) {
  const value = normalizeText(text ?? '');
  if (value === '') return false;
  const signatures = Array.isArray(experience.errorSignatures) ? experience.errorSignatures : [];
  for (const signature of signatures) {
    const normalized = normalizeText(signature);
    if (normalized.length >= 4 && value.includes(normalized)) return true;
  }
  const terms = [
    ...(Array.isArray(experience.triggerTerms) ? experience.triggerTerms : []),
    ...(Array.isArray(experience.symptomTerms) ? experience.symptomTerms : []),
  ].filter((term) => typeof term === 'string' && normalizeText(term).length >= 2);
  const hits = terms.filter((term) => value.includes(normalizeText(term)));
  if (hits.length >= 2) return true;
  const technology = Array.isArray(experience.technologyTerms) ? experience.technologyTerms : [];
  const techHit = technology.some((term) => value.includes(normalizeText(term)));
  return techHit && hits.length >= 1;
}

/** 一个有效任务回合 → 推进所有 observing 候选。 */
export function observeDraft(draft, interaction, config, now = Date.now()) {
  const result = { recurrences: [], promoted: [], expired: [] };
  if (!Array.isArray(draft.experiences) || interaction === null || typeof interaction !== 'object') return result;
  if (interaction.valid !== true) return result;
  const text = typeof interaction.text === 'string' ? interaction.text : '';
  if (text.trim() === '') return result;

  for (const item of draft.experiences) {
    if (item === null || typeof item !== 'object' || item.status !== 'observing') continue;
    const observation = item.observation !== null && typeof item.observation === 'object' ? item.observation : {};
    item.observation = observation;
    observation.validRounds = Number.isInteger(observation.validRounds) ? observation.validRounds : 0;
    observation.cleanRounds = Number.isInteger(observation.cleanRounds) ? observation.cleanRounds : 0;
    observation.resetCount = Number.isInteger(observation.resetCount) ? observation.resetCount : 0;
    const required = Number.isInteger(observation.requiredCleanRounds)
      ? observation.requiredCleanRounds
      : config.requiredCleanRounds;

    if (Number.isFinite(observation.deadlineAt) && now >= observation.deadlineAt) {
      item.status = 'pending_review';
      item.flags = addFlag(item.flags, 'observation_timeout');
      item.updatedAt = now;
      result.expired.push(item.id);
      continue;
    }

    if (detectRecurrence(item, text)) {
      observation.validRounds += 1;
      observation.cleanRounds = 0;
      observation.lastRecurrenceAt = now;
      observation.resetCount += 1;
      item.updatedAt = now;
      result.recurrences.push(item.id);
      if (interaction.evidence !== null && typeof interaction.evidence === 'object') {
        const evidence = interaction.evidence;
        if (typeof evidence.id === 'string' && !item.evidenceRefs.includes(evidence.id)) {
          item.evidenceRefs.push(evidence.id);
          evidence.issueId = item.issueId;
          if (!Array.isArray(draft.evidence)) draft.evidence = [];
          if (!draft.evidence.some((entry) => entry?.id === evidence.id)) draft.evidence.push(evidence);
        }
      }
      if (observation.resetCount > config.resetCap) {
        item.status = 'pending_review';
        item.flags = addFlag(item.flags, 'frequent_recurrence');
        result.promoted.push(item.id);
      }
      continue;
    }

    observation.validRounds += 1;
    observation.cleanRounds += 1;
    item.updatedAt = now;
    if (observation.cleanRounds >= required) {
      item.status = 'pending_review';
      item.flags = addFlag(item.flags, 'observation_complete');
      result.promoted.push(item.id);
    }
  }
  return result;
}

/** 观察超期扫描（无新交互时由心跳调用）。 */
export function sweepObservationsDraft(draft, config, now = Date.now()) {
  const expired = [];
  if (!Array.isArray(draft.experiences)) return { expired };
  for (const item of draft.experiences) {
    if (item === null || typeof item !== 'object' || item.status !== 'observing') continue;
    const observation = item.observation;
    if (observation === null || typeof observation !== 'object') continue;
    if (!Number.isFinite(observation.deadlineAt) || now < observation.deadlineAt) continue;
    item.status = 'pending_review';
    item.flags = addFlag(item.flags, 'observation_timeout');
    item.updatedAt = now;
    expired.push(item.id);
  }
  return { expired };
}

/** 激活门禁：全部满足才自动 active。 */
export function evaluateGates(experience, config) {
  const failed = [];
  const observation = experience.observation !== null && typeof experience.observation === 'object' ? experience.observation : {};
  const required = Number.isInteger(observation.requiredCleanRounds) ? observation.requiredCleanRounds : config.requiredCleanRounds;
  if (!Number.isInteger(observation.cleanRounds) || observation.cleanRounds < required) failed.push('OBSERVATION_INCOMPLETE');
  if (!Array.isArray(experience.evidenceRefs) || experience.evidenceRefs.length < 2) failed.push('EVIDENCE_INSUFFICIENT');
  const evaluation = experience.evaluation !== null && typeof experience.evaluation === 'object' ? experience.evaluation : {};
  if (!Number.isFinite(evaluation.method) || evaluation.method < 4) failed.push('METHOD_LOW');
  if (!VERDICT_OK.has(evaluation.verdict)) failed.push('VERDICT_NOT_ACTIVATABLE');
  if (experience.riskLevel !== 'low') failed.push('RISK_NOT_LOW');
  if (experience.confidence === 'low') failed.push('CONFIDENCE_LOW');
  const stats = experience.stats !== null && typeof experience.stats === 'object' ? experience.stats : {};
  if (Number(stats.harmful) > 0) failed.push('NEGATIVE_FEEDBACK');
  if (Array.isArray(experience.conflictsWith) && experience.conflictsWith.length > 0) failed.push('UNRESOLVED_CONFLICT');
  if (Array.isArray(experience.flags) && (experience.flags.includes('needs_reverify') || experience.flags.includes('needs_review'))) {
    failed.push('NEEDS_REVIEW');
  }
  return { pass: failed.length === 0, failed };
}

/** pending_review → active（只处理门禁通过的）。 */
export function activateReadyDraft(draft, config, now = Date.now()) {
  const activated = [];
  const blocked = [];
  if (!Array.isArray(draft.experiences)) return { activated, blocked };
  for (const item of draft.experiences) {
    if (item === null || typeof item !== 'object' || item.status !== 'pending_review') continue;
    const gates = evaluateGates(item, config);
    if (!gates.pass) {
      blocked.push({ id: item.id, failed: gates.failed });
      continue;
    }
    item.status = 'active';
    item.lastVerifiedAt = now;
    item.updatedAt = now;
    item.flags = (Array.isArray(item.flags) ? item.flags : []).filter((flag) => flag !== 'verify_on_use');
    item.review = {
      mode: 'auto',
      by: 'rule',
      at: now,
      checks: ['cleanRounds', 'evidence>=2', 'method>=4', 'verdict', 'risk=low'],
    };
    activated.push(item.id);
  }
  return { activated, blocked };
}

/** 人工批准：跳过门禁，但保留 review 记录。 */
export function approveDraft(draft, id, actor, note, now = Date.now()) {
  if (!Array.isArray(draft.experiences)) return false;
  const item = draft.experiences.find((entry) => entry?.id === id);
  if (item === undefined) return false;
  item.status = 'active';
  item.lastVerifiedAt = now;
  item.updatedAt = now;
  item.flags = (Array.isArray(item.flags) ? item.flags : []).filter((flag) => flag !== 'needs_review' && flag !== 'verify_on_use');
  item.review = { mode: 'manual', by: typeof actor === 'string' ? actor : 'user', at: now, note: typeof note === 'string' ? note.slice(0, 200) : '' };
  return true;
}

/** 停用/归档/合并的薄封装。 */
export function deprecateDraft(draft, id, reason, now = Date.now()) {
  const item = findExperience(draft, id);
  if (item === undefined) return false;
  item.status = 'deprecated';
  item.deprecatedAt = now;
  item.deprecatedReason = typeof reason === 'string' ? reason.slice(0, 200) : '';
  item.updatedAt = now;
  return true;
}

export function archiveDraft(draft, id, reason, now = Date.now()) {
  const item = findExperience(draft, id);
  if (item === undefined) return false;
  item.status = 'archived';
  item.archivedAt = now;
  item.archiveReason = typeof reason === 'string' ? reason.slice(0, 200) : '';
  item.updatedAt = now;
  return true;
}

export function mergeDraft(draft, fromId, intoId, now = Date.now()) {
  const from = findExperience(draft, fromId);
  const into = findExperience(draft, intoId);
  if (from === undefined || into === undefined || from.id === into.id) return false;
  into.evidenceRefs = union(into.evidenceRefs, from.evidenceRefs);
  into.aliases = union(into.aliases, from.aliases);
  into.triggerTerms = union(into.triggerTerms, from.triggerTerms);
  into.symptomTerms = union(into.symptomTerms, from.symptomTerms);
  into.updatedAt = now;
  from.status = 'merged';
  from.canonicalId = into.id;
  from.mergedAt = now;
  from.updatedAt = now;
  return true;
}

function findExperience(draft, id) {
  if (!Array.isArray(draft.experiences)) return undefined;
  return draft.experiences.find((entry) => entry?.id === id);
}

function addFlag(flags, flag) {
  const list = Array.isArray(flags) ? [...flags] : [];
  if (!list.includes(flag)) list.push(flag);
  return list;
}

function union(a, b) {
  const out = Array.isArray(a) ? [...a] : [];
  for (const item of Array.isArray(b) ? b : []) {
    if (!out.includes(item)) out.push(item);
  }
  return out;
}
