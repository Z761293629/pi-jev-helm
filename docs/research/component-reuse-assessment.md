# pi-jev-router V1 组件复用评估

- 对应 issue：[#4 评估 pi-router 与 pi-typesafe 的可复用边界](https://github.com/Z761293629/pi-jev-helm/issues/4)
- 研究日期：2026-09-18（UTC）
- 方法：只检查项目自身的 GitHub 仓库源码、README、tag/release，以及 Pi 官方仓库；未使用第三方文章、聚合站或搜索摘要作为证据。
- 结论适用边界：OpenRouter Jev Provider、Task Classification、确定性 Routing Policy、Pi 单请求模型路由。Safety Gate、Verifier、多 Agent、多 Provider failover、发布均不在 V1。

## 结论先行

1. **V1 不应直接依赖 `pi-router`、`pi-typesafe`、现有 `pi-jev-router`、`pi-jev-auto-mode` 或 `pi-warden`。** 前三者分别把“分类”绑定到直接 Route、TypeSafe 直连协议、Vercel Gateway/会话 pin；后两者是 V1 明确排除的 Safety/Verifier 体系。它们都没有提供恰好覆盖 V1 四层边界的稳定库入口。
2. **唯一建议直接依赖的是 Pi 的公开扩展 API**（正常的 `@earendil-works/pi-coding-agent` peer dependency）。`before_agent_start`、`agent_settled`、`ctx.modelRegistry`、`pi.setModel()`、`pi.setThinkingLevel()`、`pi.appendEntry()` 和 UI 状态 API 是 V1 Pi 适配层的首选拼装点；但 Pi 没有“仅下一请求使用某模型”的原子 API，恢复与 queued follow-up 隔离仍需 issue #6 原型证明。
3. **`pi-typesafe` 最值得摘取的是协议设计，而不是 transport/auth 代码**：Choice/Score/Noul 的 typed question 思路、完整响应再校验、有限错误分类、超时/取消、可注入 transport、never-throw 调用结果。这些可指导 OpenRouter Jev Provider 的接口，但其客户端固定直连 `api.typesafe.ai`，会绕开 OpenRouter 和 Pi 的认证边界。
4. **`pi-router` 最值得摘取的是 Pi 接入与测试形状**：在 `before_agent_start` 前置判断、按 Pi registry 校验候选模型、尊重 scoped models、记录不进入模型上下文的决策、严格配置校验、模型不可用/认证失败测试。不要复用其“分类器直接返回 Route + ranking”或跨候选自动降级；二者分别破坏 Classification/Policy 分层和 V1 的“无多 Provider failover”边界。
5. **现有 `mejiasd3v/pi-jev-router` 是最接近的 Jev 路由先例，但只能摘取测试和适配设计。** 它通过 Vercel AI Gateway、把模型与 thinking 合并成一次 Choice、按会话 pin 并持续 monitor；这些都与 OpenRouter、独立 Task Classification、确定性 Policy、单请求恢复冲突。
6. **失败语义应是 V1 自己的窄契约**：Provider 的 timeout/aborted/http/connection/malformed/invalid-classification 返回可判别失败；low-confidence 则是合法 Classification 经 Policy 得出的 keep-current。Router 对两类情况都 fail-open，保持调用前模型并继续。不要带入 `pi-router` 的 ranked model fallback，也不要带入安全项目的 fail-closed。

## 权威仓库确认与研究快照

“pi-router”不是唯一仓库名；以下选择依据是仓库内 package manifest 的 `repository` 字段与项目 README，而非名称猜测。

| 项目 | 确认的权威仓库与依据 | 本次源码快照 | License | 维护/发布状态（截至研究日） |
|---|---|---|---|---|
| Pi | [`earendil-works/pi`](https://github.com/earendil-works/pi)；Pi 官方扩展文档和 runtime 源码同仓 | [`46c9de4`](https://github.com/earendil-works/pi/commit/46c9de402bddf46b03c3b9f46487b777aaa41861) | [MIT](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/LICENSE) | 活跃；最近正式 release 为 [`v0.85.1`](https://github.com/earendil-works/pi/releases/tag/v0.85.1)，研究快照在该 release 之后 |
| pi-router | [`ygncode/pi-router`](https://github.com/ygncode/pi-router)；manifest 声明 npm 包 `@ygncode/pi-model-router` 并把 repository 指向该仓库（[证据](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/package.json#L2-L12)） | [`cdbba6f`](https://github.com/ygncode/pi-router/commit/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2) | [MIT](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/LICENSE) | pre-1.0；最新 tag/release [`v0.2.0`](https://github.com/ygncode/pi-router/releases/tag/v0.2.0)，之后仍有修复提交 |
| pi-typesafe | [`DevMortimer/pi-typesafe`](https://github.com/DevMortimer/pi-typesafe)；manifest 的包名与 repository 一致（[证据](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/package.json#L2-L13)） | [`dfb9b0d`](https://github.com/DevMortimer/pi-typesafe/commit/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82) / [`v0.5.0`](https://github.com/DevMortimer/pi-typesafe/tree/v0.5.0) | [MIT](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/LICENSE) | 新且活跃、pre-1.0；公开 API 明确仍在扩展，版本约束要求 Pi `>=0.85.1 <1`（[manifest](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/package.json#L66-L83)） |
| 现有同名 Jev router（相关先例） | [`mejiasd3v/pi-jev-router`](https://github.com/mejiasd3v/pi-jev-router)；manifest 指向该仓库（[证据](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/package.json#L2-L12)） | [`db058e1`](https://github.com/mejiasd3v/pi-jev-router/commit/db058e1625733c8ca41f737995e8812f495349ad) / [`v0.1.2`](https://github.com/mejiasd3v/pi-jev-router/releases/tag/v0.1.2) | [MIT](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/LICENSE) | 很新、pre-1.0；有成功 CI 的 `v0.1.2` release |
| pi-jev-auto-mode（边界反例） | [`jomatsu/pi-jev-auto-mode`](https://github.com/jomatsu/pi-jev-auto-mode)；manifest 指向该仓库（[证据](https://github.com/jomatsu/pi-jev-auto-mode/blob/06a56043088124ed650471a8589fddd8139708f4/package.json#L2-L25)） | [`06a5604`](https://github.com/jomatsu/pi-jev-auto-mode/commit/06a56043088124ed650471a8589fddd8139708f4) / [`v0.4.1`](https://github.com/jomatsu/pi-jev-auto-mode/releases/tag/v0.4.1) | [MIT](https://github.com/jomatsu/pi-jev-auto-mode/blob/06a56043088124ed650471a8589fddd8139708f4/LICENSE) | 活跃、pre-1.0；安全 gate 产品，不是 router |
| pi-warden（边界反例） | [`DevMortimer/pi-warden`](https://github.com/DevMortimer/pi-warden)；manifest 指向该仓库并依赖 `pi-typesafe`（[证据](https://github.com/DevMortimer/pi-warden/blob/c523080c5729a07c2564a1bcee9ebc769af5fdb0/package.json#L2-L13)，[依赖](https://github.com/DevMortimer/pi-warden/blob/c523080c5729a07c2564a1bcee9ebc769af5fdb0/package.json#L82-L86)） | [`c523080`](https://github.com/DevMortimer/pi-warden/commit/c523080c5729a07c2564a1bcee9ebc769af5fdb0)；最近发布 tag [`v0.19.0`](https://github.com/DevMortimer/pi-warden/tree/v0.19.0) | [MIT](https://github.com/DevMortimer/pi-warden/blob/c523080c5729a07c2564a1bcee9ebc769af5fdb0/LICENSE) | 活跃、pre-1.0；多 guard/Verifier/子 agent 能力明显超出 V1 |

> 许可证注意：这些项目都是 MIT，允许复制/修改，但复制“实质性代码”时仍须保留版权与许可声明。下文多数建议是“摘取设计并在 V1 的边界内重写”；这样也能避免被 pre-1.0 API 与无关依赖锁住。

## 总体采用矩阵

| 组件/能力 | 来源 | 接口契合度 | License / 维护状态 | 建议 | 核心理由 |
|---|---|---:|---|---|---|
| Pi lifecycle + model registry + model switch | Pi 官方 API | 高 | MIT；活跃，最近 release `v0.85.1` | **直接依赖** | 是目标宿主的公开 API；提供前置路由与 settled 后恢复的首选 hook，仍需原型验证 |
| 通用 LLM route classifier | pi-router | 低 | MIT；活跃、pre-1.0 (`v0.2.0`) | **摘取设计** | 直接输出 Route/ranking，未保留独立 Task Classification |
| registry/scoped-model/decision-log 接入 | pi-router | 中高 | 同上 | **摘取设计与测试** | 与 Pi 接口匹配，但源码是单体 extension，无库 export，且不恢复基线模型 |
| TypeSafe typed questions 与 response validation | pi-typesafe | 中高 | MIT；新且活跃、pre-1.0 (`v0.5.0`) | **摘取设计** | Classification 很适合 Choice；transport/auth 固定直连 TypeSafe，不符合 OpenRouter |
| pi-typesafe client/auth/ledger/batching | pi-typesafe | 低 | 同上 | **不采用** | 引入第二凭证库、第二账本、直连 endpoint 和无关 batching/calibration runtime |
| Jev Choice 路由、候选筛选、下游 stream 透传 | 现有 pi-jev-router | 中 | MIT；很新、pre-1.0 (`v0.1.2`) | **摘取测试设计** | Jev/Pi 经验直接相关，但 Gateway、session pin、monitor 和模型直选均冲突 |
| ranked route/model fallback | pi-router | 低 | MIT；活跃、pre-1.0 | **不采用** | V1 fail-open 应保持当前模型；不做多 Provider failover |
| Safety gate 的 transport/error parser | pi-jev-auto-mode | 低 | MIT；活跃、pre-1.0 (`v0.4.1`) | **仅摘取失败分类观念** | direct TypeSafe + fail-closed，与 Router fail-open 相反 |
| rules/slop/done/subagent guard | pi-warden | 无 | MIT；活跃、pre-1.0 (`v0.19.0`) | **不采用** | 正是 V1 排除的 Safety Gate、Verifier、多 Agent 范围 |

## 按组件评估

### 1. OpenRouter Jev Provider

#### 可复用内容

**从 Pi 直接复用公开宿主能力：**

- `ctx.modelRegistry` 暴露模型、provider 与认证；官方文档要求使用 registry 的 `streamSimple()`/`stream()` 来获得 provider 注册与认证解析，而不是绕过 registry 调 `pi-ai/compat`（[Pi extensions 文档](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/docs/extensions.md#L1018-L1033)）。
- Pi 已有 OpenRouter provider 和 `OPENROUTER_API_KEY` 映射（[官方 env key 源码](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/ai/src/env-api-keys.ts#L86-L97)），其 OpenAI-compatible transport 也原生识别 OpenRouter reasoning/session-affinity（[官方 transport](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/ai/src/api/openai-completions.ts#L1591-L1670)）。这意味着 **凭证与基础 HTTP/provider 适配应优先留在 Pi**，不要再造独立 key store。

**从 pi-typesafe 摘取协议设计：**

- 将类别表达为 Choice，并把 chosen key、每个 option 的概率和 confidence 视为分类结果；README 明确区分 Choice/Score/Noul，并警告 confidence 不是正确性证明（[README](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/README.md#L24-L56)）。
- 在边界上验证 request 和完整 response，而不是因 HTTP 200 就信任结果。`pi-typesafe` 会检查 model、usage、答案数量、问题类型、概率范围和 choice key（[client](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/client.ts#L89-L115)），并把入参统一经过 normalize/JSON-safe/schema/byte-limit admission（[schema](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/schema.ts#L105-L153)）。
- 采用窄错误码和取消/超时合并。其 public error taxonomy 是 `configuration | validation | budget | aborted | timeout | http | connection | response`（[errors](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/errors.ts#L1-L31)）；`ask()` 合并 caller signal 与 deadline，并返回 `{ok:false}` 而不是把异常扩散给路由层（[ask](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/ask.ts#L25-L42)）。

#### 不应直接复用

- `pi-typesafe` 的 client **硬编码** `https://api.typesafe.ai`、默认 `jev-latest` 且禁用 SDK retry（[client](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/client.ts#L131-L160)）。直接依赖会把 V1 的“OpenRouter Jev Provider”替换成 TypeSafe 直连 Provider，并带入自己的登录文件、认证状态、usage ledger、日预算和 batching。
- `pi-jev-auto-mode` 同样直接包装官方 TypeSafe SDK，并把超时/网络/HTTP 转成 Safety verdict（[transport](https://github.com/jomatsu/pi-jev-auto-mode/blob/06a56043088124ed650471a8589fddd8139708f4/src/jev/transport.ts#L11-L47)，[client construction](https://github.com/jomatsu/pi-jev-auto-mode/blob/06a56043088124ed650471a8589fddd8139708f4/src/jev/transport.ts#L89-L116)）；endpoint 与 fail-closed 责任都不适合 V1 Router。
- 现有 `mejiasd3v/pi-jev-router` 用 Vercel AI Gateway 的 `evaluationModel("typesafe-ai/jev")`（[源码](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L249-L270)），不是 OpenRouter。其 AI SDK、Zod runtime dependencies 也只为这条 Gateway 路径服务（[manifest](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/package.json#L34-L39)）。
- 当前 Pi 快照的生成 OpenRouter catalog **没有 Jev/TypeSafe 条目**（[`openrouter.models.ts`](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/ai/src/providers/openrouter.models.ts)）。因此不能在 issue #3/#5 的协议与真实 API 探针完成前，假定 `modelRegistry.find("openrouter", <jev-id>)` 必然可用，也不能把“Pi 有 OpenRouter transport”误写成“Pi 已提供 Jev evaluation adapter”。

#### 接口契合度与采用方式

- **契合度：中。** Pi 的 OpenRouter auth/transport 高契合；现有 Jev clients 的 endpoint 和响应协议低契合。
- **建议：直接依赖 Pi registry/auth；摘取 pi-typesafe 的 typed/validation/error 设计；不依赖 pi-typesafe 或 Vercel router runtime。**
- Provider 对 Router 暴露的 V1 最小语义应是“一条当前用户消息 → 一个经校验的 Task Classification 或 typed failure”，不要暴露 SDK client、key store、batching、Safety verdict 或 Route。

### 2. Task Classification

#### 可复用内容

- `pi-typesafe` 的 Choice 非常接近 V1 分类：固定 criteria key、选择结果、全量概率与 confidence。其 schema 对 question id、Choice criteria 数量、JSON safety 和最大字节数均有边界（[schema](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/schema.ts#L10-L57)）。**摘取这一输出形状**，把 `fast/coding/reasoning/research` 以外的分类字段保持模型无关。
- `pi-router` 的 parser 展示了必须覆盖的 malformed cases：从意外 Markdown 中提取 JSON、验证 route、去重 ranking、补齐缺项、clamp confidence、限制 reason（[parser](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/router.ts#L61-L99)）；相应 tests 覆盖合法、fenced JSON、重复 ranking、越界 confidence 和非法 route（[tests](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/test/router.test.ts#L5-L37)）。其中“防御性解析与固定样例”可直接转化为 V1 测试思想。

#### 边界冲突

- `pi-router` 的 `ClassifierDecision` 就是 `{route, ranking, confidence, reason}`（[types](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/types.ts#L41-L46)）。分类器知道 route 名、模型配置、当前 route 和 cost/quality policy（[prompt builder](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/router.ts#L30-L58)），所以不是独立的 Task Classification。照搬会让模型而非确定性 Policy 决定路由。
- 现有 Jev router 更进一步，把候选 `target + thinking` 组合成 Choice profile，一次直接选模型和 effort（[profiles 与 Choice](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L213-L268)）。这绕过了 V1 的 Classification → deterministic Policy seam。
- pi-typesafe 的“宽松 near-miss normalization”是 agent tool 友好设计，但 Provider 内部固定构造的请求不需要接受 `options/levels/choices` 等别名。V1 应严格生成、严格验证，避免无意扩大协议面。

#### 接口契合度与采用方式

- **契合度：pi-typesafe 的概念高；pi-router/现有 Jev router 的成品接口低。**
- **建议：摘取设计，不直接依赖。** 定义 V1 自有 `TaskClassification`，保留类别、概率/置信度、短理由和 Provider 元数据；不包含 Route、模型 ID、thinking level、fallback ranking 或 Safety verdict。
- 固定黄金样例与 parser contract tests 可仿照 pi-router 的测试组织，但类别与失败期望必须来自 issue #7 的最终契约。

### 3. 确定性 Routing Policy

#### 可复用内容

- `pi-router` 将 route→`{provider, model, thinkingLevel}` 配置显式化（[types](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/types.ts#L1-L39)），并在选择前检查 scoped models、available catalog、model lookup、图像能力与认证（[apply loop](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L290-L333)）。这些检查顺序和 mock harness 值得摘取。
- 对低 confidence 保持当前 route 的思路与 V1 fail-open 相容（[源码](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L274-L288)）。但 V1 应把该判断放进纯 Policy，并明确“低于阈值 = 不切换”，而不是修改模型返回的 ranking。
- 严格拒绝未知 config key、错误类型与越界数字，比静默默认更适合路由配置（[config](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/config.ts#L96-L203)，[tests](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/test/router.test.ts#L62-L78)）。原子写文件并保留其他 key 的模式也可摘取（[config write](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/config.ts#L232-L267)）。

#### 不应复用

- Route 词汇不匹配：pi-router 是 `fast/balanced/frontier/efficient`，V1 是 `fast/coding/reasoning/research`。
- `decision.ranking` 驱动逐模型尝试，模型不可用或切换失败就尝试下一 Route（[源码](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L297-L332)）。这会把“分类排序”和“故障 failover”混为一体；V1 要求错误时保留当前模型，不做多 Provider failover。
- `fallbackRoute` 在 classifier 失败时可能主动切换到配置 fallback（[源码](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L259-L272)）。V1 的 fail-open 责任应是 **不切换**，因此不能照搬。
- pi-router 支持 trusted project config 覆盖 global config（[README](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/README.md#L113-L166)），而 V1 只使用用户级配置。
- 现有 Jev router 配置直接把模型作为 Jev criteria，并在 route 失败时使用固定 fallback；它没有独立 Classification/Policy 类型（[config/selection](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L38-L67)，[fallback](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L228-L241)）。

#### 接口契合度与采用方式

- **契合度：中。** Route config 与 Pi capability checks 契合；分类直达 Route、ranking/fallback 不契合。
- **建议：摘取设计和测试，不直接依赖。** Policy 应是纯函数：`TaskClassification + user route config + current model + optional manual override → RouteDecision | keep-current`。Provider 错误不进入 Policy；Pi 模型可用性失败也归 adapter fail-open，不触发另一 Provider/Route。

### 4. 故障处理

#### 建议复用的观念

- **完整响应再校验。** `pi-typesafe` 与 `pi-jev-auto-mode` 都把缺 key、错误类型、非有限概率和 `[0,1]` 越界视为 malformed（[pi-typesafe](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/client.ts#L89-L115)，[auto-mode parser](https://github.com/jomatsu/pi-jev-auto-mode/blob/06a56043088124ed650471a8589fddd8139708f4/src/jev/response.ts#L37-L65)）。
- **不泄露 upstream body/state。** `pi-typesafe` 把 SDK 错误映射为固定安全消息（[errors](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/src/errors.ts#L17-L31)）；现有 Jev router 也只暴露 HTTP status/固定原因，不把 Gateway body 写入通知或 session（[catch/fallback](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L271-L290)）。
- **取消优先。** Provider/adapter 必须把 caller abort 与普通失败区分；取消后不能 pin/写入一条成功决策。现有 Jev router 的 tests 专门断言 evaluation/auth 取消后不推理、不持久化 pin（[tests](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.test.mjs#L454-L484)）。
- **离线 transport 测试。** pi-typesafe 允许注入 fetch（[API docs](https://github.com/DevMortimer/pi-typesafe/blob/dfb9b0d3cfcf3c49daffbd01ca1eb4b77fb97f82/docs/api.md#L9-L35)）；各相关项目均用 mock transport 覆盖失败分支。V1 Provider 也应可注入 transport/clock，不依赖付费 API 完成 contract tests。

#### 不应复用的故障策略

- pi-router 的 classifier 失败后使用当前 route **或配置 fallbackRoute**，随后还会遍历 ranking（[源码](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L259-L332)）；V1 只接受前半句“保留当前模型”。
- pi-jev-auto-mode 的“unavailable 必须 block”是 Safety Gate 的 fail-closed（[design](https://github.com/jomatsu/pi-jev-auto-mode/blob/06a56043088124ed650471a8589fddd8139708f4/docs/design.md#L16-L56)）；Router 的目标是继续用户请求，语义相反。
- 现有 Jev router 对 timeout 最多进行 3 次 evaluation attempt（[常量与循环](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L21-L24)，[循环](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L249-L279)）。这会把最坏前置延迟放大三倍；issue #8/#5 尚未用真实 OpenRouter 行为决定 retry，因此 V1 不应预先继承该常量。

#### V1 建议语义

| 故障 | Provider 结果 | Router 行为 |
|---|---|---|
| 配置/凭证缺失 | typed `configuration`/`auth` failure | 保持当前模型，简短 warning，继续 |
| timeout / connection / HTTP | typed failure（HTTP 仅保留 status/类别） | 保持当前模型，继续；retry 由 issue #8 基于探针决定 |
| caller aborted | typed cancelled 或重新抛出控制流（接口需统一） | 不记录成功、不切换；跟随 Pi 取消 |
| malformed/缺字段/越界概率/未知类别 | typed response/classification failure | 保持当前模型，继续 |
| confidence 不足 | 合法 classification，但 Policy 返回 keep-current | 不是 Provider error；记录 low-confidence 原因，继续 |
| 目标模型不存在/未认证/不在 scope/不支持输入 | adapter selection failure | 保持或恢复 baseline；不尝试另一 Provider/Route |

### 5. Pi 单请求模型路由

#### 可直接复用的 Pi API

- `before_agent_start` 在用户提交 prompt 后、agent loop 前触发，提供展开后的 `event.prompt` 与 images（[官方 lifecycle](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/docs/extensions.md#L280-L319)，[event 文档](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/docs/extensions.md#L530-L565)）。它是读取“仅当前用户消息”并在主请求前路由的正确 hook。
- `agent_settled` 保证当前 agent run 已无自动 retry、compaction retry 或 queued continuation（[文档](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/docs/extensions.md#L568-L583)，[event type](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/src/core/extensions/types.ts#L738-L743)）。它比 `agent_end` 更适合恢复 baseline。
- `pi.setModel(model)` 是公开 API，但语义是“设置当前 session 模型”，会写 session history；恢复也会再写一次 model change（[官方文档](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/docs/extensions.md#L1724-L1742)，[runtime 源码](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/src/core/agent-session.ts#L1747-L1771)）。因此它是实现单请求切换/恢复的候选机制，但不是原子 request override，能否严格隔离 follow-up 需由 issue #6 验证。
- `pi.appendEntry()` 可保存不进入 LLM context 的路由决策（[官方文档](https://github.com/earendil-works/pi/blob/46c9de402bddf46b03c3b9f46487b777aaa41861/packages/coding-agent/docs/extensions.md#L1500-L1520)）。

#### 可摘取的项目设计

- pi-router 已验证 `before_agent_start → classify → modelRegistry availability/auth → pi.setModel` 的基本链路（[源码](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L191-L245)，[hook](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L463-L470)）。其 extension test harness mock events、registry、provider、setModel、appendEntry 与通知，适合作为 V1 adapter 测试模板（[tests](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/test/extension.test.ts#L20-L108)）。
- 现有 Jev router 的 custom provider 会把完整 context/options/auth/usage/stream events 透传到实际目标 provider，并测试 model identity 与 credentials 不泄露（[dispatch](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L317-L376)，[测试](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.test.mjs#L113-L151)）。若生命周期原型证明 set/restore 不可靠，这是一条可研究的替代设计，但不是 V1 首选。

#### 不能直接复用的部分

- pi-router 从不在请求结束后恢复用户基线模型；其 `lastRoute/lastModel` 只用于 status/log（[设置](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L334-L362)）。直接装包不能满足“只影响当前请求”。
- 现有 Jev router 明确“pin once，stay pinned”，并把 pin 写进 session entry、在 reload/resume 恢复（[README](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/README.md#L70-L83)，[持久化](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L337-L345)）。这是会话路由，不是单请求路由。
- custom provider wrapper 还承担 context-window/maxTokens 动态伪装、stream event forwarding、deferred generation 拒绝、pin/monitor 恢复等职责。V1 在公共 `setModel` + lifecycle 可行时引入它，会显著加深与 Pi provider internals 的耦合。

#### 接口契合度与采用方式

- **契合度：Pi API 高；两个 router 的完整实现低到中。**
- **建议：直接依赖 Pi 公共 API，摘取 router 测试 harness；不直接依赖任一 router。**
- issue #6 原型应验证最小状态机：idle 时捕获 baseline model + thinking；`before_agent_start` 成功分类与 Policy 后切换；`agent_settled` 仅在当前仍是本次 routed model 时恢复 baseline，防止覆盖中途明确的用户切换；classifier/selection 失败则从不离开 baseline。还应覆盖 reload/shutdown/abort 和 queued follow-up。

### 6. 配置、UI 与决策记录

#### 可摘取

- pi-router 的 `/router on|off|use|auto|status`、footer status、简短通知和 `appendEntry` 结构对应 V1 的开关、单次手动覆盖、简短结果与完整原因入口（[commands](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L370-L461)，[decision entry](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/index.ts#L334-L362)）。
- 其 `/router off` 只改 `enabled` 且保留其他 JSON key、采用临时文件后 rename 的写法，适合用户级配置（[config](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/src/config.ts#L232-L267)）。
- 现有 Jev router 将完整 route telemetry 放进 non-context custom entry、status 只显示简短 pin/来源/耗时/估算成本（[源码](https://github.com/mejiasd3v/pi-jev-router/blob/db058e1625733c8ca41f737995e8812f495349ad/index.ts#L281-L301)），这种“展示与持久化分层”可复用。

#### 不采用

- project config、session pin、monitor、自动 thinking 选择、日预算面板、TypeSafe login/store 都不属于 V1 当前边界。
- 不复制 pi-router 默认模型/route 性能假设；其 README 自己明确默认分配未 benchmark（[README](https://github.com/ygncode/pi-router/blob/cdbba6fac5bf2e90ca6383ddccebcd951d7d1bd2/README.md#L45-L72)）。

### 7. pi-jev-auto-mode 与 pi-warden：为何暂不复用

#### pi-jev-auto-mode

- 它是 `tool_call` Safety Gate，先确定性 hard deny/allow，再 Jev 判断，且 unavailable 不能成为批准（[design](https://github.com/jomatsu/pi-jev-auto-mode/blob/06a56043088124ed650471a8589fddd8139708f4/docs/design.md#L16-L56)）。V1 明确不含 Safety Gate，且 Router 必须 fail-open；直接复用会把相反的风险责任引入核心。
- 可保留为未来 Safety 地图的参考：transport failure taxonomy、response re-validation、离线 fixture/calibration 与 decision record 都有价值，但不进入 V1 runtime dependency。

#### pi-warden

- README 列出的 rules、slop、stuck、done-check、security、runaway、subagent triage 等，横跨 Safety Gate、Verifier 和多 Agent（[README](https://github.com/DevMortimer/pi-warden/blob/c523080c5729a07c2564a1bcee9ebc769af5fdb0/README.md#L16-L48)）。这不是可裁剪的“轻量 router helper”。
- 它的 library seam 是“任何有 pi-typesafe `evaluate` 的 judge”，并依赖 `pi-typesafe`（[extension-author docs](https://github.com/DevMortimer/pi-warden/blob/c523080c5729a07c2564a1bcee9ebc769af5fdb0/docs/extension-authors.md#L1-L26)）。采用它会同时带入 TypeSafe direct provider 与 guard domain model。
- **建议：V1 不采用。** 等 Safety Gate/Verifier 各自建立后续决策地图时再独立评估；不要为“以后可能用”预埋依赖或通用 guard 抽象。

## 推荐的 V1 复用边界

### 直接依赖

1. `@earendil-works/pi-coding-agent` 的公开 extension types/runtime API。
2. Pi 自有 model registry/auth/provider transport（是否足以承载 OpenRouter Jev 的真实响应，由 issue #3/#5 探针确认）。

### 摘取设计（在本项目内形成窄接口与测试，不绑定上游实现）

1. **pi-typesafe**：Choice 分类形状、概率/confidence 语义、request/response validation、safe error taxonomy、deadline + caller abort、injectable transport。
2. **pi-router**：strict config、`before_agent_start` 接入、model registry/scope/capability checks、status + non-context decision entry、extension mock harness。
3. **现有 pi-jev-router**：Jev choice fixture、abort/auth/privacy tests、下游 provider 透传 tests；仅当 issue #6 证明 set/restore 不够时，再研究 custom provider dispatch seam。
4. **pi-jev-auto-mode**：只摘取“HTTP 成功不等于有效答案”和安全错误信息的测试思想。

### 不采用

1. pi-typesafe direct client/key store/usage ledger/batching/calibration runtime。
2. pi-router 的 direct-route classifier、ranking、fallbackRoute、project config 与多候选自动 fallback。
3. 现有 pi-jev-router 的 Vercel Gateway、session pin、monitor、model+thinking 联合选择、custom provider wrapper（除非原型推翻首选方案）。
4. pi-jev-auto-mode 与 pi-warden 的 gate/verifier/agent 编排实现。
5. 任一项目的默认模型能力、价格或 route 排名假设。

## 对后续决策 issue 的约束

- **#5 OpenRouter Jev 探针**：必须确认 Pi OpenRouter transport 能否表达 Jev 请求并保留 typed answers；若不能，Provider 才需要自有 OpenRouter HTTP adapter。不要用 pi-typesafe direct endpoint 或 Vercel Gateway 代替该验证。
- **#6 单请求切换原型**：以 `before_agent_start + agent_settled + setModel` 为首选，验证 model/thinking baseline 恢复、取消、retry/compaction、follow-up、reload 与用户中途切换。仅在失败后考虑 custom provider dispatch。
- **#7 Classification**：输出不得含 Route/model/thinking/fallback ranking；用 Choice 概率与 confidence 驱动固定类别契约。
- **#8 Provider/失败语义**：借鉴 typed failures，但 Router 一律 fail-open；retry 数量不得从相关项目默认继承。
- **#9 Policy**：实现纯 deterministic mapping；明确决定 manual override、valid high-confidence classification 与 keep-current 的优先级，而不是继承任一上游的 pin/ranking 规则。模型不可用不触发另一 Provider。
- **#10 UX**：可借鉴 pi-router 命令和 non-context entries，但只做用户级配置与单次 override。

## 最终判断

V1 的最佳路径不是“选一个上游 router 作为底座”，而是：**Pi 公共 API 直接接入 + 从三个项目摘取经过测试的窄设计 + 保持四层边界由本项目拥有。** 这样可复用成熟的失败校验、Pi hook 和测试方式，同时避免把 OpenRouter Provider 替换成 TypeSafe/Vercel、把 Task Classification 压扁成直接模型选择、把 fail-open 扩张成 ranked failover，或提前引入 Safety/Verifier/多 Agent。
