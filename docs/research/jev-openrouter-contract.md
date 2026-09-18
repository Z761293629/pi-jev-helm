# Jev × OpenRouter 协议与可用性研究

- 关联问题：[issue #3](https://github.com/Z761293629/pi-jev-helm/issues/3)
- 后续实测：[issue #5](https://github.com/Z761293629/pi-jev-helm/issues/5)
- 资料观察时间：2026-09-18 07:48 UTC
- 范围：OpenRouter 官方文档、官方 API 元数据、官方 SDK 源码，以及 TypeSafe/Jev 官方文档与法律页面。
- 实测边界：**本研究没有使用 API key，也没有发起任何真实或付费推理调用**。只读取公开文档、官方源码和无需鉴权的目录/元数据 API。因此下文严格区分“文档确认”“API 元数据观察”和“尚未实测”。

## 结论摘要

1. OpenRouter 上当前公开的 Jev 请求标识是固定版 `typesafe/jev-1.13` 和滚动别名 `~typesafe/jev-latest`；后者当前指向前者。TypeSafe 直连侧的对应上游模型是 `jev-1.13.0`，直连别名是 `jev-latest` / `jev-preview`。这些命名空间不能混用。
2. Jev 在 OpenRouter 上不是普通聊天补全模型。应调用实验性专用端点 `POST https://openrouter.ai/api/alpha/decisions`，以 Bearer key 鉴权，提交 `model`、`state`、`questions`；不要把 `state/questions` 塞进 `/api/v1/chat/completions`。
3. Jev 的“结构化输出”是固定的 Decisions 原语：`noul`、`choice`、`score`。它不是任意 JSON Schema 生成。当前模型元数据的 `supported_parameters` 是空数组，故没有证据表明 Jev 支持聊天接口的 `response_format/json_schema`。
4. OpenRouter 官方 SDK 合同允许结构化（string/object/array）`instructions` 与 criteria；但当前公开 `openapi.json` 对同一字段仍写成纯 string，存在一手资料漂移，必须由 issue #5 验证真实网关行为。
5. OpenRouter 目录报 32K context；TypeSafe 直连文档报“每请求 64K，且 state + 最长问题 32K”。两者不能合并成一个保证；经 OpenRouter 的有效边界尚未实测。
6. OpenRouter 没有发布 Jev 专属 RPM/TPS 数字。`per_request_limits: null` 只表示目录中没有该限制对象，不应解释为无限。TypeSafe 直连公布的 250,000 tokens/s、1,200 requests/minute 且会动态调整，也不自动成为 OpenRouter 配额。
7. OpenRouter 当前把 TypeSafe Jev endpoint 列为 ZDR，元数据为不训练、不保留 prompt；OpenRouter 自身默认也不保存 prompt/response，但始终保留非内容元数据，并存在匿名分类说明。隐私承诺应按“OpenRouter 层 + 上游 endpoint 层 + 可选日志/插件”分别审查。

---

## 1. 当前模型标识

### 文档确认

TypeSafe 直连模型文档写明：

> “Jev 1.13 `jev-1.13.0`”
>
> “`jev-latest` → `jev-1.13.0`”
>
> “`jev-preview` → `jev-1.13.0`”

并说明滚动别名会移动，若阈值是针对固定模型调过的，应固定版本号。来源：[TypeSafe Models](https://docs.typesafe.ai/models.md)。

OpenRouter 模型页把公开模型显示为：

> `typesafe/jev-1.13`
>
> “Jev 1.13 accepts text as input and returns structured decisions.”

来源：[OpenRouter — TypeSafe: Jev 1.13](https://openrouter.ai/typesafe/jev-1.13)。

### API 元数据观察

公开目录查询 [`GET /api/v1/models?output_modalities=decisions`](https://openrouter.ai/api/v1/models?output_modalities=decisions) 在观察时返回两项：

| 用途 | 请求时应使用的 `model` | 观察到的补充元数据 |
|---|---|---|
| 固定版 | `typesafe/jev-1.13` | `canonical_slug: typesafe/jev-1.13-20260917` |
| 滚动别名 | `~typesafe/jev-latest` | `alias_target.slug: typesafe/jev-1.13` |

同一元数据把两者都标为 `text->decisions`、`context_length: 32000`。固定版的 endpoint 记录见 [`/api/v1/models/typesafe/jev-1.13/endpoints`](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)。

OpenRouter Models 文档说明默认目录只返回 text-output 模型：

> “Default (text models only)”

来源：[OpenRouter Models](https://openrouter.ai/docs/guides/overview/models.md#output_modalities)。所以普通 `GET /api/v1/models` 中看不到 Jev 不代表 Jev 不可用；应按 `decisions`（当前 API 实际接受，但文档枚举尚未列出）或 `all` 查询。

### 不应混淆的名字

- OpenRouter 请求 ID：`typesafe/jev-1.13`、`~typesafe/jev-latest`。
- OpenRouter 永久目录 slug：`typesafe/jev-1.13-20260917`。目录文档称 `canonical_slug` 为 “Permanent slug for the model that never changes”，但本研究**没有验证**它是否也可直接用于 Decisions 请求。
- TypeSafe 直连 ID：`jev-1.13.0`、`jev-latest`、`jev-preview`。

### 尚未实测

- `~typesafe/jev-latest` 是否在响应 `model` 中保留别名，还是返回固定 OpenRouter slug / 上游 `jev-1.13.0`。
- `typesafe/jev-1.13-20260917` 是否可作为请求 ID。
- 别名升级时结果、概率阈值和费用是否会变化。

---

## 2. 端点与鉴权

### OpenRouter 文档/源码确认

OpenRouter 官方 Python SDK 将操作描述为：

> “Submit a Decisions (questions and answers) request”
>
> “Submits a Decisions request to the Decisions router”

来源：[OpenRouter Python SDK — Alpha.Decisions](https://openrouter.ai/docs/client-sdks/python/sdks/decisions/README.md)。固定提交路径由官方生成源码写死为：

> `method="POST", path="/api/alpha/decisions"`

来源：[OpenRouterTeam/python-sdk `decisions.py`](https://github.com/OpenRouterTeam/python-sdk/blob/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter/decisions.py)。因此完整 URL 是：

```http
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
```

OpenRouter 鉴权文档原文：

> “Our API authenticates requests using Bearer tokens.”
>
> “set the `Authorization` header to a Bearer token with your API key.”

来源：[OpenRouter Authentication](https://openrouter.ai/docs/api_reference/authentication.md)。

注意：该端点路径是 `/api/alpha/decisions`，**不是** `/api/v1/alpha/decisions`，也不是 `/api/v1/chat/completions`。`alpha` 同时意味着接口尚不应被视为稳定版长期合同。

### TypeSafe 直连对照

TypeSafe 的原生端点是：

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

来源：[TypeSafe API reference](https://docs.typesafe.ai/api.md#evaluation-endpoint)。这只用于理解上游语义；OpenRouter key 不能拿去调用 TypeSafe 端点，TypeSafe 模型名也不能原样拿去调用 OpenRouter。

---

## 3. 请求字段

### OpenRouter intended client contract（官方 SDK 文档确认）

[`DecisionsRequest`](https://openrouter.ai/docs/client-sdks/python/components/decisionsrequest.md) 的必填字段是：

| 字段 | 类型/作用 |
|---|---|
| `model` | OpenRouter 模型 ID |
| `state` | string、JSON object 或 JSON array；“The content to evaluate” |
| `questions` | `map<string, Question>`；key 是业务方选择的 question id |

可选字段：

| 字段 | 已确认语义 |
|---|---|
| `provider` | OpenRouter provider routing preferences |
| `session_id` | 最长 256 字符；用于 Broadcast/private logging 的可观测性分组，且 “never sent to the provider” |
| `trace` | trace/span/generation 元数据及发往已配置 observability destinations 的自定义元数据 |
| `user` | 最长 256 字符；公开 schema 未给出更具体的 Decisions 语义 |

应用归因 header `HTTP-Referer`、`X-OpenRouter-Title`、`X-OpenRouter-Categories` 可选；Bearer header 必需。

### 三种 question

以下是 OpenRouter 当前 SDK 组件文档与 TypeSafe 原生合同的交集：

```json
{
  "model": "typesafe/jev-1.13",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?",
      "criteria": {
        "true": "Explicitly time-sensitive",
        "false": "No urgency expressed"
      }
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

- `noul`：`type`、`instructions` 必填；`criteria` 可选，若给出则定义 true/false。
- `choice`：`type`、`instructions`、`criteria` 必填；criteria 是 option → guidance 的 map。
- `score`：`type`、`instructions`、有序 `criteria` array 必填。

OpenRouter SDK 文档对三者的 `instructions` 都写明：

> “A plain string, or a JSON object or array of structured guidance.”

来源：[Noul](https://openrouter.ai/docs/client-sdks/python/components/decisionsnoulquestion.md)、[Choice](https://openrouter.ai/docs/client-sdks/python/components/decisionschoicequestion.md)、[Score](https://openrouter.ai/docs/client-sdks/python/components/decisionsscorequestion.md)。官方 SDK 源码还允许 Choice criteria value 为 structured guidance 或 `null`，Score criteria item 为 structured guidance；见 [`decisionschoicequestion.py`](https://github.com/OpenRouterTeam/python-sdk/blob/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter/components/decisionschoicequestion.py) 与 [`decisionsscorequestion.py`](https://github.com/OpenRouterTeam/python-sdk/blob/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter/components/decisionsscorequestion.py)。

TypeSafe 原生 API 同样确认顶层字段和原语，且说明：

> “You choose each key; answers come back under the same keys.”
>
> “The key is not sent to the underlying model and is not used in inference.”

来源：[TypeSafe API reference](https://docs.typesafe.ai/api.md#request-body)。

### 一手资料之间的 schema 漂移

观察时的 [OpenRouter `openapi.json`](https://openrouter.ai/openapi.json) 虽然包含 `/api/alpha/decisions`，却把 `instructions`、Choice criteria value、Score criteria item 收窄为 string；而同一时点的官方 SDK 文档/源码允许 string/object/array，并允许 Choice value 为 null。应把它视为**合同漂移，未获运行时裁决**，而不是自行挑一个版本当事实。

issue #5 应分别发送最小 string 版和 structured guidance 版，保存原始状态码与响应，以决定实现期应遵从哪个实际边界。

---

## 4. 结构化输出能力与可能响应形状

### 文档确认：这是 Decisions，不是任意 JSON Schema 生成

TypeSafe 对 Jev 的定义是：

> “Jev evaluates typed questions against a state and returns structured results directly. No text generation, no parsing.”

来源：[TypeSafe Introduction](https://docs.typesafe.ai/introduction.md)。

三种回答的语义：

| question | 核心 answer | 其它字段 |
|---|---|---|
| `noul` | `noul`: 0..1，代表 yes 的概率 | 无独立 `confidence` |
| `choice` | `choice`: 最高概率 option | `probabilities`、`confidence` |
| `score` | `score`: 各 level 的概率加权值，可位于整数 level 之间 | `legend`、`probabilities`、`confidence` |

TypeSafe 原文：

> “Every answer is constrained to the options you supplied. The model returns a probability distribution over your options or levels, never a value outside them.”

来源：[TypeSafe Primitives](https://docs.typesafe.ai/primitives.md#read-the-answer)。

Choice 直接文档还确认最多 255 个 options；Score API 文档要求至少两个 levels。来源：[TypeSafe Choice](https://docs.typesafe.ai/primitives/choice.md#good-practice-ask-more-than-one-question-per-call)、[TypeSafe API reference](https://docs.typesafe.ai/api.md#score)。这些限制尚未通过 OpenRouter 网关实测。

### OpenRouter 可能的顶层响应

OpenRouter 官方 [`DecisionsResponse`](https://openrouter.ai/docs/client-sdks/python/components/decisionsresponse.md) 要求：

```json
{
  "model": "...",
  "answers": {
    "<question-id>": { "type": "noul|choice|score", "...": "..." }
  },
  "usage": {
    "input_tokens": 0,
    "output_tokens": 0,
    "cost": 0.0
  },
  "id": "optional",
  "provider": "optional"
}
```

- 必填：`model`、`answers`、`usage.input_tokens`、`usage.output_tokens`。
- 可选：顶层 `id`、`provider`、`usage.cost`。
- OpenRouter SDK 类型只强制 Choice 的 `type/choice` 和 Score 的 `type/score`；其 `confidence/probabilities/legend` 在 OpenRouter 合同中是可选。来源：[官方 SDK response 源码](https://github.com/OpenRouterTeam/python-sdk/blob/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter/components/decisionsresponse.py)、[Choice answer](https://github.com/OpenRouterTeam/python-sdk/blob/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter/components/decisionschoiceanswer.py)、[Score answer](https://github.com/OpenRouterTeam/python-sdk/blob/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter/components/decisionsscoreanswer.py)。
- TypeSafe 原生 API 文档则把 Choice/Score 的 `probabilities`、`confidence`（及 Score `legend`）列为 required。来源：[TypeSafe API reference — Answer types](https://docs.typesafe.ai/api.md#answer-types)。OpenRouter 是否总是透传完整上游形状尚未实测。

### 与 OpenRouter 通用 Structured Outputs 的边界

OpenRouter 通用聊天 Structured Outputs 使用：

```json
"response_format": {
  "type": "json_schema",
  "json_schema": { "name": "...", "strict": true, "schema": {} }
}
```

且官方文档明确说它只适用于 compatible/select models，并要求检查 endpoint 的 `structured_outputs` 支持。来源：[OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md#model-support)。

当前 Jev 模型元数据为：

```json
"architecture": { "modality": "text->decisions" },
"supported_parameters": []
```

因此：

- **已确认**：Jev 有专用的 typed Decisions 结构。
- **API 元数据观察**：没有列出 `structured_outputs` 或 `response_format`。
- **尚未实测但不应默认**：Jev 支持任意 JSON Schema、Chat Completions、tools、sampling 参数或 streaming。专用 Decisions request schema 本身也没有 `response_format`、`messages`、`stream`、`temperature` 等字段。

---

## 5. 错误语义与重试边界

### OpenRouter Decisions 文档确认

OpenRouter Decisions SDK 为该操作列出以下 HTTP 错误：

| 状态 | 文档语义 |
|---|---|
| 400 | invalid request parameters / malformed input |
| 401 | authentication required / invalid credentials |
| 402 | insufficient credits or quota |
| 403 | authenticated but insufficient permissions |
| 404 | resource/model not found |
| 413 | request payload too large |
| 429 | rate limit exceeded |
| 500 | unexpected internal error |
| 502 | provider/upstream failure |
| 503 | service temporarily unavailable |
| 524 | edge/provider timeout |
| 529 | provider temporarily overloaded |

来源：[OpenRouter Python SDK — Alpha.Decisions / Errors](https://openrouter.ai/docs/client-sdks/python/sdks/decisions/README.md#errors)。

OpenRouter 通用错误 envelope 是：

```json
{
  "error": {
    "code": 429,
    "message": "Rate limit exceeded",
    "metadata": {}
  }
}
```

原文：

> “The HTTP Response will have the same status code as `error.code`, forming a request error if your original request is invalid [or] your API key/account is out of credits.”

来源：[OpenRouter Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)。该页还说明 429、503，以及特定 in-flight-budget 402 **可能**带 `Retry-After`；没有该 header 的普通 402 不是等待后重试问题。

### TypeSafe 直连对照

TypeSafe 原生错误表是：

- 401：missing/invalid key
- 422：body validation failure
- 429：rate limit
- 529：temporarily overloaded

并要求 429/529 指数退避。来源：[TypeSafe API reference — Errors](https://docs.typesafe.ai/api.md#errors)。

重要差异：OpenRouter Decisions 的正式错误表列 400 而不是 TypeSafe 的 422；上游 validation error 经适配器后究竟是 400、422 还是其它 4xx，尚未实测。

### 不可越界推断

- OpenRouter 通用 Chat 文档关于“HTTP 200 内含 mid-stream error”的规则依赖已开始的流；Decisions schema 没有 `stream`，不能直接把该响应语义套到 Jev。
- 官方 Python SDK 当前默认只对 `5XX` 配置退避重试；这不等于业务方应盲重试所有 5xx，也不覆盖 429。源码：[OpenRouterTeam/python-sdk `decisions.py`](https://github.com/OpenRouterTeam/python-sdk/blob/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter/decisions.py)。
- 需要按 `error.code`、`metadata.error_type`（如果实际存在）、`Retry-After` 和幂等性共同决定重试，而不能只解析 message 文本。

---

## 6. 速率、价格、上下文与输入约束

### API 元数据观察（OpenRouter）

[`models?output_modalities=decisions`](https://openrouter.ai/api/v1/models?output_modalities=decisions) 与 [Jev endpoint API](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints) 在观察时显示：

| 项目 | 值 |
|---|---|
| 输入价格 | `$0.000000042/token`，即 `$0.042/M input tokens` |
| 输出价格 | `$0` |
| modality | `text->decisions` |
| context | `32000` |
| provider 数量 | 1（TypeSafe） |
| per-request limits | `null` |
| supported parameters | `[]` |

OpenRouter Models 文档说明 pricing 数字单位是每 token/request/unit，且 `supported_parameters` 表示哪些 OpenAI-compatible 参数可用。来源：[OpenRouter Models API Standard](https://openrouter.ai/docs/guides/overview/models.md#models-api-standard)。

`per_request_limits: null` 应读成“元数据未给出 per-request limit”，**不能读成无限速率**。

### 文档确认（TypeSafe 直连）

TypeSafe 当前模型表写明：

> “Rate limits: 250,000 tokens per second / 1,200 requests per minute”
>
> “Context length: 64k tokens per request; 32k tokens for `state` plus the longest question”
>
> “Input: Text only. String, JSON object, or array of text values. No image, audio, or video input.”

并紧接着警告：

> “Rate limits are adjusting dynamically ... the limits above can change without notice.”

来源：[TypeSafe Models](https://docs.typesafe.ai/models.md#current-models)。

TypeSafe State 文档也确认 `state` 可是 string/object/array，但 Jev 最终只接受文本语义，不支持图片、音频、视频。来源：[TypeSafe State](https://docs.typesafe.ai/concepts/state.md)。English 是主要训练语言，CJK 可接受但准确率较低，必须用自身数据验证；来源：[TypeSafe Models — Language support](https://docs.typesafe.ai/models.md#language-support)。

### 尚未实测/存在冲突

- OpenRouter 的 32K 与 TypeSafe 直连的 64K aggregate / 32K state+longest-question 是否是目录简化、路由硬限制或不同计数口径。
- OpenRouter 是否继承 TypeSafe 直连的 250K TPS / 1,200 RPM；不能假设继承。
- OpenRouter generic limits 文档只给免费模型固定 cap 和 DDoS 防护，并说明 provider 也可产生 429；它没有给 Jev 付费路由一个数值配额。来源：[OpenRouter Limits](https://openrouter.ai/docs/api_reference/limits.md#rate-limits)。
- questions 数量没有单独文档上限；TypeSafe 表示受共享 token budget 限制。Choice 255 options、Score 至少 2 levels 是否由 OpenRouter 前置验证尚未确认。

---

## 7. 数据隐私注意点

### OpenRouter 层：文档确认

OpenRouter Data Collection 原文：

> “OpenRouter does not store your prompts or responses, unless you opt in”

可选项包括 private input/output logging，以及允许 OpenRouter 使用 inputs/outputs 换取折扣；两者默认关闭。同时：

> “OpenRouter does store metadata (e.g. number of prompt and completion tokens, latency, etc) for each request.”

并说明会抽样少量 prompt 做匿名分类；未 opt-in 时分类结果不关联账户或 user ID，由 ZDR model 完成。来源：[OpenRouter Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection.md)。

OpenRouter ZDR 文档定义：

> “Zero Data Retention (ZDR) means that a provider will not store your data for any period of time.”

并允许在 `provider` 内传 `"zdr": true` 强制只走 ZDR endpoint；插件/工具不自动受该 ZDR 约束。来源：[OpenRouter Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr.md)。

### 上游 TypeSafe endpoint：API 元数据观察

观察时：

- [`GET /api/v1/endpoints/zdr`](https://openrouter.ai/api/v1/endpoints/zdr) 包含 `TypeSafe | typesafe/jev-1.13-20260917`。
- [`GET /api/frontend/v1/all-providers`](https://openrouter.ai/api/frontend/v1/all-providers) 对 TypeSafe 返回 `training: false`、`trainingOpenRouter: false`、`retainsPrompts: false`、`canPublish: false`、`sendClientIp: false`。

这是**可变的 API 元数据观察**，不是本研究独立验证过的存储系统行为。上线前应重新读取 endpoint policy，并用 `provider.zdr: true` 使策略失败为显式错误，而不是静默落到非 ZDR endpoint。

### TypeSafe 自身资料

TypeSafe 模型文档原文：

> “Jev is not trained on customer requests or responses.”

来源：[TypeSafe Models — Data handling](https://docs.typesafe.ai/models.md#data-handling)。其 Privacy Policy 同样说：

> “We will not train or fine tune any artificial intelligence or machine learning models on your prompts or other Input.”

来源：[TypeSafe Privacy Policy](https://typesafe.ai/legal/privacy-policy)。

但 TypeSafe 法律索引只把企业 ZDR 描述为需联系开通：

> “We also offer zero data retention (ZDR) for enterprise customers.”

来源：[TypeSafe Legal](https://docs.typesafe.ai/legal.md)。这与 OpenRouter 对其特定 endpoint 的当前 ZDR 元数据并不必然矛盾：OpenRouter 明确说明 endpoint-specific policy 可与 provider general policy 不同。来源：[OpenRouter ZDR — How OpenRouter Manages Data Policies](https://openrouter.ai/docs/guides/features/zdr.md#how-openrouter-manages-data-policies)。

### 实际使用注意

- 不把 secrets、API keys 或不必要的个人信息放入 `state`、`questions`、`trace`、`session_id`、`user`。
- `trace` 的自定义 metadata 可发往配置的 broadcast destinations；其数据面不等同于 Jev inference ZDR。
- 开启 OpenRouter private logging、input/output use、插件、工具或第三方 observability 后，应单独审查各自保留策略。
- ZDR 不表示“无任何记录”：OpenRouter 明确保留 token、延迟、费用等非内容 metadata。

---

## 8. issue #5 必须实测的假设

以下均为**尚未实测**，建议 issue #5 用最小、可丢弃、无敏感数据的付费探针逐项记录原始 request、status、headers、body、费用与延迟：

| # | 假设/问题 | 最小探针与判定 |
|---|---|---|
| 1 | 基本路径与固定 model ID 可用 | `POST /api/alpha/decisions`，一个 string state + 一个 Noul；确认 200 和实际 response shape。 |
| 2 | 三原语可混发且 answer key 保持一致 | 一次发送 Noul/Choice/Score；检查每个 id、type、概率、confidence、legend、usage。 |
| 3 | alias 解析行为 | 对同一 payload 比较 `~typesafe/jev-latest` 与 `typesafe/jev-1.13`；记录返回 `model/provider/id`，不要求浮点完全一致。 |
| 4 | SDK 文档胜过旧 OpenAPI 的 structured guidance | 分别测试 object/array `instructions`、Choice `null`/object criteria、Score object criteria；确认接受、前置 400 或上游错误。 |
| 5 | response optional 字段是否实际总出现 | 检查 Choice/Score 的 `probabilities/confidence/legend`，以及顶层 `id/provider/usage.cost`；不要从一个成功样本升级为永久保证。 |
| 6 | validation 状态码 | 测空 questions、未知 type、Score 只有一档、缺字段、256/257 Choice options；确认是 400、422 还是别的 4xx，并保存 envelope。 |
| 7 | 实际 context 边界 | 逐步扩大纯合成 state 与 questions，定位约 32K/64K 附近失败边界、计数口径与 `error.code/metadata`。 |
| 8 | ZDR 强制可路由 | 在 request `provider.zdr: true` 下做 happy path，并在调用前后读取 endpoint 元数据；确认不会因 routing constraint 返回 503。 |
| 9 | 费用与 token usage | 核对 `usage.input_tokens/output_tokens/cost` 与 `$0.042/M`；确认 Decisions 输出是否仍报告 output tokens 但收费为 0。 |
| 10 | 失败与重试信息 | 用无余额/受限测试 key 安全触发 402；用低速率、非洪泛方式观察 429（如自然发生）；记录 `Retry-After`、rate-limit headers、`metadata.error_type/provider_code`。不得为制造 429 做压测。 |
| 11 | 延迟与稳定性 | 对同一小请求做少量串行重复，记录 p50/p95、返回完整率和解析成功率；不把模型概率的微小变化当协议错误。 |
| 12 | 非支持接口应明确失败 | 可选地验证 `/chat/completions` + Jev 或 `response_format` 不应成为集成路径；只记录实际错误，不依赖推测。 |

issue #5 的成功标准应是“确认网关合同与失败模式”，不是证明模型业务质量。业务准确率、阈值校准和 CJK 效果需要另一组带标注数据的评估。

---

## 9. 建议作为 issue #3 的 resolution

- 采用 OpenRouter 专用 Decisions API：`POST /api/alpha/decisions`。
- 默认固定 `typesafe/jev-1.13`；只有接受模型无通知升级时才用 `~typesafe/jev-latest`。
- 以 `state + questions(noul/choice/score)` 表达任务，不使用 `messages + response_format`。
- 把 OpenRouter SDK 的 required/optional response 字段当解析边界；不要假设上游 TypeSafe 全部字段永远透传。
- 对 400/401/402/403/404/413/429/5xx 分开处理；仅在可重试状态上退避并遵守 `Retry-After`。
- 请求中启用 `provider.zdr: true`，同时保持 OpenRouter logging/input-output use 关闭，并避免敏感 trace metadata。
- 在 issue #5 验证 schema 漂移、真实 response、context、alias、费用和错误后，再冻结产品侧合同。

## 一手来源索引

### OpenRouter

- [Jev 1.13 模型页](https://openrouter.ai/typesafe/jev-1.13)
- [Models API：decisions 查询](https://openrouter.ai/api/v1/models?output_modalities=decisions)
- [Jev endpoint 元数据](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints)
- [ZDR endpoints API](https://openrouter.ai/api/v1/endpoints/zdr)
- [Provider metadata API](https://openrouter.ai/api/frontend/v1/all-providers)
- [官方 OpenAPI JSON](https://openrouter.ai/openapi.json)
- [Alpha.Decisions SDK 文档](https://openrouter.ai/docs/client-sdks/python/sdks/decisions/README.md)
- [DecisionsRequest SDK 文档](https://openrouter.ai/docs/client-sdks/python/components/decisionsrequest.md)
- [DecisionsResponse SDK 文档](https://openrouter.ai/docs/client-sdks/python/components/decisionsresponse.md)
- [固定版本官方 Python SDK 源码](https://github.com/OpenRouterTeam/python-sdk/tree/b02904fe9575398e84a98338b8e1a8cd9796d667/src/openrouter)
- [Authentication](https://openrouter.ai/docs/api_reference/authentication.md)
- [Models](https://openrouter.ai/docs/guides/overview/models.md)
- [Errors and Debugging](https://openrouter.ai/docs/api_reference/errors-and-debugging.md)
- [Limits](https://openrouter.ai/docs/api_reference/limits.md)
- [Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs.md)
- [Data Collection](https://openrouter.ai/docs/guides/privacy/data-collection.md)
- [Provider Logging](https://openrouter.ai/docs/guides/privacy/provider-logging.md)
- [Zero Data Retention](https://openrouter.ai/docs/guides/features/zdr.md)

### TypeSafe / Jev

- [Introduction](https://docs.typesafe.ai/introduction.md)
- [Quick start](https://docs.typesafe.ai/introduction/quickstart.md)
- [API reference](https://docs.typesafe.ai/api.md)
- [Models](https://docs.typesafe.ai/models.md)
- [State](https://docs.typesafe.ai/concepts/state.md)
- [Primitives](https://docs.typesafe.ai/primitives.md)
- [Choice](https://docs.typesafe.ai/primitives/choice.md)
- [Score](https://docs.typesafe.ai/primitives/score.md)
- [Noul](https://docs.typesafe.ai/primitives/noul.md)
- [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)
- [Legal index](https://docs.typesafe.ai/legal.md)
- [Privacy Policy](https://typesafe.ai/legal/privacy-policy)
