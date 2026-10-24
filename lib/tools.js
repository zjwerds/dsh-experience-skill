/**
 * tools.js — experience_search 工具定义（进程内本地检索，0 模型调用）。
 */
import { redact, truncate } from './text.js';
import { renderResults, retrieve } from './retrieve.js';

/** 从会话事件里兜底抽最近错误文本。 */
function recentErrorText(session) {
  try {
    if (session === null || typeof session !== 'object' || typeof session.snapshotEvents !== 'function') return '';
    const events = session.snapshotEvents();
    if (!Array.isArray(events)) return '';
    const parts = [];
    for (let i = events.length - 1; i >= 0 && parts.length < 3; i--) {
      const event = events[i];
      if (event === null || typeof event !== 'object' || event.type !== 'tool/result') continue;
      const message = event.data?.message;
      const isError = message?.isError === true || event.data?.isError === true;
      if (!isError || !Array.isArray(message?.content)) continue;
      const text = message.content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
      if (text.trim() !== '') parts.push(truncate(text, 300));
    }
    return redact(parts.join('\n'), 500);
  } catch {
    return '';
  }
}

/** 统一渲染 search / feedback / 只读错误。 */
function renderToolValue(value, config) {
  if (value !== null && typeof value === 'object' && value.action === 'feedback') {
    if (value.ok === true) return '[experience-search] feedback 已记录（本地统计，无模型调用）。';
    return `[experience-search] feedback 未记录：${value.code ?? 'UNKNOWN'}${value.hint ? `（${value.hint}）` : ''}`;
  }
  if (value !== null && typeof value === 'object' && value.ok === false && typeof value.code === 'string') {
    return `[experience-search] ${value.code}${value.hint ? `：${value.hint}` : ''}`;
  }
  return renderResults(value, config);
}

/**
 * @param {import('./store.js').Store} store
 * @param {object} config
 */
export function createExperienceSearchTool(store, config) {
  return {
    name: 'experience_search',
    description: '本地经验检索（不调用模型）。按问题类型、症状、错误、技术栈、阶段和适用条件筛选已沉淀经验，默认返回 2 条、最多 3 条。action=feedback 时记录采用情况。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'feedback'], description: '默认 search' },
        task: { type: 'string', description: '一句话任务' },
        problem_type: { type: 'string', description: '问题类型枚举' },
        symptoms: { type: 'array', items: { type: 'string' }, description: '现象/症状' },
        technology: { type: 'array', items: { type: 'string' }, description: '技术栈/工具' },
        error_text: { type: 'string', description: '原始错误文本（可截断）' },
        stage: { type: 'string', description: '执行阶段' },
        action_intent: { type: 'string', description: '行动意图' },
        limit: { type: 'integer', minimum: 1, maximum: 3 },
        include_low_confidence: { type: 'boolean' },
        allow_high_risk: { type: 'boolean' },
        retrieval_id: { type: 'string', description: 'feedback 时必填' },
        used: { type: 'array', items: { type: 'string' }, description: '采用的经验 ID' },
        irrelevant: { type: 'array', items: { type: 'string' }, description: '不相关的经验 ID' },
        outcome: { type: 'string', enum: ['improved', 'neutral', 'harmful', 'unknown'] },
        result_signal: { type: 'string', enum: ['objective', 'user', 'model'] },
        note: { type: 'string' },
      },
    },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: renderToolValue(value, config) }],
    },
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {};
      const action = input.action === 'feedback' ? 'feedback' : 'search';
      try {
        if (action === 'feedback') {
          if (store.readOnly === true) {
            return { ok: false, code: 'READ_ONLY', hint: '另一个窗口持有写锁；本次只检索，不记录反馈。' };
          }
          const result = store.recordFeedback({
            retrievalId: typeof input.retrieval_id === 'string' ? input.retrieval_id : '',
            used: Array.isArray(input.used) ? input.used : [],
            irrelevant: Array.isArray(input.irrelevant) ? input.irrelevant : [],
            outcome: typeof input.outcome === 'string' ? input.outcome : 'unknown',
            resultSignal: typeof input.result_signal === 'string' ? input.result_signal : 'model',
            note: typeof input.note === 'string' ? input.note : '',
          });
          return { ok: true, action: 'feedback', changed: result.changed === true };
        }

        const query = {
          task: typeof input.task === 'string' ? input.task : '',
          problem_type: typeof input.problem_type === 'string' ? input.problem_type : '',
          symptoms: Array.isArray(input.symptoms) ? input.symptoms : [],
          technology: Array.isArray(input.technology) ? input.technology : [],
          error_text: typeof input.error_text === 'string' ? input.error_text : '',
          stage: typeof input.stage === 'string' ? input.stage : '',
          action_intent: typeof input.action_intent === 'string' ? input.action_intent : '',
          limit: Number.isInteger(input.limit) ? input.limit : undefined,
          include_low_confidence: input.include_low_confidence === true,
          allow_high_risk: input.allow_high_risk === true,
        };
        if (query.error_text.trim() === '') {
          query.error_text = recentErrorText(exec?.agent?.session);
        }

        const budget = store.reserveRetrieval(config, 700);
        if (budget.allowed !== true) {
          return {
            retrieval_id: null,
            results: [],
            no_match: true,
            budget_exceeded: true,
            hint: '今日检索次数已用完（本地预算）；按正常流程排查，不要编造经验。',
          };
        }
        if (budget.limit !== undefined) {
          query.limit = Math.min(query.limit ?? config.maxResults, budget.limit);
        }

        const startedAt = Date.now();
        const payload = retrieve(store.snapshot(), query, config, { index: store.indexSnapshot() });
        payload.latency_ms = Date.now() - startedAt;
        const resultTokens = payload.results.reduce((sum, item) => sum + Math.ceil([...String(item.strategy ?? '')].length * 0.7) + 80, 0) + 100;
        try { store.adjustRetrievalTokens(resultTokens - 700); } catch { /* 忽略 */ }
        try { store.recordRetrievalStats(payload.results.map((item) => item.id)); } catch { /* 忽略 */ }
        if (budget.reason === 'TOKENS') {
          payload.budget_limited = true;
          payload.hint = '今日检索 token 预算不足，只返回 1 条。' + payload.hint;
        }

        try {
          const loggedQuery = {
            ...payload.query_echo,
            error_text: redact(payload.query_echo?.error_text ?? '', 120),
            symptoms: Array.isArray(payload.query_echo?.symptoms) ? payload.query_echo.symptoms.map((item) => redact(item, 80)) : [],
            technology: Array.isArray(payload.query_echo?.technology) ? payload.query_echo.technology.map((item) => redact(item, 80)) : [],
          };
          store.recordRetrieval({
            ts: Date.now(),
            retrievalId: payload.retrieval_id,
            sessionId: typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : null,
            query: loggedQuery,
            returned: payload.results.map((item) => ({ id: item.id, score: item.score, matched: item.matched })),
            candidatesScored: Array.isArray(store.snapshot().experiences) ? store.snapshot().experiences.length : 0,
            latencyMs: payload.latency_ms,
          });
        } catch {
          // 日志失败不影响检索结果。
        }
        return payload;
      } catch (error) {
        return {
          retrieval_id: null,
          results: [],
          no_match: true,
          error: 'RETRIEVAL_UNAVAILABLE',
          hint: '检索暂时不可用；继续正常排查，不要因此停下或编造经验。',
          detail: error?.code ?? 'INTERNAL',
        };
      }
    },
  };
}
