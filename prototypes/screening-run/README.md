# PROTOTYPE — 固定 Route Target 筛选实验（issue #71）

Throwaway prototype answering
[issue #71](https://github.com/Z761293629/pi-jev-helm/issues/71):
在相同 Route Target 与 thinking level 下，哪些候选方案在约 50 条筛选集上
相对当前 Helm 与始终强模型均至少降低 20% 平均总费用，同时通过严格质量零退化、
客观检查和 p95 延迟护栏？

结构按 #70 决议的两步：**先 Schema 门（C′ 新旧头对头），胜者供 6 个策略臂**。
本目录目前实现第一步的全部机件与第二步的离线策略重放。

## 文件

- `classify-replay.mjs` — 把筛选集 50 条 + classification corpus 24 条按
  v1（现行布尔 schema）与 v2（C′ 0–3 锚点，三信号 × 3 个累积梯度问题）经
  TypeSafe leg（pinned `jev-1.13.0`）重放 N 次，缓存原始逐调用结果。
  断点续跑；`--dry-run` 只列计划。输出在 `~/.pi-jev-helm-eval/screening-runs/`。
- `analyze-schema-gate.mjs` — 离线分析（零 API 调用）：
  corpus gate（逐字复刻 real-jev-gate 语义 + 2/3 规则）、筛选集 fail-open 率、
  路由分布、rep 一致性（#65 非确定性）、v1↔v2 翻转、A 阈值扫描、
  B1 不一致复核、B2 k=3 投票的离线重放、#69 每路成本代理。
  写 `schema-gate-report.md` + `schema-gate-summary.json`。

## C′ (v2) schema 设计记录

- 每个 Capability Signal 三个**累积** noul 问题：P(level ≥ 1)、P(level ≥ 2)、P(level ≥ 3)，
  锚点文本 0–3 级递进（any → substantive → heavy）。
- 解码：强制单调 P(≥1) ≥ P(≥2) ≥ P(≥3)（前缀 min），level = 最大 k 使 P(≥k) ≥ 0.5。
- 与 v1 兼容的布尔语义：**level ≥ 1 ⇔ v1 true**（并集语义不变）；
  置信度 = max(P(≥1), 1−P(≥1))，与 v1 的 max(p, 1−p) 同构。
- corpus gate 判据与 v1 完全一致（期望布尔向量 = level≥1 投影）。

## 隐私与池

沿用 #68 管道规则：池与全部结果在 `~/.pi-jev-helm-eval/`（库外），
脚本只读池、只写库外目录；本目录任何文件不含样本内容。
