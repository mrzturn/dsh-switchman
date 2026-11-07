# Changelog

All notable changes to dsh-switchman are documented here. / 本文件记录 dsh-switchman 的所有重要变更。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
格式参照 Keep a Changelog;版本遵循语义化版本。

## [1.11.0] — 2026-11-07

### English

#### Added

- **T1/T2/T3 ladder folding** in the context-trim engine (`trimLadderEnabled`, default on in `auto` mode): T1 folds raw message ranges as before; T2 distills a contiguous run of active T1 summaries into one block; T3 distills active T2 blocks the same way. Consumed blocks deactivate (never deleted) and their coverage is subsumed by the consuming block, so the outbound view stops creeping upward in long sessions. Triggered at the same idle boundary after the raw tiers, priority `emergency → pressure → growth → ladder (T3/T2 by summary mass)`, with a 120 s ladder interval. Tunables: `trimLadderT2Tokens` (8000) / `trimLadderT2MinBlocks` (3) / `trimLadderT3Tokens` (6000) / `trimLadderT3MinBlocks` (2), plus `trimMaxFoldsPerHour` raised 6 → 12 → 16 for continuous full-rate generation.
- **Number-free model surface**: every model-visible numeric readout of the trim machinery is gone — the `[SWITCHMAN:TRIM]` context line, the watermark's `used ~Nk of budget A/B/C` heads, and `ctx_trim_status`'s window/threshold/view lines. Judgment now roots in the task; per-turn read-budget denials keep their numbers (they gate this turn's reads, not the session water level). Human diagnostics live in `decisions.log` and the client badge. (Design: `docs/ladder-fold.md`; inspired by billion-context's tiered folding.)
- `wmHardTokens` aligned 120k → 95k with the trim pressure line, so the hard cap and trim pressure act as one curve.

#### Fixed

- The trim settings card actually persists now: `host/routes.js` `coerceValues`/`snapshotOf` had zero trim fields, so edits from the client page were dropped server-side on every save. All trim fields are coerced, snapshotted, and fenced. (Found during the ladder work.)
- Settings save returned 409 on equal configs: fence equality is now key-order insensitive.
- Watermark meters in the wire domain — `max(view, wire)` — so metered usage no longer lags what the provider actually counted.
- Manual `/ctx-handover` no longer drops the turn-scoped signal.
- A single over-ceiling message renders at least its head + a capped prefix instead of zero fold material; length-finished summaries carry a truncation mark; hintless sweeps can re-open generation-keyed tombstones; load-time single-consumption validation; fold-span dispatches bypass the side-dispatch budget; ladder commits are idempotent with a T3 adjacency crash guard; the ladder ships after a surface re-projection via summary-id re-location; the cooldown cut-in no longer gates on the ladder interval; ladder starvation under sustained emergency pressure is fixed; trimMode/trimEnabled semantics are enforced; the frontier only ever advances.
- **Tool-call appendix reaches the fold material again** (regression shipped inside 1.11.0's own development): the P1-5 refactor captured the rendered body as `const text` while the `[tool_calls]` appendix still did `text +=`; the TypeError was swallowed by the surrounding catch, so no fold material ever carried the tool-call listing. Restored to `let` with a regression test.
- Config asks the classifier kind before its kind-specific fields (intent routing UX).

#### Changed

- **Compatibility floor**: `engines.dsh` is now `>=0.2.2-rc.1` (was `>=0.2.1-rc.1`). The four preset overrides in `cordis.patch.yml` match the 0.2.2-rc.1 shipped presets field by field: `tool-fs` `applyPatch: false`, `tool-fs-search` `sampleOverCapGlobResults: false`, the subagent spawn row with `modelSelection` + `modelDiscovery`, `profileContext` disabled expression guards, no `list-agents` row.

### 中文

#### 新增

- **T1/T2/T3 阶梯折叠**（上下文修剪引擎，`trimLadderEnabled`，`auto` 模式默认开启）：T1 折叠原始消息区间（原有行为）；T2 把一段连续的活跃 T1 摘要蒸馏为一个块；T3 同理蒸馏活跃 T2 块。被消费的块停用（永不删除），其覆盖面由消费块接管，长会话的出站视图不再逐轮上爬。触发在同一空闲边界、原始层级之后，优先级 `emergency → pressure → growth → ladder（T3/T2 按摘要质量取优）`，阶梯间隔 120 秒。可调参数：`trimLadderT2Tokens`（8000）/`trimLadderT2MinBlocks`（3）/`trimLadderT3Tokens`（6000）/`trimLadderT3MinBlocks`（2）；`trimMaxFoldsPerHour` 为持续满速生成从 6 提到 12 再到 16。
- **模型看不见水位**：修剪机制对模型可见的数字读数全部移除——`[SWITCHMAN:TRIM]` 上下文行、水位的 `used ~Nk of budget A/B/C` 头、`ctx_trim_status` 的窗口/阈值/view 行。判断回归任务本身；本轮读预算拒绝消息保留数字（那是本轮读闸，不是会话水位）。人的诊断走 `decisions.log` 与客户端徽标。（设计见 `docs/ladder-fold.md`；设计参考 billion-context 的分层折叠。）
- `wmHardTokens` 120k → 95k，与修剪压力线对齐，硬上限与修剪压力合成一条曲线。

#### 修复

- 修剪设置卡真正可保存了：`host/routes.js` 的 `coerceValues`/`snapshotOf` 此前没有任何 trim 字段，客户端页面的每次保存都被服务端丢弃；现在全部 trim 字段参与 coerce、快照与围栏。（阶梯开发中发现的既有 bug。）
- 设置保存对相等配置返回 409：围栏相等性不再区分键序。
- 水位按线上口径计量——`max(view, wire)`——计量不再滞后供应商实际计数。
- 手动 `/ctx-handover` 不再丢失轮级信号。
- 单条超顶消息至少渲染头部 + 截断前缀而非零材料；长度完成的摘要带截断标记；无提示清扫可重新打开 generation 键控墓碑；加载期单次消费校验；fold-span 派发绕过侧派发预算；阶梯提交幂等并有 T3 相邻崩溃守卫；阶梯经 summary-id 重定位在表面重投影后发送；冷却切入不再被阶梯间隔闸住；持续紧急压力下的阶梯饥饿已修；trimMode/trimEnabled 语义强制执行；frontier 只前进。
- **tool_calls 附录重新进入折叠材料**（1.11.0 开发期自身引入的回归）：P1-5 重构把渲染结果捕获为 `const text`，而下方的 `[tool_calls]` 附录仍执行 `text +=`；TypeError 被外层 catch 吞掉，折叠材料从此不再携带工具调用清单。改回 `let` 并加回归测试。
- 配置页先问分类器类型、再问其专属字段（意图路由交互）。

#### 变更

- **兼容下限**：`engines.dsh` 提升至 `>=0.2.2-rc.1`（原 `>=0.2.1-rc.1`）。`cordis.patch.yml` 的四个预设覆盖与 0.2.2-rc.1 出厂预设逐字段一致：`tool-fs` `applyPatch: false`、`tool-fs-search` `sampleOverCapGlobResults: false`、subagent spawn 行 `modelSelection` + `modelDiscovery`、`profileContext` disabled 表达式守卫、无 `list-agents` 行。

[1.11.0]: https://github.com/mrzturn/dsh-switchman/compare/v1.10.3...v1.11.0
