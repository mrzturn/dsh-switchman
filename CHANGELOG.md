# Changelog

All notable changes to dsh-switchman are documented here. / 本文件记录 dsh-switchman 的所有重要变更。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
格式参照 Keep a Changelog;版本遵循语义化版本。

## [1.11.1] — 2026-11-09

### English

#### Changed

- Trim defaults rebalanced for marathon-session profiles: `trimIncrementTokens` 50000 → 25000, `trimPressurePercent` 60 → 65, `trimProtectedTail` 6 → 10, `trimMaxFoldsPerHour` 16 → 30 (`trimGrowthTokens` stays 22500). Applied consistently across the host schema defaults (`host/config.js`), the `TRIM_NUMBER_FIELDS` mirrors (`host/routes.js`, `client.js` — `trimMaxFoldsPerHour`'s mirror def had drifted to 6, now aligned), the context-trim `readNumber` fallbacks (`trigger.js` hourly-cap fallback included), and the doc references (`docs/context-trim.md` recalibrated: the steady-state sawtooth is now wire ≈ 40–44k ↔ 64–97.5k, one fold per ~25k of raw growth). The 22500 growth gate keeps the paper's effective-minimum anchor, the halved increment floor doubles the fold cadence, the 65% pressure line pins the ceiling, and the higher hourly cap keeps sustained generation from starving.
- **Explicit-first dispatch doctrine** (session-ffd9d6ac lesson: every child inherited the session model because "dispatch implicitly" read as a coequal shortcut): the `[SWITCHMAN:POOLS]` block now renders a `session route:` line — read from the agent loop's assemble context (`modelSelection`, fail-open when absent) — so an implicit dispatch is visibly not a lane dispatch; the fallback guidance now demands explicit-first dispatch and a declared `IMPLICIT-DOWNGRADED` after a denied attempt or a `list_subagent_models` confirmation, and the persona suffix's 子路由两通道 clause carries the same rule. Covered by `scripts/test/dispatch-pools.test.mjs`.
- The teams section adds the child_message channel rule: subagent child ids are not teammate ids — `send_message` answers "active teammate … not found" for them, which is not evidence the child died; bridge via `child_message` instead of re-dispatching.

#### Fixed

- Subagent children now ship committed folds mid-run: the stream fallback chains a surface sweep after its throttled fold check (`via=stream`), so sessions whose dispatches are host-frozen (children see exactly one idle — at task end) stop carrying raw history until they finish. Fold blocks already committed mid-run; what was missing was the ship.
- Watermark calibration hygiene: the settings page's `WM_NUMBER_FIELDS` mirror (`client.js`) kept `wmHardTokens` def 120000 from the pre-95k era, so a malformed stored value fell back to a default the host no longer ships — aligned to 95000; the stale `95k ≙ trim-pressure 90k` comments (`host/config.js`, `host/context-trim/index.js`, `host/context-watch.js`, `docs/context-trim.md`) and the render-kit mock (`docs/render-kit/page.html`) now describe the recalibrated 65% / 97.5k pressure line.

### 中文

#### 变更

- Trim 默认值按长会话画像再平衡：`trimIncrementTokens` 50000 → 25000、`trimPressurePercent` 60 → 65、`trimProtectedTail` 6 → 10、`trimMaxFoldsPerHour` 16 → 30（`trimGrowthTokens` 保持 22500）。宿主 schema 默认值（`host/config.js`）、`TRIM_NUMBER_FIELDS` 镜像（`host/routes.js`、`client.js`——`trimMaxFoldsPerHour` 的镜像定义此前漂移为 6，现已对齐）、context-trim 的 `readNumber` 兜底值（含 `trigger.js` 的每小时上限兜底）与文档引用（`docs/context-trim.md` 已重新校准：稳态锯齿现为 wire ≈ 40–44k ↔ 64–97.5k，每 ~25k 原始增量折叠一次）全部同步。22500 增长门保留论文的有效最小值锚点，增量下限减半使折叠节奏翻倍，65% 压力线钉住天花板，更高的每小时上限避免持续生成被饿死。
- **派发纪律改为「显式优先」**（session-ffd9d6ac 教训：九次派发全部隐式继承主会话模型，泳道落空）：`[SWITCHMAN:POOLS]` 块新增 `session route:` 行（读自 agent loop 组装上下文的 `modelSelection`，缺失不渲染，fail-open），隐式派发拿到什么路由一目了然；兜底措辞收紧为「显式是默认，隐式仅限显式被拒或 `list_subagent_models` 确认之后，且必须声明 `IMPLICIT-DOWNGRADED`」，persona suffix 的子路由两通道条款同步收紧。新增 `scripts/test/dispatch-pools.test.mjs` 覆盖。
- 团队节新增 child_message 通道规则：subagent 子会话 id 不是 teammate id——`send_message` 对它必报「active teammate … not found」，该报错不代表子会话死亡，应改走 `child_message` 桥接而非重派。

#### 修复

- 子代理会话现在能中途 ship 已提交的折叠块：stream 兜底路径在其节流的折叠检查后串上 surface sweep（`via=stream`）——派发被宿主冻结的会话（子会话只在任务结束才有唯一一次 idle）不再全程携带原始历史直到干完活。折叠块本来就会中途提交，缺的只是 ship 通道。
- 水位校准口径清理：设置页 `WM_NUMBER_FIELDS` 镜像（`client.js`）保留了 95k 调整之前的 `wmHardTokens` def 120000，损坏的存量值会回退到宿主早已不发的默认值——已对齐 95000；`95k ≙ 压力线 90k` 的过期注释（`host/config.js`、`host/context-trim/index.js`、`host/context-watch.js`、`docs/context-trim.md`）与 render-kit 演示数据（`docs/render-kit/page.html`）已改述再平衡后的 65% / 97.5k 压力线。

## [1.11.0] — 2026-11-07
### English

#### Added

- **T1/T2/T3 ladder folding** in the context-trim engine (`trimLadderEnabled`, default on in `auto` mode): T1 folds raw message ranges as before; T2 distills a contiguous run of active T1 summaries into one block; T3 distills active T2 blocks the same way. Consumed blocks deactivate (never deleted) and their coverage is subsumed by the consuming block, so the outbound view stops creeping upward in long sessions. Triggered at the same idle boundary after the raw tiers, priority `emergency → pressure → growth → ladder (T3/T2 by summary mass)`, with a 120 s ladder interval. Tunables: `trimLadderT2Tokens` (8000) / `trimLadderT2MinBlocks` (3) / `trimLadderT3Tokens` (6000) / `trimLadderT3MinBlocks` (2), plus `trimMaxFoldsPerHour` raised 6 → 12 → 16 for continuous full-rate generation.
- **Number-free model surface**: every model-visible numeric readout of the trim machinery is gone — the `[SWITCHMAN:TRIM]` context line, the watermark's `used ~Nk of budget A/B/C` heads, and `ctx_trim_status`'s window/threshold/view lines. Judgment now roots in the task; per-turn read-budget denials keep their numbers (they gate this turn's reads, not the session water level). Human diagnostics live in `decisions.log` and the client badge. (Design: `docs/ladder-fold.md`; inspired by billion-context's tiered folding.)
- `wmHardTokens` aligned 120k → 95k with the trim pressure line, so the hard cap and trim pressure act as one curve.
- **Fold-failure fallback chain**: new `trimFoldFallbackModel` route (settings → context trim → fold fallback model) retries a failed fold summary before anything degrades — pressure folds then fall back to mechanical (marked `fallback=mechanical`), growth folds stay fail-open, ladder distillations never go mechanical. The summary route itself now renders on the settings page for the first time (`trimSideModel`, previously data-only), with a default "follow session model" choice instead of an unset blank.

#### Fixed

- The trim settings card actually persists now: `host/routes.js` `coerceValues`/`snapshotOf` had zero trim fields, so edits from the client page were dropped server-side on every save. All trim fields are coerced, snapshotted, and fenced. (Found during the ladder work.)
- Settings save returned 409 on equal configs: fence equality is now key-order insensitive.
- Watermark meters in the wire domain — `max(view, wire)` — so metered usage no longer lags what the provider actually counted.
- Manual `/ctx-handover` no longer drops the turn-scoped signal.
- A single over-ceiling message renders at least its head + a capped prefix instead of zero fold material; length-finished summaries carry a truncation mark; hintless sweeps can re-open generation-keyed tombstones; load-time single-consumption validation; fold-span dispatches bypass the side-dispatch budget; ladder commits are idempotent with a T3 adjacency crash guard; the ladder ships after a surface re-projection via summary-id re-location; the cooldown cut-in no longer gates on the ladder interval; ladder starvation under sustained emergency pressure is fixed; trimMode/trimEnabled semantics are enforced; the frontier only ever advances.
- **Tool-call appendix reaches the fold material again** (regression shipped inside 1.11.0's own development): the P1-5 refactor captured the rendered body as `const text` while the `[tool_calls]` appendix still did `text +=`; the TypeError was swallowed by the surrounding catch, so no fold material ever carried the tool-call listing. Restored to `let` with a regression test.
- Config asks the classifier kind before its kind-specific fields (intent routing UX).
- Summary-failure log lines (`summary-fail why=stream-error`) now surface the adapter's failure detail (message/code, whitespace-collapsed, 300-char cap) instead of a bare finish kind — upstream rejections are no longer indistinguishable from empty replies.

#### Changed

- **Compatibility floor**: `engines.dsh` is now `>=0.2.2-rc.1` (was `>=0.2.1-rc.1`). The four preset overrides in `cordis.patch.yml` match the 0.2.2-rc.1 shipped presets field by field: `tool-fs` `applyPatch: false`, `tool-fs-search` `sampleOverCapGlobResults: false`, the subagent spawn row with `modelSelection` + `modelDiscovery`, `profileContext` disabled expression guards, no `list-agents` row.

### 中文

#### 新增

- **T1/T2/T3 阶梯折叠**（上下文修剪引擎，`trimLadderEnabled`，`auto` 模式默认开启）：T1 折叠原始消息区间（原有行为）；T2 把一段连续的活跃 T1 摘要蒸馏为一个块；T3 同理蒸馏活跃 T2 块。被消费的块停用（永不删除），其覆盖面由消费块接管，长会话的出站视图不再逐轮上爬。触发在同一空闲边界、原始层级之后，优先级 `emergency → pressure → growth → ladder（T3/T2 按摘要质量取优）`，阶梯间隔 120 秒。可调参数：`trimLadderT2Tokens`（8000）/`trimLadderT2MinBlocks`（3）/`trimLadderT3Tokens`（6000）/`trimLadderT3MinBlocks`（2）；`trimMaxFoldsPerHour` 为持续满速生成从 6 提到 12 再到 16。
- **模型看不见水位**：修剪机制对模型可见的数字读数全部移除——`[SWITCHMAN:TRIM]` 上下文行、水位的 `used ~Nk of budget A/B/C` 头、`ctx_trim_status` 的窗口/阈值/view 行。判断回归任务本身；本轮读预算拒绝消息保留数字（那是本轮读闸，不是会话水位）。人的诊断走 `decisions.log` 与客户端徽标。（设计见 `docs/ladder-fold.md`；设计参考 billion-context 的分层折叠。）
- `wmHardTokens` 120k → 95k，与修剪压力线对齐，硬上限与修剪压力合成一条曲线。
- **折叠失败兜底链**：新增 `trimFoldFallbackModel` 路由（设置 → 上下文裁剪 → 折叠异常兜底模型），摘要失败先换兜底模型重试再降级——压力折叠此时才退回机械折叠（结果标 `fallback=mechanical`），增长档保持 fail-open，阶梯蒸馏永不机械。摘要模型（`trimSideModel`）首次渲染到设置页（此前只有数据链无 UI），下拉默认「跟随会话模型」而非留空。

#### 修复

- 修剪设置卡真正可保存了：`host/routes.js` 的 `coerceValues`/`snapshotOf` 此前没有任何 trim 字段，客户端页面的每次保存都被服务端丢弃；现在全部 trim 字段参与 coerce、快照与围栏。（阶梯开发中发现的既有 bug。）
- 设置保存对相等配置返回 409：围栏相等性不再区分键序。
- 水位按线上口径计量——`max(view, wire)`——计量不再滞后供应商实际计数。
- 手动 `/ctx-handover` 不再丢失轮级信号。
- 单条超顶消息至少渲染头部 + 截断前缀而非零材料；长度完成的摘要带截断标记；无提示清扫可重新打开 generation 键控墓碑；加载期单次消费校验；fold-span 派发绕过侧派发预算；阶梯提交幂等并有 T3 相邻崩溃守卫；阶梯经 summary-id 重定位在表面重投影后发送；冷却切入不再被阶梯间隔闸住；持续紧急压力下的阶梯饥饿已修；trimMode/trimEnabled 语义强制执行；frontier 只前进。
- **tool_calls 附录重新进入折叠材料**（1.11.0 开发期自身引入的回归）：P1-5 重构把渲染结果捕获为 `const text`，而下方的 `[tool_calls]` 附录仍执行 `text +=`；TypeError 被外层 catch 吞掉，折叠材料从此不再携带工具调用清单。改回 `let` 并加回归测试。
- 配置页先问分类器类型、再问其专属字段（意图路由交互）。
- 摘要失败日志（`summary-fail why=stream-error`）现在带出适配器的失败详情（message/code，空白折叠，300 字符截断），不再只有裸 finish 类型——上游秒拒从此有迹可查。

#### 变更

- **兼容下限**：`engines.dsh` 提升至 `>=0.2.2-rc.1`（原 `>=0.2.1-rc.1`）。`cordis.patch.yml` 的四个预设覆盖与 0.2.2-rc.1 出厂预设逐字段一致：`tool-fs` `applyPatch: false`、`tool-fs-search` `sampleOverCapGlobResults: false`、subagent spawn 行 `modelSelection` + `modelDiscovery`、`profileContext` disabled 表达式守卫、无 `list-agents` 行。

[1.11.0]: https://github.com/mrzturn/dsh-switchman/compare/v1.10.3...v1.11.0
[1.11.1]: https://github.com/mrzturn/dsh-switchman/compare/v1.11.0...v1.11.1
