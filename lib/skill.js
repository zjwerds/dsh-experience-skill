/**
 * skill.js — 唯一 Skill List 入口的静态内容。
 * 名字用英文（已确认）；description 与正文用中文，只在模型主动调用 skill 时返回正文。
 */

export const SKILL_NAME = 'experience-retrieval';

export const SKILL_DESCRIPTION = '查询已沉淀的 Agent 经验（经验检索）。当前任务涉及具体错误、测试失败、工具异常、重复尝试无进展，或需要复用历史解决策略时调用。通过本地脚本按问题类型、症状、工具、环境和适用条件检索，只返回少量相关经验。无可靠匹配时返回无匹配结果，不得强行套用经验。';

export const ENTRY_BODY = `# experience-retrieval（经验检索）

用于在遇到具体问题时查询本机沉淀的经验。经验是「历史假设」，不是结论。

## 何时调用
- 出现明确错误、异常、测试失败、工具连续失败或无进展；
- 需要复用过去的排查路径/修复步骤；
- 任务进入调试、恢复、迁移、部署排错阶段。

## 怎么调用
调用工具 experience_search，尽量填：
- task：一句话任务
- problem_type：tool_call_failure/db_migration/dependency_conflict/network/permission/context_loss/repeat_call/build/test/performance
- symptoms：看到的现象（数组）
- technology：技术栈/工具（数组）
- error_text：原始错误文本（可截断）
- stage：planning/coding/testing/audit/deploy/recovery/review/debug
- action_intent：locate_root_cause/restore_execution/verify_fix/check_dependency/reduce_retry/rollback

运行时已自动补充环境、最近错误和工具名；缺失字段留空，不要编造。
若已明确参数，可直接调用 experience_search，无需先加载本技能正文。

## 怎么用结果
1. 先看「适用条件」和「风险」；不满足就忽略，不要硬套。
2. 经验只是候选策略；以当前证据（日志、测试、命令输出）为准。
3. 若采用了某条经验，任务结束时调用 experience_search(action="feedback", retrieval_id=..., used=[...], outcome="improved|neutral|harmful")。
4. 无匹配（NO_MATCH）时按正常流程排查，不要因为"没有经验"而停下或编造经验。
5. 检索失败时继续正常工作，不要重试超过 1 次。`;
