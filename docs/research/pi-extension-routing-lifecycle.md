# Pi 扩展的请求路由、模型切换与恢复生命周期

> 针对 [Z761293629/pi-jev-helm#2](https://github.com/Z761293629/pi-jev-helm/issues/2) 的 AFK research。

## 结论先行

1. **透明读取请求的稳定入口有两个。** `input` 读取技能/模板展开前的原始文本、图片、来源和排队方式；`before_agent_start` 读取展开后的 prompt，但只走空闲态启动的新 agent run。扩展命令先于 `input` 被分派，匹配到命令时 `input` 不触发。`message_start` 和 `context` 也能观察用户消息，但它们不是安全的“为本次调用选模型”拦截点。[^input-doc][^prompt-impl][^message-context-doc]
2. **选模型和切模型都有公开扩展 API。** 用 `ctx.modelRegistry.find()` / `getAvailable()` 或 `ctx.scopedModels` 选候选，用 `await pi.setModel(model)` 切换；`ctx.model` 是当前模型。`pi.setModel` 只改当前 session，不改新 session 的默认模型；它校验认证、写入 `model_change`、调整 thinking level，并发出 `model_select`。[^model-context][^set-model-doc][^set-model-impl][^registry-type]
3. **没有公开的 request-scoped model override / push-pop / compare-and-restore API。** “保存旧模型，再调用两次 `pi.setModel`”是公开 API 的组合，不是原子事务；恢复 thinking level 也要单独保存并调用 `pi.setThinkingLevel()`。官方 `preset.ts` 示例采用同样的快照/恢复思路。[^extension-api-type][^preset-example]
4. **仅对空闲态提交、且运行期间没有新排队消息时，可可靠近似“只给当前请求切换并恢复”。** 在 `input`（原始文本路由）或 `before_agent_start`（展开后文本路由）切到目标模型，保持该模型覆盖整个工具循环、自动重试与 overflow compaction/retry，最后在 `agent_settled` 恢复。不能在 `turn_end` 或 `agent_end` 就恢复，因为 Pi 之后仍可能继续工具回合、自动重试、自动压缩重试或排队 continuation。[^lifecycle-doc][^settlement-impl]
5. **严格的“每条用户消息”隔离目前做不到，尤其是 mid-stream `steer` / `followUp`。** streaming 输入在 `input` 后立即入队并直接返回，不再触发 `before_agent_start`；下一回合的模型快照发生在排队消息的 `message_start` 之前。若在 `input` 立即切换，可能影响当前请求尚未结束的后续工具回合；若等 `message_start`，又已经晚于模型快照。要严格支持排队消息，需要新增公开的 request/continuation 边界与 request-scoped 模型覆盖，或者依赖/修改内部 `Agent.prepareNextTurnWithContext` 等接口。[^prompt-impl][^next-turn-refresh][^agent-loop-impl]
6. **状态展示有稳定 API。** `ctx.ui.setStatus(key, text)` 持久显示、传 `undefined` 清除；`notify` 适合瞬时提示。应在 `session_start` 用 `ctx.model` 初始化，在 `model_select` 和路由状态变化时更新。TUI 直接显示；RPC 发 `extension_ui_request`；JSON/print 中 UI 方法无效果。[^status-api][^mode-doc][^rpc-ui]
7. **文档与 v0.85.1 实现存在一个重要偏差。** 文档和类型声明说 session restore 会发 `model_select { source: "restore" }`，但已安装实现仅在显式 set/cycle 调用 `_emitModelSelect`；session 模型在扩展绑定和 `session_start` 前已恢复，没有 restore 事件。上游 `v0.85.1` 源码也相同。因此状态初始化必须依靠 `session_start + ctx.model`，不能只等 `model_select("restore")`。[^model-select-doc][^model-select-type][^restore-impl][^bind-impl][^upstream-restore]

## 研究基线与来源

本结论以本机安装的 `@earendil-works/pi-coding-agent` **0.85.1** 为基线；包声明其官方仓库为 `earendil-works/pi`，对应官方 tag `v0.85.1` 的 commit 为 [`d981de1229ef899957bbe968bc8dcda02a21f477`](https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477)。本地文档、示例、`.d.ts` 与编译实现均来自同一安装包。[^package]

下文路径缩写：

- `$PI` = `/Users/z/.local/share/mise/installs/node/24.0.0/lib/node_modules/@earendil-works/pi-coding-agent`
- `$CORE` = `$PI/node_modules/@earendil-works/pi-agent-core`

只使用以下一手来源：上述本机 Pi README、docs、examples、安装包类型/实现，以及固定到官方 release commit 的上游 TypeScript 源码。

## 1. 实际事件顺序与可用信息

### 1.1 空闲态提交一条普通 prompt

按 v0.85.1 实现，精确顺序是：

1. 若文本命中扩展 slash command，直接运行 command handler 并结束这次 `prompt()`；否则继续。[^prompt-impl]
2. `input` 收到原始文本和图片；多个 handler 的 transform 按加载顺序串联，`handled` 短路。[^input-doc][^input-runner]
3. 技能命令和 prompt template 展开。[^prompt-impl]
4. 当前模型认证检查，以及上一响应可能触发的 pre-prompt compaction。[^prompt-impl]
5. 构造用户消息，然后调用 `before_agent_start`，其 `event.prompt` 是展开后的文本。[^before-agent-doc][^prompt-impl]
6. `AgentSession` 调用 `agent.prompt()`；`Agent` 此时从 `state.model`、thinking level、tools 和 messages 创建本次 loop 的快照。也就是说，在 `input` 或 `before_agent_start` 中 `await pi.setModel()` 仍赶得上本次首个 provider call。[^prompt-impl][^agent-config]
7. agent-core 实际发出 `agent_start → turn_start → user message_start → user message_end`，随后 `context` 转换、provider 请求和 assistant 流事件；有工具时继续多个 turn。[^agent-loop-start][^provider-boundary]
8. 一个低层 run 的 `agent_end` 之后，`AgentSession` 还会处理自动 retry、overflow compaction/retry 和在 `agent_end` handler 内新排入的消息；全部结束后才发 `agent_settled`。[^settlement-impl]

官方生命周期图给出了同样的宏观阶段，但把 message/turn 画成概览；精确的 `turn_start` 与初始 user `message_start` 先后应以上述 agent-core 实现为准。[^lifecycle-doc][^agent-loop-start]

### 1.2 streaming 时提交 `steer` / `followUp`

`input` 仍会触发，并通过 `event.streamingBehavior` 告知 `"steer"` 或 `"followUp"`；之后文本展开并入队，函数在进入模型校验、消息构造和 `before_agent_start` 之前返回。因此排队消息没有独立的 `before_agent_start`。[^input-doc][^prompt-impl]

下一回合开始时，agent-loop 先调用 `prepareNextTurn` 取得新的 `model` / thinking / context 快照，再发排队 user message 的 `message_start`，最后发 provider 请求。Pi 的 `AgentSession` 内部 `prepareNextTurnWithContext` 会从当时的 `agent.state.model` 读取模型。[^next-turn-refresh][^agent-loop-impl]

**推论：**

- 在 streaming `input` 中立刻 `pi.setModel(target)`，目标模型可能被下一次 `prepareNextTurn` 取走；但“下一次”可能仍是原请求的工具结果续写，而不是刚排入的 follow-up。
- 到排队 user `message_start` 再切模型已经太晚，因为该回合模型已在 `prepareNextTurn` 中快照。
- 扩展公开上下文只有 `hasPendingMessages(): boolean`，没有可关联 request id 的队列读取/消费事件，所以无法稳定地把某次 `input` 决策与某个 continuation 边界绑定。[^extension-context-type]

## 2. 哪些事件能读取“用户请求”

| 事件/入口 | 能看到什么 | 是否适合路由当前主请求 | 边界 |
|---|---|---|---|
| 扩展 command handler | `/command` 后的 `args` | **适合显式命令式路由**：handler 可先切模型，再自行触发消息 | 命中后跳过 `input`；不是透明路由所有请求。[^input-doc][^prompt-impl] |
| `input` | 原始 `text`、图片、`source`、`streamingBehavior` | **空闲态最佳入口**，切换发生在认证、compaction、模型快照之前 | 技能/模板尚未展开；streaming 时只应记录/拒绝路由，直接切换有串扰风险。[^input-doc][^prompt-impl] |
| `before_agent_start` | 展开后的 `prompt`、图片、system prompt/options | **空闲态可用**，且仍早于 Agent 模型快照 | streaming 排队消息不触发；pre-prompt compaction 已按旧模型运行，因此目标模型 context window 不同会有边界风险。[^before-agent-doc][^prompt-impl] |
| user `message_start` / `message_end` | 初始和排队的实际 user message | 观察、审计可以；**不应作为首个调用路由点** | 初始 run 的 config 已在事件前创建；排队 continuation 的 `prepareNextTurn` 也早于事件。[^message-context-doc][^agent-config][^agent-loop-impl] |
| `context` | 每次 LLM call 前完整消息深拷贝 | 可识别最近请求、改消息；**不能选模型** | 公开返回值只有 `{ messages }`，调用模型已在 loop config 中确定。[^message-context-doc][^provider-boundary] |
| `before_provider_request` | provider-specific 序列化 payload | 适合诊断/改 payload；**不适合跨 provider/model 路由** | hook 在 payload 构造后；文档明确主要用于 provider 序列化和 cache 调试。只改 payload 中的 `model` 也不会同步 Pi 的 provider/auth/context-window/usage/session 状态。[^provider-hook-doc][^provider-boundary] |

## 3. 模型能力：稳定 API 与内部接口

### 3.1 稳定、文档化的扩展 API

| 能力 | 精确 API | 语义 |
|---|---|---|
| 读当前模型 | `ctx.model` | 动态 getter，返回当前 `Model | undefined`。[^extension-context-type][^lazy-context] |
| 枚举/定位模型 | `ctx.modelRegistry.getAvailable()`、`.find(provider, modelId)` | `ModelRegistry` 是明确暴露给扩展的 compatibility facade；`ctx.scopedModels` 用于复刻内置 scoped picker 范围。[^registry-type][^model-context] |
| 切换当前 session 模型 | `await pi.setModel(model): Promise<boolean>` | 无认证时 `false`；成功时更新 active model，追加 `model_change`，按目标能力调整 thinking，并发 `model_select`；不改变新 session 默认值。[^set-model-doc][^set-model-impl][^extension-api-type] |
| 读/改 thinking | `pi.getThinkingLevel()` / `pi.setThinkingLevel(level)`，或读 `ctx.thinkingLevel` | 切模型会按设置选择并 clamp thinking；若要精确恢复旧状态，需单独保存/恢复 thinking。[^set-model-doc][^set-model-impl] |
| 监听模型变化 | `pi.on("model_select", handler)` | 事件含 `model`、`previousModel`、`source`；适合状态同步，不是可取消/改写的 before hook。[^model-select-doc][^model-select-type] |
| 生命周期恢复点 | `pi.on("agent_settled", handler)` | 没有自动 retry、compaction retry 或 queued continuation 时触发；用于状态 integration 和 best-effort 恢复。[^before-agent-doc][^settlement-impl] |
| 状态展示 | `ctx.ui.setStatus(key, text)`、`ctx.ui.notify(...)` | status 持久到显式清除；notify 瞬时。[^status-api] |
| 独立模型调用 | `ctx.modelRegistry.complete(model, context, options)` | 可调用指定模型做分类/辅助工作，但不会把当前 agent 的下一次主请求重路由到该模型。[^registry-type] |
| 自定义 router provider | `pi.registerProvider(...)` / custom `streamSimple` | API 稳定，可由扩展完全拥有 transport/routing；但 active model 仍是注册的 router model，后端真实模型的认证、序列化、usage/错误归因和 UI 需 provider 自己负责，不等同于临时切换 Pi 内建模型。[^provider-api] |

`pi.setModel` 的扩展包装层先以 `hasConfiguredAuth` 检查认证，再调用 session 的 `setModel`；session 实现会异步 `checkAuth`，写 session 记录并发事件。[^set-model-binding][^set-model-impl]

### 3.2 不是扩展稳定 API，或不应依赖的做法

| 做法 | 状态 | 原因 |
|---|---|---|
| `ctx.session` / `ctx.agent` / 直接改 `agent.state.model` | **扩展不可用；内部接口** | `ExtensionContext` 类型不暴露 `AgentSession` 或 `Agent`。SDK 的 `session.agent` 是 SDK 面向宿主的能力，不是扩展契约。[^extension-context-type][^sdk-agent] |
| 改写 `Agent.prepareNextTurnWithContext` | **内部接口** | Pi 自己通过该 hook 在 turn 间刷新 model/tools/context；它未暴露到 `ExtensionAPI`。严格排队消息路由若 monkey-patch 此处，会耦合 agent-core 实现。[^next-turn-refresh][^agent-config] |
| 调用 `AgentSession.setModel(model, { persist })` 或 `cycleModel()` | **SDK/内部层，不是扩展 API** | 扩展只得到无 options 的 `pi.setModel`; `persist` 和 `cycleModel` 属于 `AgentSession`。[^agent-session-type][^extension-api-type] |
| 在 `before_provider_request` 改 payload.model | **hook 稳定，但做模型路由不稳定/不完整** | payload 是 provider-specific `unknown`，此时 provider、认证和 stream 函数已由 `config.model` 选择。[^provider-hook-doc][^provider-boundary] |
| 只依赖 `model_select.source === "restore"` | **当前不可靠** | 类型和文档存在该值，但 v0.85.1 没有实现 restore 发射路径。[^model-select-doc][^model-select-type][^restore-impl] |

## 4. “仅当前请求切换并恢复”的可达结论

### 4.1 可支持的受限语义

在下列约束同时成立时，可以只用稳定 API 做**受限实现**：

- 只路由 `ctx.isIdle() === true` 的新 prompt；遇到 `event.streamingBehavior` 非空的输入不临时切模型。
- 路由判定在 `input` 完成（需要展开后文本时才退而使用 `before_agent_start`）。
- 快照至少包含原 `Model` 和原 thinking level。
- 目标模型保持到 `agent_settled`，这样工具调用后的续写、transient retry、overflow compaction/retry 都仍使用目标模型。
- `agent_settled` 中先确认没有用户/其他扩展的显式模型变更需要保留，再恢复旧模型和旧 thinking；无论正常、错误或 abort 都走清理。
- `session_start` 初始化状态，`model_select` 只负责后续变化。

这些约束分别由 idle/queue 语义、`pi.setModel`/thinking API、`agent_settled` 保证和 restore-event 缺口决定。[^input-doc][^set-model-doc][^lifecycle-doc][^restore-impl]

### 4.2 为什么不是严格 request scope

Pi 的公开扩展 API 没有“本请求使用模型 X”的参数，也没有返回 disposer/token 的 model scope。每次 `pi.setModel` 都立即改变 session active model，并追加持久化 `model_change`；恢复只是第二次 session model change。[^set-model-doc][^set-model-impl]

同时，`agent_settled` 的语义覆盖 queued continuation；因此运行中进入的 steering/follow-up 会在恢复前被处理，继承临时模型。反过来，提前在 `agent_end` 恢复会让随后的 retry/compaction continuation 使用旧模型。[^lifecycle-doc][^settlement-impl]

所以 issue 中若“当前请求”意指**一次空闲态提交及其全部自动 continuation**，稳定 API 足够做受限实现；若意指**每条 user message（包括 steering/follow-up）都独立路由且绝不污染相邻消息**，当前扩展 API 不足，需要 Pi 新增公开生命周期/覆盖接口，或由 SDK 宿主串行化输入并在 `try/finally` 中控制 `AgentSession.setModel()`。SDK 文档确认 `AgentSession.prompt()`、`setModel()` 和 `agent` 可供嵌入宿主直接控制，但这些不自动成为 ExtensionContext 能力。[^sdk-session][^agent-session-type]

### 4.3 推荐的上游 API 形状（研究结论，不是实现）

最小可行的稳定接口应满足以下之一：

- `before_llm_request` 返回 `{ model?, thinkingLevel? }`，该覆盖只作用于当前 provider call；或
- `before_user_request` / `user_request_settled` 携带稳定 request id，并允许 `{ model }` request scope；或
- `withModel(model, fn)` / `pushModelOverride(...) -> dispose()`，由 core 处理 retry、工具 continuation、abort、queue 和用户显式改模冲突。

仅增加“更多通知事件”不够；模型必须在 agent-core 创建/刷新 loop config 时由 core 原子读取，否则仍有 snapshot 时序竞态。该判断来自当前 `createLoopConfig` 与 `prepareNextTurn` 的实际读取位置。[^agent-config][^agent-loop-impl]

## 5. session 恢复与 `model_select("restore")` 偏差

session 记录中 `model_change` 是一等 entry；`buildSessionContext()` 沿当前 branch 扫描，后出现的 `model_change` 或 assistant message 决定恢复模型。成功的临时切换和恢复各写一条 model change，因此正常恢复后重启 session 会回到最后恢复的模型。[^session-format][^session-settings-impl]

创建 `AgentSession` 时，SDK 先调用 `buildSessionContext()` 并恢复 model，再构造 session；扩展直到之后的 `bindExtensions()` 才收到 `session_start`。在 v0.85.1 中 `_emitModelSelect` 只有 `set` 与 `cycle` 调用点，没有 `restore` 调用点。[^restore-impl][^bind-impl][^set-model-impl]

这与文档、示例和类型中公开的 `source: "restore"` 冲突。官方 release tag 的 TypeScript 也显示：restore 在 `sdk.ts` 先完成，而 `agent-session.ts` 的 `_emitModelSelect` 仅由 set/cycle 调用。[^model-select-doc][^model-status-example][^model-select-type][^upstream-restore]

**稳妥策略：** 在每次 `session_start` 都读取 `ctx.model` 并重建 status；把 `model_select` 当作 session 启动后的增量通知。若未来 Pi 补上 restore 事件，这一策略仍兼容。

## 6. 状态展示建议与模式边界

建议至少展示三态：

- `default: provider/model`
- `routed: provider/model (baseline: provider/model)`
- `restore failed` 或 `routing skipped: queued input`

使用固定 status key 调 `ctx.ui.setStatus` 可覆盖而不是累加；恢复完成后显示 baseline 或清除。Pi 的官方 model-status 示例正是在 `model_select` 中更新 status，TUI 文档也把 `setStatus` 定义为持久 footer indicator。[^model-status-example][^status-api][^tui-status]

模式边界：

- TUI：status 在 footer/status bar 直接显示。
- RPC：`setStatus` 是 fire-and-forget `extension_ui_request`，客户端可显示或忽略。
- JSON / print：扩展仍运行，但 UI 方法是 no-op；不能把 UI 当作恢复逻辑的一部分。

这些模式行为由扩展文档和 RPC UI 协议明确规定。[^mode-doc][^rpc-ui]

## 7. 主要风险

1. **排队消息串扰（高）**：`steer` / `followUp` 没有独立 `before_agent_start`，且 model snapshot 早于排队 user `message_start`。严格透明路由不可保证。[^prompt-impl][^agent-loop-impl]
2. **用户显式改模被覆盖（高）**：临时路由期间，用户或其他扩展可能调用 `/model` / `pi.setModel`。`model_select.source` 只有 `set|cycle|restore`，没有 actor/request token；自动恢复可能错误覆盖用户的新选择。扩展只能用自身 in-flight 标记做 best-effort 冲突检测。[^model-select-type][^model-select-doc]
3. **`before_agent_start` 太晚于 pre-prompt compaction（中）**：目标模型 context window 与旧模型不同，Pi 已经按旧模型决定是否 compact。需要准确 context-window 行为时优先在空闲 `input` 切换。[^prompt-impl]
4. **恢复也写 session 历史（中）**：每次 route/restore 产生 model-change entries，并可能产生 thinking-level entries；这是公开 API 的既定语义，不是临时内存覆盖。[^set-model-doc][^set-model-impl][^session-format]
5. **部分失败（中）**：目标切换成功后，恢复时认证状态可能变化；扩展包装层可能返回 `false`，session 的二次认证检查也可能抛错。必须留下错误 status/notify，不能静默假设恢复成功。[^set-model-doc][^set-model-binding][^set-model-impl]
6. **thinking 不对称（中）**：切模型会按目标模型配置重新选/clamp thinking；只恢复 Model 不保证回到原 thinking level。[^set-model-impl][^set-model-doc]
7. **restore 事件文档漂移（中）**：只监听 `model_select("restore")` 会让 resume 后 status 未初始化。[^restore-impl]
8. **扩展顺序（低到中）**：`input` transform 和 `before_agent_start` handler 都按 extension load order 串联；后加载扩展可能基于已变更文本/模型继续处理。[^input-runner][^before-agent-runner]
9. **低层 payload 路由失配（高）**：改 `before_provider_request` payload 可能让 provider 实际模型名与 Pi 计费、context window、能力和 session attribution 不一致。[^provider-hook-doc][^provider-boundary]

## 8. 可验证的后续原型建议

不要直接做产品扩展；先做一个一次性、可删除的 integration prototype，使用两个 fake provider/model（A/B）、确定性响应和请求日志，验证如下矩阵：

| 场景 | 预期断言 |
|---|---|
| 空闲普通 prompt 命中路由 | 首次 provider request 使用 B；`agent_settled` 后 `ctx.model` 为 A；session 最后一条 `model_change` 为 A。 |
| 未命中路由 | 全程 A；不产生多余 route/restore model changes。 |
| B 产生工具调用 | 工具后的下一次 provider request仍为 B，最终 settled 后才恢复 A。 |
| B 首次返回 retryable error | 自动 retry 仍为 B；不能在第一个 `agent_end` 恢复。 |
| B 触发 overflow compaction/retry | compaction/retry 后的主调用仍为 B；settled 后 A。 |
| abort / provider error / tool error | 无论结束路径如何，都执行 best-effort 恢复并清 status；恢复失败显式报错。 |
| streaming 时排入 steer | 证明 `input` 有 `streamingBehavior="steer"`、但没有 `before_agent_start`；确认立即 setModel 是否污染当前工具 continuation。 |
| streaming 时排入 followUp | 证明 follow-up 在 `agent_settled` 前运行并继承 B，从而把“严格每条消息隔离”标为不支持。 |
| 临时路由期间用户显式 `/model C` | 原型必须选择并验证冲突政策：不覆盖 C，或明确提示；不能静默恢复 A。 |
| resume 现有 session | 证明先收到 `session_start` 且 `ctx.model` 已恢复；记录当前版本没有 `model_select(source="restore")`。 |
| TUI / RPC / JSON / print | TUI status 可见；RPC 收到 `setStatus` request；JSON/print 不依赖 UI 完成状态机。 |

记录每个事件的单调序号、event type、`ctx.model`、thinking level、request id（fake provider 自建）、queue mode 和 session entries；测试断言应以 provider 实际收到的 model 为准，而不是只看 footer。事件顺序与 provider 边界应对照 agent-loop 的 config snapshot、`prepareNextTurn` 和 `streamFunction(config.model, ...)` 三处。[^agent-config][^agent-loop-impl][^provider-boundary]

原型通过后，建议把 scope 明确写进产品决策：

- **Phase 1（仅稳定 API）**：只支持 idle prompt，运行中输入不路由；`agent_settled` 恢复；公开限制 queued messages。
- **Phase 2（若必须严格每条消息）**：先向 Pi 上游请求 request-scoped model override / request-id lifecycle，不 monkey-patch agent-core。

## 9. 能力分级摘要

| 能力 | 结论 |
|---|---|
| 读取原始请求 | 稳定：`input` |
| 读取展开后请求 | 稳定：`before_agent_start`，但仅非 streaming 新 run |
| 观察排队用户消息 | 稳定：user `message_start/end`，但不适合作为切模边界 |
| 列举/查找模型 | 稳定：`ctx.modelRegistry`、`ctx.scopedModels` |
| 切换 active model | 稳定：`pi.setModel` |
| 恢复旧 model/thinking | 稳定 API 的手工组合；非原子、非 request-scoped |
| 在 retry/tool loop 后恢复 | 稳定：等 `agent_settled` |
| 严格隔离 steering/follow-up | 不支持；需要新的 core API/内部接口 |
| 展示状态 | 稳定：`setStatus` / `notify`；有模式差异 |
| session resume 初始化 | 稳定：`session_start + ctx.model` |
| 依赖 `model_select("restore")` | v0.85.1 不可靠（文档/类型与实现不一致） |
| 直接改 provider payload 路由 | 不建议；provider-specific 且状态失配 |

---

## 引用

[^package]: `$PI/package.json:2-3,105-109`；官方 release commit [`d981de1`](https://github.com/earendil-works/pi/commit/d981de1229ef899957bbe968bc8dcda02a21f477)。
[^lifecycle-doc]: `$PI/docs/extensions.md:275-348`。
[^input-doc]: `$PI/docs/extensions.md:909-958`；`$PI/dist/core/extensions/types.d.ts:654-677`。
[^prompt-impl]: `$PI/dist/core/agent-session.js:830-949`；官方 TypeScript：[`agent-session.ts#L1174-L1300`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1174-L1300)。
[^input-runner]: `$PI/dist/core/extensions/runner.js:973-1008`。
[^before-agent-doc]: `$PI/docs/extensions.md:530-580`；`$PI/dist/core/extensions/types.d.ts:538-562`。
[^before-agent-runner]: `$PI/dist/core/extensions/runner.js:881-934`。
[^message-context-doc]: `$PI/docs/extensions.md:615-685`。
[^agent-config]: `$CORE/dist/agent.js:270-320`；官方 TypeScript：[`agent.ts#L409-L478`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent.ts#L409-L478)。
[^agent-loop-start]: `$CORE/dist/agent-loop.js:43-55`；官方 TypeScript：[`agent-loop.ts#L104-L119`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L104-L119)。
[^agent-loop-impl]: `$CORE/dist/agent-loop.js:80-122`；官方 TypeScript：[`agent-loop.ts#L165-L217`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L165-L217)。
[^provider-boundary]: `$CORE/dist/agent-loop.js:172-196`；官方 TypeScript：[`agent-loop.ts#L287-L312`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/agent-loop.ts#L287-L312)。
[^next-turn-refresh]: `$PI/dist/core/agent-session.js:288-307`；官方 TypeScript：[`agent-session.ts#L562-L582`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L562-L582)。
[^settlement-impl]: `$PI/dist/core/agent-session.js:768-810,347-355`；官方 TypeScript：[`agent-session.ts#L1118-L1160`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1118-L1160)、[`agent-session.ts#L629-L640`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L629-L640)。
[^extension-context-type]: `$PI/dist/core/extensions/types.d.ts:215-248`。
[^lazy-context]: `$PI/dist/core/extensions/runner.js:498-547`。
[^model-context]: `$PI/docs/extensions.md:1013-1017`。
[^registry-type]: `$PI/dist/core/model-registry.d.ts:16-43`。
[^set-model-doc]: `$PI/docs/extensions.md:1704-1727`。
[^set-model-impl]: `$PI/dist/core/agent-session.js:1238-1270`；官方 TypeScript：[`agent-session.ts#L1638-L1677`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1638-L1677)。
[^set-model-binding]: `$PI/dist/core/agent-session.js:2045-2057`。
[^extension-api-type]: `$PI/dist/core/extensions/types.d.ts:905-942,1002-1013`。
[^preset-example]: `$PI/examples/extensions/preset.ts:101-129,136-149,274-280,330-336`。
[^model-select-doc]: `$PI/docs/extensions.md:740-759`。
[^model-select-type]: `$PI/dist/core/extensions/types.d.ts:630-637,937-938`。
[^restore-impl]: `$PI/dist/core/sdk.js:80-107,239-258`；`$PI/dist/core/agent-session.js:1238-1270`。
[^bind-impl]: `$PI/dist/core/agent-session.js:1906-1927`。
[^upstream-restore]: 官方 v0.85.1 TypeScript：[`sdk.ts#L193-L213`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/sdk.ts#L193-L213)、[`agent-session.ts#L1638-L1677`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1638-L1677)、[`types.ts#L827-L835`](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/extensions/types.ts#L827-L835)。
[^model-status-example]: `$PI/examples/extensions/model-status.ts:1-30`。
[^provider-hook-doc]: `$PI/docs/extensions.md:675-736`。
[^provider-api]: `$PI/docs/custom-provider.md:1-74,109-170,369-458`；`$PI/docs/extensions.md:1737-1855`。
[^status-api]: `$PI/dist/core/extensions/types.d.ts:70-105`；`$PI/docs/extensions.md:2586-2615`。
[^tui-status]: `$PI/docs/tui.md:766-777`。
[^mode-doc]: `$PI/docs/extensions.md:2928-2937`。
[^rpc-ui]: `$PI/docs/rpc.md:1184-1205,1293-1307`。
[^session-format]: `$PI/docs/session-format.md:213-221,332-341,403-430`。
[^session-settings-impl]: `$PI/dist/core/session-manager.js:146-160,228-236`。
[^sdk-agent]: `$PI/docs/sdk.md:176-213`。
[^agent-session-type]: `$PI/dist/core/agent-session.d.ts:446-480`。
[^sdk-session]: `$PI/docs/sdk.md:34-76,112-176`。
