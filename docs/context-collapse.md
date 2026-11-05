# 上下文折叠（context collapse）设计

状态：已实现。与源码的差异见文末。

## 为什么要另一套机制

压缩是破坏性的：一旦触发，`history` 被换成「边界 + 摘要 + 最近一轮」，旧消息从模型可见的上下文里消失，粒度也没了。折叠走另一条路：`history` 永远保留原文，只在每次请求前做一次**读时投影**，把已经折叠的旧轮次换成 `<collapsed>` 占位摘要。原文还在，摘要可以重算，投影也能重放。

## 源码里能确认的部分

公开包里 `CONTEXT_COLLAPSE` 的实现模块是缺失的：`services/contextCollapse/index.js`、`operations.js`、`persist.js` 都在 `README_CN.md` 的「缺失模块说明（108 个模块）」里，编译时被死代码消除，`CtxInspectTool` 也不在包里。能反推的只有调用点、类型和注释：

- `src/query.ts`：每次请求前先 `applyCollapsesIfNeeded`，再走自动压缩；折叠的视图是 `projectView()` 对完整历史的只读投影，摘要消息放在折叠 store，不写回 REPL 数组。
- `src/types/logs.ts:255`：提交记录 `marble-origami-commit`，字段包括 16 位 `collapseId`、`summaryUuid`、完整的 `<collapsed id="...">text</collapsed>`、以及 span 首尾的 `firstArchivedUuid` / `lastArchivedUuid`。
- `src/types/logs.ts:282`：`marble-origami-snapshot` 保存 staged 队列（`startUuid`、`endUuid`、`summary`、`risk`、`stagedAt`）、`armed` 和 `lastSpawnTokens`。
- `src/services/compact/autoCompact.ts:200`：折叠开启时自动压缩被抑制，因为「90% commit / 95% blocking spawn」的阶梯由折叠接管。
- `src/query.ts:1090`：真实 413 先 `recoverFromOverflow` 排空 staged，再回落到 reactive compact；`isWithheldPromptTooLong` 负责把 413 扣住等恢复。
- UI：`TokenWarning` / `ContextVisualization` 显示「x / y summarized」，`/context` 走 `projectView`，resume 时从 `marble-origami-*` 重放。

所以能确认的是**语义**，不是实现。

## 这一轮的设计

目标：

1. 原文不删，投影可重算。
2. 旧轮次按 commit 分批摘要，commit 追加到 `session.jsonl`。
3. 自动在有效窗口 90% 触发，目标折到 80%；95% 时连最近的已结束轮次也允许折。413 时先折叠、再压缩。
4. 终端 `/collapse`，网页「折叠」按钮。
5. 和压缩互斥：折叠开启时不做自动压缩，手动 `/compact` 仍然可用。

明确的非目标（源码有、这里没有）：

- staged 队列和后台 `ctx-agent` spawn。这里同步摘要，没有 staged 状态。
- 跨进程 resume / 从日志重放。`session.jsonl` 只做审计，恢复仍未实现。
- 按 risk 选 span、16 位 collapse id、`ctx_inspect` 工具。
- 按 risk 精细挑 span 的策略。这里按整轮切，自动模式通常保留最近 1 个已结束轮次，95% 时放开。

## 数据模型

`src/agent/collapse.ts`：

```ts
interface CollapseCommit {
  id: string              // c1、c2……
  firstIndex: number      // history 里的闭区间下标
  lastIndex: number
  firstMessageId: string  // 稳定 id，对应源码的 archived uuid
  lastMessageId: string
  summary: string
  tokensBefore: number
  tokensAfter: number
  turns: number
  createdAt: string
}

interface CollapseStore {
  commits: CollapseCommit[]
  nextId: number
  version: number          // 每次提交 +1
  responseVersion: number  // 上一次主请求完成时的 version
  consecutiveFailures: number
}
```

`Message` 增加了可选的 `id`。commit 前用 `ensureMessageIds()` 给缺失的消息补 UUID；provider 不需要这个字段。

## 投影

`projectView(history, commits)` 按 `firstIndex` 排序，把每个 commit 覆盖的区间换成一个 user 消息：

```
<collapsed id="c1">
摘要正文
</collapsed>
```

位置和角色与源码一致；源码把这类消息标成 `isMeta`，不出现在对话视图里，我们则只在发给模型的投影里生成，UI 本来也看不到。commit 越界（history 被压缩替换过）时跳过，不破坏视图。`history` 本身永远不改。

## 选哪些轮次

`planNextSpan()`：

- 只在**完整轮次**的边界切：轮次从一条用户文本开始，到下一条用户文本之前结束。工具调用和它的结果因此不会被拆开。
- 从最早一个尚未提交的完整轮次开始。
- 自动模式通常保留最近 `keepTurns = 1` 个已结束轮次原文；达到 hard（95%）时改为 0，连最近一轮也允许折。手动和溢出模式固定 `keepTurns = 0`，可以折到只剩当前轮。
- 单个 span 最多约 `35% × contextWindow`，避免摘要请求自己超长；一轮就超限时允许单轮成 span，由 413 回落兜底。
- commit 从 0 开始连续排列，后一个从上一个 `lastIndex + 1` 开始。

## 阈值

```text
effective = contextWindow - 20000
start     = effective × 0.90
hard      = effective × 0.95
target    = effective × 0.80
```

默认 128k 时：有效 108k，start 97.2k，hard 102.6k。

估算优先用上一次 API 的 `usage`，只对之后新增的消息做字符估算。但 `usage` 描述的是**提交前**那个视图；`version !== responseVersion` 时改用整段字符估算，避免拿旧用量做错误判断。主请求成功后 `noteCollapseResponse()` 把 `responseVersion` 对齐。

## 摘要

同一个模型，`tools: []`，追加一段折叠专用提示词：保留用户请求、决策及理由、文件路径、命令、错误与修复、未完成任务；目标不超过原段落长度的 15%；只回文本。返回后走 `formatCompactSummary()` 去掉 `<analysis>`，提交为 commit。

## 溢出恢复

主请求抛 `prompt is too long` 时：

1. `mode: 'overflow'`，`keepTurns = 0`，强制折一个 span，重试主请求。
2. 如果还有安全 span，继续折，直到低于 hard；最多 2 次重试。
3. 折不动（单轮太大、summary 自己也 413、没有完整轮次）→ 回落 `compactHistory()`，重置 collapse store，再重试一次。
4. 都失败才把错误交给用户。

`DISABLE_COMPACT` 时不做第 3 步；自动压缩被折叠抑制的只是「主动」路径，413 回落仍然可用。

## 和压缩的关系

- 折叠开启（`AGENT_CONTEXT_COLLAPSE=1`）时，`runAgent` 跳过 `shouldAutoCompact`。这是源码的规则：两套阈值不要互相抢。
- 手动 `/compact` 仍可用；成功后重置 collapse store（旧下标失效）。
- 压缩后 `history` 被替换，commit 的下标和 id 都失效；不清空会让 `projectView` 投影出错。

## 持久化

每个 commit 追加一行到 `.copy-agent/session.jsonl`：

```json
{"ts":"...","collapse":{"id":"c1","firstIndex":0,"lastIndex":1,...}}
```

和消息记录共用一个只追加文件，读的时候按字段区分。下标只对写入进程有效；`firstMessageId` / `lastMessageId` 留给以后做 resume 时按 id 重放。恢复本身不在这一轮。

## 命令与界面

- 终端：`/collapse` 手动折一段；自动折叠打印「正在折叠上下文」「上下文已折叠：N 段，x → y」。
- 网页：右上角「折叠」按钮 → `POST /api/collapse`（202；忙时 409）；状态栏显示「正在折叠上下文」；时间线写 notice。
- `/api/state` 增加 `collapsing` 和 `collapse: { enabled, commits, messages, savedTokens }`。

## 环境变量

```bash
AGENT_CONTEXT_COLLAPSE=1   # 开启
DISABLE_COLLAPSE=1         # 关闭
AGENT_CONTEXT_WINDOW=128000
```

## 测试

`src/agent/collapse.test.ts` 覆盖：阈值、投影、越界 commit、轮次边界、工具对不拆、自动触发、手动强制、溢出排空、413 重试、压缩回落、禁用、旧 usage 失效。

`src/server/session.test.ts` 覆盖：网页手动折叠、notice、下一次请求带占位符。

## 和源码的差异

| 源码 | 这里 |
| --- | --- |
| staged 队列 + 后台 ctx-agent spawn | 同轮同步摘要，无 staged |
| 16 位 collapseId、UUID 双射 | `c1` 递增；消息补 UUID 但只用于审计 |
| 任意 risk 评分 span | 从最早完整轮次起，连续切 |
| 90/95 阶梯 + blocking spawn | 90% 折到 80%，95% 放开最近轮次；413 回压缩 |
| `marble-origami-commit/snapshot` 可 resume | 只追加，不恢复 |
| `/context`、`ctx_inspect`、`x/y summarized` | `/collapse` + 网页按钮 + notice |
| 折叠视图含 `isMeta` 摘要消息 | 只存在于投影，不进 history |

## 已知限制

- 单个超长轮次折不动，仍要靠压缩；这是有意的分工。
- 没有 resume，commit 日志目前只是审计。
- 每轮最多 4 个 commit；极端长会话可能一次折不完，下一轮继续。
- 摘要质量取决于模型；没有像压缩那样做 `<analysis>` 草稿，失败时回落到压缩。