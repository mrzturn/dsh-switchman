# Changelog

All notable changes to dsh-switchman are documented here. / 本文件记录 dsh-switchman 的所有重要变更。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
格式参照 Keep a Changelog;版本遵循语义化版本。

## [Unreleased]

## [1.11.5] — 2026-11-13

### English

#### Added
- context-trim: `trimProtectTaskIntent` (default `true`) makes the task-intent guard configurable — turning it off lets the first user message enter the automatic fold range (the advisory ctx_trim_fold tool stays operator-explicit; the system head stays protected regardless). Note: the settings save fence requires every registered field — refresh the web client after upgrading so the new field is sent.
- context-trim: advisory mode now speaks at the pressure line. When session pressure reaches ≥80% of the model window, the engine appends a one-off nudge to the dispatch's system head telling the model to fold now with ctx_trim_fold — at most one per 10 minutes, re-sent immediately on escalation to critical (≥95%), cleared once pressure drops below the line. The registered protocol head stays byte-stable; off and auto modes never nudge; the window is read from the sync cache (an async warm-up fills it for the next dispatch).
- context-trim: advisory-nudge silence is now observable in decisions.log — every skip exit carries a `skip why=` row (no-captured-model, bad-model-shape, window-unknown, frozen-dispatch), a successful nudge logs `advisory-nudge pressure=… level=…`, an episode clearing back below the line logs one `below-line` row, and window resolution logs `window-resolved key=… window=…` once per 10-min cache window, symmetric to the existing `window-resolve-failed` row.
- context-trim: the advisory nudge lines are now config fields — `trimAdvisoryPercent` (default `65`, deliberately below the protocol's own 80% line so the nudge lands while folding headroom is still comfortable) and `trimAdvisoryCriticalPercent` (default `95`) follow the `trimPressurePercent`/`trimEmergencyPercent` pattern; an inverted or out-of-range pair falls back to 65/95 instead of silencing the nudge. Note: the settings save fence requires every registered field — refresh the web client after upgrading so the new fields are sent.

#### Changed
- **Model-aware reasoning-effort routing**: summary folds and T2/T3 distillations follow the session model route without inheriting the session call's effort; when unpinned they choose the lowest enabled reasoning level, use `off` for toggle-only models, and leave the model default intact when reasoning is unsupported or metadata is unavailable. Fold-fallback routes receive an independent pin with the same recommendation. Intent-recognition fallback routes now also accept an independent effort pin and otherwise use the selected model's default.
- **Persistent PTC guidance and error recovery**: reinforces the PTC guard's `run_code`-only invocation rule and adds concrete recovery guidance: omit `sandbox_permissions` and `justification` in routine calls; treat `Expected ident` as submitted-code syntax and correct it rather than replaying unchanged; safely quote or serialize long prompt text. When present, `File sandbox` notes describe execution context, not the cause.
- **Factory presets re-synced to shipped dsh 0.2.2-rc.2**: the standard/ptc/cordis preset patches match the installed app's factory plugin lists again — the new `tool-office` entry (standard/ptc), `dsh-skill-filesystem` + `customSkillDirs` (js expression), `dsh-tool-subagent-control` with `interrupt: false`, and the re-applied cordis persona suffix. Snapshot fixtures refreshed via `scripts/snapshot-presets.mjs` (snapshot.json now dsh 0.2.2-rc.2), so `validate.mjs` passes against the upgraded app again.

#### Fixed
- context-trim: raw folds no longer re-absorb the previous fold's summary. Once a fold ships, its frontier ref is shadowed off the live surface, so the foldable-range start silently slid onto the relocated `acp_summary_*` node and every later fold swallowed the prior summary (rolling absorb). Range selection now skips summary segments and never bridges a span across one; `ctx_trim_fold` rejects ranges covering a summary. Summaries persist and consolidate only through ladder T2/T3 distillation.
- context-trim: window resolution now follows the host contract `resolveModelInfo(provider, model)` — passing the model object threw NO_ADAPTER on every route, so every fold decision silently ran on the 150k cap fallback. The lookup is raced against a 10s ceiling, and a fold cycle wedged longer than 5 minutes (above the summarizer's own worst case of 2 x 120s) logs an `outcome=cycle-stuck` decision row and releases its lock, so one never-settling await can no longer silence a session's fold path until restart; a watchdog-superseded cycle returns `superseded` at its commit guard instead of committing. Resolution failures surface as `window-resolve-failed` rows. Behavior note: routes whose REAL context window is below the 150k cap (e.g. 128k) now compute pressure tiers against the real window — folds may trigger earlier than before.

### 中文

#### 新增
- context-trim:`trimProtectTaskIntent`(默认 `true`)使任务意图保护可配置——关闭后第一条 user 消息可进入自动折叠范围(ctx_trim_fold 手动工具不受影响;system 头在两种配置下均受保护)。升级后请刷新 Web 客户端再保存设置——写入门栅要求所有已注册字段。
- context-trim:advisory 模式现在会在压力达线时发声。会话压力达到模型窗口的 ≥80% 时,引擎向本次派发的 system 头追加一次性提醒,指示模型立即用 ctx_trim_fold 折叠——每 10 分钟至多一次,升级到 critical(≥95%)立即重发,压力回落后清除。注册协议头保持字节稳定;off/auto 模式绝不提醒;窗口读同步缓存(异步 warm-up 为下一次派发填充)。
- context-trim:advisory-nudge 的静默路径现在在 decisions.log 可观测——每个跳过出口都有 `skip why=` 行(no-captured-model、bad-model-shape、window-unknown、frozen-dispatch),成功触发记录 `advisory-nudge pressure=… level=…`,episode 回落到线下时记一条 `below-line`,窗口解析每 10 分钟缓存窗口记一条 `window-resolved key=… window=…`,与既有 `window-resolve-failed` 对称。
- context-trim:advisory 提醒线现在是配置项——`trimAdvisoryPercent`(默认 `65`,刻意低于协议自身的 80% 折线,让提醒落在还有充足折叠余量的位置)与 `trimAdvisoryCriticalPercent`(默认 `95`)沿用 `trimPressurePercent`/`trimEmergencyPercent` 的模式;倒置或越界的配置对回退到 65/95,不会静默掉提醒。升级后请刷新 Web 客户端再保存设置——写入门栅要求所有已注册字段。

#### 变更
- **思考等级路由**：摘要折叠与 T2/T3 阶梯蒸馏跟随会话模型路由，但不继承会话调用的思考等级；未手动指定时按元数据选择最低启用档，仅开关模型取 `off`，不支持思考或元数据不可用时不发送覆盖、沿用模型默认值。折叠异常兜底模型可独立配置并使用相同推荐规则；意图识别兜底模型也支持独立配置思考等级，未配置则使用该模型默认值。
- **持久 PTC 指引与错误恢复**：强化 PTC 守卫中的 `run_code` 唯一直接调用规则，并补充具体恢复指引：常规调用不传 `sandbox_permissions`/`justification`；将 `Expected ident` 视为提交代码语法错误并先修正，不原样重试；长提示文本采用正确引号转义或序列化。仅在出现时将 `File sandbox` 说明视为执行环境信息，而非错误原因。
- **出厂预设重新同步到装机版 dsh 0.2.2-rc.2**：standard/ptc/cordis 三个预设补丁重新对齐装机 app 的出厂插件列表——新增 `tool-office` 条目（standard/ptc）、`dsh-skill-filesystem` + `customSkillDirs`（js 表达式）、`dsh-tool-subagent-control` 的 `interrupt: false`，并重新附加 cordis persona 后缀。快照 fixtures 经 `scripts/snapshot-presets.mjs` 刷新（snapshot.json 现为 dsh 0.2.2-rc.2），升级后的 app 上 `validate.mjs` 恢复通过。

#### 修复
- context-trim:raw 折叠不再吞掉上一次折叠的摘要。折叠落地后 frontier 引用即被 shadow,可折叠范围起点会滑到重定位后的 `acp_summary_*` 节点上,导致每次折叠都吸收上一份摘要(滚动吸收)。范围选择现在跳过摘要 segment 且绝不跨摘要拼接跨度;`ctx_trim_fold` 拒绝覆盖摘要的范围。摘要持久保留,仅通过 T2/T3 阶梯蒸馏合并。
- context-trim:窗口解析改按宿主契约 `resolveModelInfo(provider, model)` 传两个字符串——此前传整个 model 对象导致每条路由都抛 NO_ADAPTER,所有折叠决策一直静默回退到 150k cap。解析加 10s 硬超时;折叠循环卡住超过 5 分钟(高于摘要器自身 2 x 120s 的最坏合法耗时)会写入 `outcome=cycle-stuck` 决策行并释放锁,单个永不 settle 的 await 不再让会话的折叠路径静默到重启;被看门狗接管的过期循环在提交守卫处返回 `superseded`,不再落地。解析失败以 `window-resolve-failed` 行呈现。行为说明:真实上下文窗口低于 150k cap 的路由(如 128k)现在按真实窗口计算压力阶梯——折叠可能比以前更早触发。


## [1.11.4] — 2026-11-12

### English

#### Added

- **Dispatch pools (manual order)**: new one-click ⤒ "Move to top" button moves a route straight to the first position.

### 中文

#### 新增

- **派发池手动序**：新增「一键登顶」按钮（⤒），所选模型一步排到首位。

## [1.11.3] — 2026-11-12

### English

#### Added

- **PTC direct-call guard**: one final-say systemPrompt section (order 10510, after every other dsh-switchman section) rendered only when the viewing scope resolves to the PTC tool executor — detected per assembly via `ctx.tools.selectExecutor(context.scope)` plus the executor's `describe()` `knownNames: ["run_code"]` discrimination, with fail-open on any unusable probe — restating that `run_code` is the only directly callable tool and every named tool must be invoked as `await tools.name(args)` inside a `run_code` program, so doctrines and skill catalogs that name tools directly (teams delegation, bundled skills) are far less likely to trigger `unknown tool` rejections in PTC sessions (a prompt-level mitigation, not a hard guarantee). (`host/ptc-guard.js`)
- **run_code parallel-isolation doctrine**: a new teams-section bullet advising that team-environment calls (`spawn_teammate` / `send_message`) be kept out of the same `run_code` program as file/search tools under `Promise.all` — a session-log postmortem found the only two `read` dispatches that ever failed with `UNKNOWN_TOOL` (out of fourteen) landed inside a teammate-creation orchestration window, with all other successes showing no such proximity — plus a self-recovery rule: when a previously working tool suddenly reports unknown, retry it verbatim on the next step instead of switching tools or abandoning the task. (`host/teams.js`)
- **sandbox_permissions never-set rule**: the PTC guard section also pins that no tool call — direct or via the SDK — may carry a `sandbox_permissions` field: it is a privilege-escalation request and fails with "not strictly wider than this call's current access mode" whenever the session already runs at least that access level, so drop the field and retry instead of requesting an escalation. (`host/ptc-guard.js`)

### 中文

#### 新增

- **PTC 直调守卫**：新增一条「最后一句话」systemPrompt section（order 10510，晚于本插件所有其它 section），仅当会话作用域解析到 PTC 工具执行器时渲染——每次组装经 `ctx.tools.selectExecutor(context.scope)` 加执行器 `describe()` 的 `knownNames: ["run_code"]` 判别式按会话检测，探测不可用时一律 fail-open 渲染空串——重申 `run_code` 是唯一可直调工具、其余工具必须在 `run_code` 程序内以 `await tools.name(args)` 调用，使直接点名工具的规程与技能目录（teams 委派、内置技能）在 PTC 会话触发 `unknown tool` 报错的可能性大幅降低（提示词级缓解，非硬保证）。（`host/ptc-guard.js`）
- **run_code 并行隔离条款**：teams 规程新增一条，建议 `spawn_teammate` / `send_message` 这类改变团队环境的调用不要与文件/搜索工具放进同一 `run_code` 程序里 `Promise.all` 并行——会话日志复盘发现全会话 14 次 `read` 派发中唯二报 `UNKNOWN_TOOL` 的两次恰落在队友创建编排窗口内、其余成功皆无此邻近——并给出自纠规则：此前可用的工具突然报 unknown 时，下一步原样重试即可，不要换工具名或放弃任务。（`host/teams.js`）
- **sandbox_permissions 永不设置规则**：PTC 守卫同时钉死任何调用——直调或 SDK 内——都不得携带 `sandbox_permissions` 字段：它是特权提升请求，且当会话已运行在不低于该档位的访问级别时必报 "not strictly wider than this call's current access mode"，正确做法是去掉该字段重试而不是申请提权。（`host/ptc-guard.js`）

## [1.11.2] — 2026-11-12

### English

#### Added

- **Teams-first delegation doctrine**: the teams-vs-subagent trigger debate is replaced by channel priority — delegate through Agent Teams whenever its tools exist in the session; on missing tools or a provisioning failure, degrade to the `subagent` channel immediately instead of retrying the dead one. (`a35f085`)
- **Pre-execute tool-argument sanitation**: a waterfall before tool validation coerces the two recurring broken shapes — stringified-JSON composites and empty-string enum fields — with whitelist-only fields, structural assertions on the sanitized output, and fail-open on any internal error; unparseable values keep the tool's own validation error unchanged, so sanitation never swallows a real failure. (`51fb730`)
- **Factory-patch default config seed** (`4eda921`, `3547d2c`): the four factory presets now splice a tuned config block into the dsh-switchman-host insert row so a fresh install ships with sane behavior tuning out of the box — the trim loop and its T2/T3 ladder, the watermark tiers, `teamsMode`, `surfaceFold`, `dispatchEnforce: advice`, and `langScope: project` (28 keys). Personal model routes are deliberately not seeded — the six dispatch pools, `modelRank`, the intent classifier, UI/conversation language, `trimSideModel`, and `trimFoldFallbackModel` are left to per-user configuration; the empty-pool whitelist sync is guarded in `host/teams.js` (skip + warn), so shipping `syncWhitelist: true` stays safe.
- **Preset-drift detection in validate.mjs** (`befa61e`): check 2 now asserts the live DSH presets against committed snapshots (`scripts/fixtures/dsh-presets/`, taken from DSH 0.2.2-rc.1) and verifies snapshot freshness in app mode; `DSH_SKIP_HOST_CHECK=1` falls back to comparing against the committed snapshots only (CI/off-machine); `scripts/snapshot-presets.mjs` regenerates the fixtures after a DSH upgrade; the shared app-tree readers moved to `scripts/dsh-app-source.mjs`.
- **Push/PR validate workflow** (`ebbc184`): the validate workflow runs the snapshot-backed validate.mjs and the unit tests on pushes to main/dev and on pull requests, with node 24 pinned to match `engines` and the publish workflow.

#### Changed

- **Subagent watermark tiers scale with the session model's window** (`ae56485`): the new volatile `wmSubagentWindowRatio` (default 0.75) derives a child session's watermark tiers from its own model window — force = min(static force, window × ratio), soft/hard shrink by the same factor; tighten-only and fail-open until the session's route resolves. Trim metrics now capture per-session model routes so the watermark layer can look up the session's own window, and trim side routes round-trip an optional effort pin across schema, routes fence, and the client form — settings saves no longer strip it. Ladder-config, trim-loop, and new subagent-watermark tests cover it.

#### Fixed

- **Rejected subagent model dispatches now teach instead of just failing** (`7c398f4`): merged provider/model strings (`provider/model` inside the model field), bare models, and provider-prefixed models are detected and denied with the exact corrected fields; provider-less model ids get provider candidates suggested by matching every configured route; provider-less `list_subagent_models` lookups are covered the same way.

### 中文

#### 新增

- **团队优先委派**（`a35f085`）：teams 与 subagent 的触发之争改为通道优先级——会话里存在 teams 工具就走 Agent Teams；工具缺失或组建失败时立刻降级 `subagent` 通道，不重试死通道。
- **工具参数预清洗**（`51fb730`）：工具校验前增加瀑布式清洗，矫正两类高频坏参——字符串化 JSON 复合参数与空字符串枚举字段；仅白名单字段、清洗结果过结构断言、内部错误一概放行；解析不了的值保持工具自身校验错误不变——清洗绝不吞掉真实失败。
- **出厂补丁默认配置种子**（`4eda921`、`3547d2c`）：四个出厂预设向 dsh-switchman-host 行注入 28 键调优配置，全新安装开箱即得合理的行为调优——trim 循环与 T2/T3 阶梯、水位各档、`teamsMode`、`surfaceFold`、`dispatchEnforce: advice`、`langScope: project`。个人模型路由刻意不进种子——六池、`modelRank`、intent 分类器、界面/对话语言、`trimSideModel`、`trimFoldFallbackModel` 留给用户自配；空池白名单同步有守卫（`host/teams.js` 跳过并告警），出厂 `syncWhitelist: true` 依然安全。
- **validate.mjs 预设漂移检测**（`befa61e`）：第 2 项检查改为对 DSH 出厂预设的实时断言 + 快照新鲜度校验（app 模式），快照提交在 `scripts/fixtures/dsh-presets/`（取自 DSH 0.2.2-rc.1）；`DSH_SKIP_HOST_CHECK=1` 退化为仅比对已提交快照（CI/离机场景）；DSH 升级后用 `scripts/snapshot-presets.mjs` 重新生成；公共 app 树读取抽取到 `scripts/dsh-app-source.mjs`。
- **push/PR 验证工作流**（`ebbc184`）：验证工作流在 push（main/dev）与 PR 时跑快照版 validate.mjs + 单测，node 24 与 `engines`、发版工作流对齐。

#### 变更

- **子代理水位随会话模型窗口缩放**（`ae56485`）：新增 volatile `wmSubagentWindowRatio`（默认 0.75），子会话水位档由其自身模型窗口推导——force = min(静态 force, 窗口 × 比例)，soft/hard 同比收缩；路由未解析时只收紧、fail-open。trim 指标现记录每会话模型路由供水位层自查窗口；trim 侧路由的 effort 钉扎在 schema、routes 围栏、client 表单三处可往返保存——设置页不再丢字段。ladder-config、trim-loop 与新增的 subagent-watermark 测试覆盖。

#### 修复

- **被拒的子模型派发现在会教人**（`7c398f4`）：provider/model 混写串（model 字段里带 `provider/`）、裸模型、带 provider 前缀的模型都会被识别并以精确纠正字段拒绝；无 provider 的模型 id 按全量已配置路由给出候选；无 provider 的 `list_subagent_models` 查询同样覆盖。

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

[Unreleased]: https://github.com/mrzturn/dsh-switchman/compare/v1.11.5...HEAD
[1.11.5]: https://github.com/mrzturn/dsh-switchman/compare/v1.11.4...v1.11.5
[1.11.4]: https://github.com/mrzturn/dsh-switchman/compare/v1.11.3...v1.11.4
[1.11.3]: https://github.com/mrzturn/dsh-switchman/compare/v1.11.2...v1.11.3
[1.11.2]: https://github.com/mrzturn/dsh-switchman/compare/v1.11.1...v1.11.2

[1.11.1]: https://github.com/mrzturn/dsh-switchman/compare/v1.11.0...v1.11.1
