/**
 * config.js — 配置归一化与默认值。
 * 目标：所有预算/阈值都有硬编码默认值，patch 行可按需覆盖；非法值回退默认。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULTS = Object.freeze({
  enabled: true,
  dataDir: '',

  // 检索
  maxResults: 2,
  maxResultChars: 1200,
  minScore: 55,
  requireActive: true,
  allowHighRisk: false,
  includeLowConfidence: false,
  maxRetrievalsPerDay: 12,
  dailyRetrievalTokens: 40000,

  // 调度（心跳本身不调用模型）
  scheduleIntervalMs: 45 * 60 * 1000,
  batchThresholdTurns: 8,
  maxIssuesPerBatch: 8,
  minBatchGapMs: 45 * 60 * 1000,
  maxBatchesPerDay: 4,
  maxExtraCallsPerDay: 6,
  maxInputTokensPerBatch: 8000,
  maxOutputTokensPerBatch: 3000,
  maxRetries: 1,
  timeoutMs: 120000,
  provider: '',
  model: '',
  reasoningEffort: 'off',
  localOnly: false,
  autoLearn: true,
  captureSubagents: false,

  // 生命周期
  requiredCleanRounds: 2,
  observationMaxDays: 14,
  resetCap: 3,

  // 数据
  retentionTraceDays: 90,
  candidateBacklogLimit: 200,

  // 安全/日志
  guardMode: 'balanced',
  debug: false,
});

const NUMBER_FIELDS = new Set([
  'maxResults', 'maxResultChars', 'minScore', 'scheduleIntervalMs',
  'batchThresholdTurns', 'maxIssuesPerBatch', 'minBatchGapMs', 'maxBatchesPerDay',
  'maxExtraCallsPerDay', 'maxInputTokensPerBatch', 'maxOutputTokensPerBatch',
  'maxRetries', 'timeoutMs', 'requiredCleanRounds', 'observationMaxDays',
  'resetCap', 'retentionTraceDays', 'candidateBacklogLimit',
  'maxRetrievalsPerDay', 'dailyRetrievalTokens',
]);

const BOOLEAN_FIELDS = new Set([
  'enabled', 'requireActive', 'allowHighRisk', 'includeLowConfidence',
  'localOnly', 'debug', 'autoLearn', 'captureSubagents',
]);

const STRING_FIELDS = new Set([
  'dataDir', 'provider', 'model', 'reasoningEffort', 'guardMode',
]);

/**
 * 合并默认值并做类型/范围校验。
 * @param {object|null|undefined} raw
 * @returns {object}
 */
export function resolveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(source)) {
    if (!(key in DEFAULTS)) continue;
    if (NUMBER_FIELDS.has(key)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        config[key] = value;
      }
      continue;
    }
    if (BOOLEAN_FIELDS.has(key)) {
      if (typeof value === 'boolean') config[key] = value;
      continue;
    }
    if (STRING_FIELDS.has(key)) {
      if (typeof value === 'string') config[key] = value;
      continue;
    }
  }
  config.maxResults = clampInt(config.maxResults, 1, 3);
  config.minScore = clampInt(config.minScore, 0, 100);
  config.maxResultChars = clampInt(config.maxResultChars, 200, 4000);
  config.maxOutputTokensPerBatch = clampInt(config.maxOutputTokensPerBatch, 256, 16000);
  config.maxInputTokensPerBatch = clampInt(config.maxInputTokensPerBatch, 512, 64000);
  if (!['off', 'low', 'medium', 'high', 'max'].includes(config.reasoningEffort)) {
    config.reasoningEffort = 'off';
  }
  if (!['balanced', 'strict', 'off'].includes(config.guardMode)) {
    config.guardMode = 'balanced';
  }
  return config;
}

/**
 * 解析数据目录：config.dataDir > $DSH_HOME/experience-skill > ~/.dsh/experience-skill。
 * @param {object} config
 * @returns {string}
 */
export function resolveDataDir(config) {
  if (typeof config.dataDir === 'string' && config.dataDir.trim() !== '') {
    return config.dataDir.trim();
  }
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home.trim() !== '') {
    return join(home.trim(), 'experience-skill');
  }
  return join(homedir(), '.dsh', 'experience-skill');
}

function clampInt(value, min, max) {
  const n = Math.round(value);
  return Math.min(max, Math.max(min, n));
}
