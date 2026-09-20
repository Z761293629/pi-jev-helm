# PROTOTYPE — 真实样本的本地导出与脱敏管道

Throwaway prototype answering [issue #68](https://github.com/Z761293629/pi-jev-helm/issues/68):
什么本地自愿导出、脱敏、审阅和保存流程，能够产生具有代表性的真实请求样本，
同时确保原始私密消息、密钥、可识别内容和自动遥测都不会进入仓库、issue 或共享评测资产？

Not production code. No deps. Node ≥ 18.

## Run

```bash
node prototypes/local-sample-pipeline/export-samples.mjs --list ~/.pi/agent/sessions/<dir>   # 本地元数据，不导出
node prototypes/local-sample-pipeline/export-samples.mjs --export <file.jsonl> ...           # 导出+脱敏+生成审阅单
node prototypes/local-sample-pipeline/export-samples.mjs --confirm <id>                     # 人工批准
node prototypes/local-sample-pipeline/export-samples.mjs --reject <id>                      # 人工拒绝（删除）
node prototypes/local-sample-pipeline/export-samples.mjs --stats                            # 聚合统计（可共享）
```

数据池默认在 `~/.pi-jev-helm-eval/`（可用 `PI_JEV_EVAL_POOL` 覆盖），**永远不在任何 git 工作树内** —— 脚本向上查找 `.git`，命中即拒绝运行。

## The process (the answer this prototype embodies)

1. **自愿导出** — 只有命令行显式点名的 `.jsonl` 会话文件会被读取；没有全盘扫描，没有自动上传。`--list` 只在本地打印元数据（文件名、大小、日期）。文件名含 auth/credential/secret/token 直接拒绝。
2. **本地提取** — 从 Pi 会话记录提取：run-opening 请求（routing-explanation 之后的首条用户消息，即 Task Classification 实际看到的输入）与 continuation（排队续写，单独标记，供 Capability Drift 实验备用）。每条携带代表性分层所需的元数据：时间、项目、route、signals+置信度、outcome、该 Routed Run 的真实 usage/cost、长度、中英占比。
3. **确定性脱敏** — 单遍正则，全部带标签：`api-key`、`bearer`、`email`、`phone`（CN 手机号 + 国际格式）、`home-path`、`ip`、`url-cred`、`hex-blob`。日期/版本号不动。每条样本记录命中了什么、多少次。已知过度脱敏风险：`hex-blob` 会吃掉代码里的长哈希/base64——方向安全（宁多勿漏），由审阅单判断是否可接受。
4. **人工审阅** — 生成 `review-pending.md` 审阅单：脱敏后文本 + 脱敏清单 + 残余风险旗标（URL、@提及、secret 关键词、MAC 地址——不自动删，标给人看）。人工逐条 `--confirm` / `--reject`。未审阅 = pending，不进任何共享资产。
5. **库外保存** — 池在 `~/.pi-jev-helm-eval/`，物理上不可能被本仓库 commit。仓库/issue/共享评测资产只拿到：管道代码本身 + `--stats` 聚合数。脱敏样本即使被批准，也只在后续实验明确需要时按最小集合进入共享资产。
6. **不联网** — 只 import node 内建（fs/path/os/crypto）；不读 `auth.json`；没有任何网络 I/O，"自动遥测" 从构上为零。

## Boundary decisions to react to (this is the HITL part)

- **样本单元 = run-opening 请求**，continuation 单独标记备用 —— 而不是整段会话。理由：分类器的输入就是这条；整段会话会带出助手输出与工具结果，泄露面大一个数量级。
- **池放 `~/.pi-jev-helm-eval/` 而不是仓库内 gitignore 目录** —— gitignore 依赖人不出错，物理隔离不依赖。
- **残余风险只旗标不自动删** —— URL/提及/关键词误报率高，自动删会毁掉代表性；交给人眼终审。
- **id = 脱敏文本的 sha256 前 12 位** —— 天然去重，且不泄露原文。
