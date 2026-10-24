# dsh-experience-skill

Self-evolving experience plugin for **DeepSeek Harness (DSH)**.

- **One Skill List entry**: `experience-retrieval`（name + description only; body loads on demand）
- **One local tool**: `experience_search`（0 model calls; filters local experiences and returns ≤2 inline）
- **Learning**: trace → Issue/Attempt/Evidence → one batch call per threshold → candidates → two-round observation → gate → active
- **No per-turn summarization**：45min heartbeat only; model is called at most once per batch (plus one retry)

Requires DSH `0.2.x` (session event API) and Node.js >= 22.19.

## Install

In your DSH profile directory (e.g. `~/.dsh/profiles/<profile>`):

1. Add dependency:

```json
{
  "dependencies": {
    "dsh-experience-skill": "^0.1.0"
  }
}
```

2. Add the bundle:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-experience-skill"
      ]
    }
  }
}
```

3. Install and restart DSH:

```bash
pnpm install
# restart DSH Desktop
```

After restart, check:

- Skill List contains only one new entry: `experience-retrieval`;
- `experience_search` is callable and returns `NO_MATCH` on an empty library;
- `$DSH_HOME/experience-skill/` is created (registry, traces, logs, checkpoints).

> `$DSH_HOME` defaults to `~/.dsh`. The plugin never writes into `~/.dsh/skills/`; experiences are not registered as individual skills.

## Privacy and data

Everything is stored locally under `$DSH_HOME/experience-skill/`:

| Data | Content | Retention |
|---|---|---|
| `traces/` | redacted event summaries (no file bodies) | `retentionTraceDays`（默认 90 天，自动清理） |
| `registry.json` | tasks/issues/attempts/evidence/candidates/active experiences | until deleted |
| `logs/` | retrieval/feedback/cost metadata（query 摘要已脱敏） | until deleted |
| `candidates/`, `active/`, `archive/` | rendered Markdown experience files | until deleted |

**Network disclosure**: learning sends a **redacted digest**（goal/symptoms/attempt summaries/evidence excerpts, no full tool output）to the model provider configured in DSH. Retrieval never calls a model. Set `localOnly: true` to disable learning entirely; `captureSubagents: false`（default）skips subagent sessions.

`autoLearn` **defaults to true**: after enough interaction, one batch call may be sent to the configured provider. Daily budgets bound it. Set `autoLearn: false` if you want capture/retrieval only.

## Configuration

Override defaults in your profile patch (`cordis.patch.yml`):

```yaml
- id: experience-skill
  config:
    autoLearn: true                 # 默认 true；false = 只采集/检索
    localOnly: false                # true = 完全不调用模型
    captureSubagents: false         # 不采集 subagent 会话
    maxExtraCallsPerDay: 6
    dailyLearningTokens: 90000
    maxBatchesPerDay: 4
    batchThresholdTurns: 8
    maxRetrievalsPerDay: 12
    dailyRetrievalTokens: 40000
    maxResults: 2
    minScore: 55
    retentionTraceDays: 90
    provider: ''                    # 空 = 会话路由
    model: ''                       # 空 = 会话模型
    reasoningEffort: 'off'
```

## How it works

1. `session/event` captures a whitelisted, redacted trace (0 model calls);
2. 45min heartbeat / turn-end check: incremental trace read, issue correlation, budget gate;
3. If ≥`batchThresholdTurns` new turns and budget allows: one batch call produces candidates with filter terms and evidence refs;
4. Candidate → `observing`；two valid task turns → `pending_review`；gate passes → `active`;
5. Future tasks: Skill List shows one entry; model calls `experience_search`; local scoring returns ≤2 experiences inline (no second model, no temporary skill);
6. `feedback` updates adoption/negative stats; harmful patterns demote active experiences for review.

## Cost defaults

| Operation | Extra model calls |
|---|---:|
| Trace capture / 45min check / correlation / retrieval | 0 |
| One batch of new traces | ≤1（+≤1 retry） |
| Daily learning budget | ≤6 calls / 90k tokens / 4 batches |
| Retrieval budget | ≤12 searches / 40k tokens/day |

All counts are written to `logs/cost.jsonl` and `checkpoints.json`.

## Uninstall / delete data

1. Remove `dsh-experience-skill` from `dsh.profile.bundles` and dependencies;
2. `pnpm install` and restart DSH;
3. Delete `$DSH_HOME/experience-skill/` to remove all local experiences and traces.

## Development

```bash
node --test        # 68 tests, mock ctx/LLM, no DSH required
```

## Limitations

- No CLI in the published package (review/rollback are not shipped yet);
- Retrieval is lexical (CJK grams + exact terms), no embeddings;
- A second DSH window sharing the same `$DSH_HOME` runs **read-only** (lock owner), so its registry view may be stale;
- Session log backfill is not performed; only events after plugin load are captured.

## License

MIT
