# dsh-switchman 能力移植分析与实施计划

> 状态：**草案，待你审阅拍板**（本文只做分析与规划，未动任何实现）
> 日期：2026-10-01
> 方法：四路并行调查（opencode-switchman 三大能力机制 ×1、DSH 平台扩展点 ×1）+ 通过 Cordis Inspect 对运行中 Host/Client 的活体查询（Service / Event / Slots 目录）。
> 引用图例：`oc/…` = `~/Documents/code/my/GitHub/opencode-switchman/…`；`dsh-platform` 结论来自 Inspect 活体查询与本机 DSH 0.2.0-rc.2 源码检出（`app.asar!dsh/`），行号引用见各节。

---

## 0. 结论速览

| # | 能力 | 结论 | 一句话判定 |
|---|------|------|-----------|
| 1 | 多语言支持（UI 文案层） | ✅ **可复刻，低成本** | DSH 客户端原生就有 `locale.register/addLanguage/resolveText`，opencode 的 11 语种键值表可整体挂载 |
| 2 | 多语言支持（项目语言偏好层） | ✅ **可复刻，换承载面** | `[LANG]` 铁律行改为 Host 动态 systemPrompt 段；ask 流程改用 DSH 现成 `ask_user_question`；**硬门建议软化为首次询问** |
| 3 | 多语言关联技能 | ✅ **可复刻，近零代码** | 真相是「SKILL.md 让渡条款 + 语言铁律行」的约定，无代码参与；DSH 技能体系同构；opencode 的 skill-sync 在 DSH **不需要** |
| 4 | 上下文水位控制 | ⚠️ **可兼容（策略层叠加）** | DSH 已有 tokenMeter + compaction-basic + 裁剪器；**不要重造计量/压缩**，移植的是「三级水位策略 + 读预算 + 委派引导 + 子代理硬顶」这层皮，每个 opencode hook 都有 DSH 等价事件 |
| 5 | GUI 池子→模型配置页 | ✅ **可复刻（数据模型）+ 新建（承载面）** | pool-config/capability-rank 数据结构与纯函数层直接搬；设置页挂在 `settings.section` 官方预留 slot，手写表单（schema 自动渲染官方尚未实现） |
| 6 | 模型能力优先级排序 | ✅ 同上 | capability-default.json 快照 + 四级回退链 + `applyRankMove` 语义原样移植；DSH 无排序概念，自持 volatile Config ns |
| 7 | TUI / tmux / 配额爬取 / ROUTE_META 六门禁 / shell 注册面 | ❌ **不建议移植** | 见 §4，均有环境不匹配或现成替代 |

---

## 1. 平台底座：DSH 已有的原语（这是「可兼容」的根基）

调查确认 DSH Host/Client 两侧已经具备移植所需的几乎全部挂点：

**Host 服务（ctx.*，Inspect 活体确认）**
- `tokenMeter.measure(session)` / `estimateMessage` + 会话投影 `tokenUsage` / `contextPressure{pressureTokens, projectedTokens, contextWindow}` / `contextBreakdown` —— 计量不用自建
- `compaction` 三抽象 `compactIfNeeded / compactNow / compactRegion`；compaction-basic 已有 auto 压缩（thresholdRatio 0.8）、`/compact` 命令、per-route `modelPolicies` —— 压缩不用自建
- `systemPrompt.section() / context() / variable()` + `system-prompt/assemble` 瀑布 —— 横幅/铁律行注入口（现有 persona suffix 即走此路，order 10200）
- `tools/pre-execute`（allow/deny/cancel/ask）、`tools/post-execute`、`tools/result` —— 读预算与硬顶的拦截点
- `agent/pre-step`（可改写进入 step 的消息）、`agent/request`（可替换冻结的调用配置）、`llm/stream`（每次模型调用瀑布）、`agent/request-error`
- `commands.register` —— 斜杠命令注册表（`/ctx-pause` 等的载体）
- `llm.listProviders() / listModels() / resolveModelInfo`（模型元数据自带 contextWindow、reasoning.efforts）
- `subagentModelSelection`（allowedModels 白名单，已生效于 subagent/workflow 路由校验，但**无排序概念**）
- `skills.registerProvider`（本 bundle 已在用）、`configEditor`（配置持久化）、`storage`（Domain 持久化）、`hmr.watchConfig`（配置热重载）
- `subagents` + `agentTeams` 全套（spawn/teammate/task board）

**Client 面**
- `locale`：出厂 zh/en；插件可 `register(ns, dicts)` 贡献文案、`addLanguage({id,label,fallback:'en'})` 贡献**全新语言**、`resolveText({zh,en,…})`；语言检测走 navigator.languages + Host 偏好
- Slots（官方预留、`replaceRisk: none` 的安全席位）：`settings.section`（**整个设置页**）、`settings.plugins.tab`、`plugins.bundle.config`（bundle 自己的配置页）、`plugins.row.config`、`settings.models.footer` / `settings.models.provider-card`（**模型设置页的第三方扩展区**）、`settings.general.item`（单行偏好）、`conversation.session.header.actions`（现徽标位）、`conversation.input.dock` / `conversation.composer.dock`
- 插件 volatile Config（schemastery `static Config`）自动进 settings form 描述符并持久化到 profile patch —— **但 schema→UI 自动渲染官方客户端尚未实现**，设置页需自带 client 半手写表单（可复用 ui-primitives 的 SettingsFormModel）

---

## 2. 逐能力分析

### 2.1 多语言支持

**opencode 机制（两层，勿混淆）**
- A 层·项目语言偏好：`settings.json` 的 `lang.{conversation,comments,docs}`（oc/src/lang-config.ts:20-48），首配走 question 工具三连问 + 插件侧捕获持久化（oc/src/index.ts:1597-1604, 2021-2035），未配置期间**硬门拒绝 bash/edit/write/task**（oc/src/lang-config.ts:243-257）；配置后每轮注入 `[LANG] … IRON RULE` 行（oc/src/index.ts:1594-1596）。
- B 层·UI 显示语言：11 个 locale 文件、263 key、en 为 source of truth、回退链 未知→en→fallback→key 永不抛错（oc/src/i18n.ts:33-41）；测试强制全覆盖 + 占位符一致（oc/test/i18n.test.ts:14-31）。**模型面协议文案刻意不翻译**（`[LANG]`/`[WATERMARK]` 等锚点需字节稳定，oc/src/i18n.ts:1-6）。
- README 11 语言纯人工维护、无同步脚本；docs 仅 en/zh。

**DSH 现状**：B 层基础设施原样存在（§1）；A 层需要新造注入面。

**判定与方案**
- B 层 → **可复刻**：oc/src/locales/ 的 en/zh-CN/zh-TW/ja/ko/es/fr/de/it/pt/ru 整体搬为插件 locale ns；裁剪 sidebar/dialogs/palette 三组 TUI 专属 key，保留 notices/quota/cli。建议 zh/en 起步，其余语种按 locales 文件已有翻译跟进（有测试锁，维护成本可控）。
- A 层 → **可复刻（换承载面）**：三字段语言偏好存插件 volatile Config；首配用 `ask_user_question`（多问题+选项，比 opencode 的文本对解析 robust 得多）一次问齐；每步经 `systemPrompt` 动态段注入语言铁律行（order 晚于 10200 的 persona suffix）。客户端 locale 可作预填默认。
- 硬门 → **不建议照搬**：DSH 是常驻 GUI + profile 配置，语言可先预填再温和确认；「不配语言就拒绝写工具」体验过重。可保留为可选严格模式。
- 协议文案保持英文的锚点稳定性原则 → **原样保留**（跨语言捕获/测试都依赖它）。

### 2.2 多语言关联技能

**真相**：技能本体**不本地化**——三个 SKILL.md 全英文，"关联"= 文档内让渡条款（"English by default, use the project's configured language when a switchman [LANG] line specifies"）+ 每轮注入的语言行，运行时语言跟随，零代码。skill-sync.ts 只是把包内 skills 物化到 opencode 全局技能目录（marker 门控、add/overwrite-only、fail-open，oc/src/skill-sync.ts:97-137）——这是 opencode「宿主扫描全局目录」的补丁，DSH 的 `registerProvider` 模式根本不需要。

**判定与方案**：**可复刻且近零代码**。dsh-switchman 已注册 bundled 技能 provider；只需（1）给三个 SKILL.md 补语言让渡条款，（2）等 2.1 的语言行注入生效即可。**skill-sync 不移植**（无对应需求）。

### 2.3 上下文水位控制

**opencode 机制摘要**
- 计量：assistant 消息 usage（input+output+reasoning+cache.read），每消息更新双 Map（主会话/壳子），模型窗口 90% 封顶（oc/src/context-watch.ts:25-51）。
- 三级水位默认 50k/90k/130k：soft=委派建议、hard=关读工具+收尾、force=自动 handover；横幅每轮经 system transform 注入（oc/src/index.ts:386-421, 1655-1658）。
- 读预算：单次 R*=1500、每轮 2×R*，64KB 头采样估算 + 事后记账 + 容差带 + 续读合并 + 15 分钟闲置重置（oc/src/context-watch.ts:154-368）。
- handover：`session.fork` 备份（`[backup]` 标题自编号）+ `session.summarize` 压缩；**compact 腿绝不 await**（自死锁教训）；10 分钟冷却（oc/src/handover-core.ts:26-86, oc/src/index.ts:2066-2110）。
- 子代理硬顶：默认共享 forceTokens，触顶后该会话一切工具 deny、deny 文本即收尾指令（要求输出 HANDOFF 总结），持久登记重启仍生效（oc/src/index.ts:1756-1777, 2202-2226）。

**DSH 现状与差异**：DSH 已有「单阈值自动压缩」（compaction-basic thresholdRatio 0.8 + overflow 恢复 + GUI「上下文已用 %」）。缺的不是压缩，而是 switchman 的**策略层**：分级水位横幅、读预算、按水位引导委派、子代理硬顶、暂停开关。

**hook 映射表（全部有等价物）**

| opencode | DSH 等价物 | 用途 |
|---|---|---|
| message.updated tokens | `tokenMeter.measure` + session 投影 `contextPressure` | 水位计量（不自建） |
| chat.system.transform | `systemPrompt.context()/section()`（order>10200） | 横幅注入 |
| tool.execute.before | `tools/pre-execute` | 读预算闸 / 硬顶闸 |
| tool.execute.after | `tools/post-execute` + `tools/result` | 事后记账 / force 触发 |
| session.fork | 客户端 `sessions.fork` / compaction checkpoint | 备份腿 |
| session.summarize | `compaction.compactNow/compactIfNeeded` | 压缩腿（不自建） |
| /ctx-pause 标记捕获 | `commands.register` + 会话级状态 | 暂停开关（+GUI toggle） |
| 壳会话事件 | `subagent/start` / `subagent/end` | 子代理硬顶 |
| models.dev 窗口 | `llm.resolveModelInfo().contextWindow` | 窗口封顶 |

**判定与方案**：**可兼容——作为策略层叠加**。决策核（oc/src/context-watch.ts 的纯函数部分：阈值判定/预算分配/估算器）近原样搬；执行层全部换 DSH 服务。force 档直接调 compaction 服务并先做 checkpoint 备份，保持 fire-detached。**不建议**：自建计量、自建 summarize、绕开 compaction-basic 另起压缩（竞态）；hard 档的全量 deny 建议默认降为「cap + 强建议」，deny 做成可选项（与 DSH approval 体验协调）。

### 2.4 GUI 池子→模型 + 能力优先级排序

**opencode 数据模型（可整体搬运的核心资产）**
- `pool-config.json`：`{pools:{lane→[modelId]}}`，六泳道 economy/mechanical/main/hard/vision/review（oc/src/user-overrides.ts:34-40；oc/src/lane-policy.ts:53-64）。
- `capability-rank.json`：`{models:[…有序]， scores:{key→{tier,raw}}}`，锚定分可与基础分交错（oc/src/user-overrides.ts:15-32）；移动语义 `applyRankMove` 纯函数（:212-271）。
- 能力数据四级回退：manual→api(24h TTL)→bundled 快照(179 模型)→策展表（oc/src/capability.ts:400-408）。
- 评分乘积公式 + tiebreak 成本（oc/src/scoring.ts:124-149, 338-343）。
- setup 硬门槛：六池各 ≥1 + 排名 ≥1 才放行派发（oc/src/setup-gate.ts:21-36）。
- 交互：/poolConfig 勾选落盘、/modelRank 上移下移、/switchman-setup 向导（oc/src/tui.tsx:447-932）。

**DSH 现状**：模型枚举与元数据比 opencode 更好（`ctx.llm` 自带，无需 models.dev 爬窗口）；路由消费面是 subagent/workflow/spawn_teammate 的 provider/model 参数 + `subagentModelSelection` 白名单（准入层，无排序）；GUI 有官方预留 slot（`settings.section`、`settings.models.footer`、`plugins.bundle.config`）；持久化走 volatile Config；**但无「任务类型→模型」映射层、无优先级概念、设置页需手写**。

**判定与方案**：数据模型与纯函数层（lane-policy/scoring/capability/user-overrides/setup-gate + 对应测试作为行为锁）**可复刻**；承载面**新建**：
- Host 半新增插件（如 `dsh-switchman-dispatch`）：`static Config` 声明 `pools` / `rank`（volatile），打包 capability-default.json；消费路径两条——①动态 systemPrompt 段输出「池子推荐表」（指导 Lead 的 spawn_teammate/subagent/workflow 选模，与现有自主团队规程无缝衔接）；②可选 `tools` guard：subagent/workflow 的 model 不在目标池时提示（默认 advice，可开 enforce）。
- Client 半设置页（`settings.section` 注册整页，或先挂 `settings.models.footer` 轻量起步）：六池卡片（候选=llm.listModels 经 remote）、勾选即存、拖拽排序（锚定 tier 显示）、setup 完成度横幅；表单复用 ui-primitives。
- 与 `subagentModelSelection` 的分工要明确：**白名单=准入（能不能用），池子=推荐与排序（优先用谁）**，两者互补不同步改写，页面加说明。
- **不建议移植**：ROUTE_META 提示词六键协议与完整六门禁（DSH 派发是结构化参数，简化为池成员校验）、shell 注册三态/matrix 探测/激活面双文件监听（opencode 特有）、shells.json「模型×effort」面展开与 -ro 别名（DSH 的 reasoning_effort 是调用参数）、三端配额爬取与 peak-window（先降级为 billing 配置驱动系数，后期可选）。

---

## 3. hook/事件接线总表（水位 + 派发两块合并速查）

见 §2.3 映射表；派发侧补充：
- 失败感知（后期健康因子）：`agent/request-error` + `llm/stream` → 失败分类 → 排序 health 系数（opencode 的熔断 600s×2、隔离 5m/10m/6h、退役 1h×3 逻辑可简化后搬，oc/src/breaker.ts:1-84）。
- 配置热更：volatile Config 变更 → `settings/document-updated` 事件 → 重算推荐表。

---

## 4. 不建议移植清单（汇总）

| 项 | 理由 |
|---|---|
| TUI 全套（@opentui 对话框、sidebar、palette、tmux 镜像） | DSH 是 Web GUI，等价物是设置页 + conversation slots |
| GLM/Copilot/DS 三端配额 HTTP 爬取、peak-window 感知 | 环境不匹配（DSH 有 deepseekAccount 体系）；先降级为 billing 配置系数 |
| ROUTE_META 六键协议 + 六道门禁完整复刻 | DSH 派发是结构化参数；简化为池成员校验 + 白名单 |
| shell 注册三态 / matrix 探测 / 激活面双文件监听 | opencode 宿主特有，DSH 无命名壳概念 |
| shells.json 模型×effort 面展开、-ro 别名 | DSH 的 reasoning_effort 是每次调用的参数 |
| lang 硬门（未配置语言拒绝写工具） | GUI 环境体验过重；改首次温和询问 + locale 预填 |
| 自建 token 计量、自建压缩 summarize | 与 tokenMeter / compaction-basic 重复建设，有竞态风险 |
| README 11 语言全量人工维护 | 上游 docs 也仅 en/zh；建议 en/zh 起步，语言包（locales）另计 |
| skill-sync.ts | DSH registerProvider 模式无需物化到全局目录 |
| builtinAgents.mode、copilot-thinking 形状缓存等 | 无对应宿主物 |

---

## 5. 分期实施计划

> 每期独立可交付、可验证、可回滚（bundle 重装即回滚）。规模标注为一人日粗估。

### Phase 0 · 地基（≈0.5d）
- client 半模块化整理（单模块多 slot 注册即可）；locales 构建引入（en/zh）；插件 volatile Config ns 骨架；`scripts/validate.mjs` 扩展校验新结构。
- 验收：重装后徽标文案来自 locale ns；`settings.describe()` 出现新 ns。

### Phase 1 · 多语言（≈1.5d）
- locale ns 全量注册（zh/en 起步）；（可选）`addLanguage` 挂 ja/ko/es 等既有翻译。
- 会话语言偏好三字段：设置页配置 + 客户端 locale 预填 + 首次会话 `ask_user_question` 温和确认。
- Host 动态 systemPrompt 段注入语言铁律行（order>10200）；三个 SKILL.md 补让渡条款。
- 验收：新会话提示词含语言行；切 UI 语言全部插件文案跟随；技能输出语言跟随配置。

### Phase 2 · GUI 池子与排序（≈3d）
- Host：`dsh-switchman-dispatch` 插件行（static Config：pools/rank）+ capability-default.json 打包 + 纯函数层与测试移植（lane-policy / user-overrides / setup-gate / applyRankMove；scoring 可裁剪为 rank 合成所需子集）。
- Client：设置页（`settings.section`）——六池勾选、拖拽排序、setup 完成度；候选来自 `ctx.llm.listModels`。
- 消费：动态 systemPrompt「池子推荐表」注入；可选 guard（advice 默认 / enforce 可选）。
- 验收：页面配置 → 新会话推荐表变化；enforce 模式越池派发被提示；setup 未完成时推荐表标注未配置状态（不硬阻断——DSH 侧建议软门槛，见 §6-Q3）。

### Phase 3 · 上下文水位（≈4d）
- watcher：tokenMeter + session 投影 → 水位状态机（决策核移植）→ 横幅动态注入。
- 读预算：`tools/pre+post-execute`（read/glob/grep 估算 + 事后记账 + 续读合并 + 15min 重置）。
- force 档：compaction 服务触发 + checkpoint 备份（fire-detached）；与 compaction-basic 阈值协调（§6-Q4）。
- `/ctx-pause` `/ctx-resume`：commands 注册 + 会话级状态 + composer dock GUI 开关。
- 子代理硬顶：`subagent/start|end` + pre-execute deny 收尾指令 + storage 持久登记。
- 验收：长会话横幅随水位更新；超预算读取被 cap 并给出重试参数；force 档自动压缩且留备份；子代理触顶输出 HANDOFF 总结后停止。

### Phase 4 · 可选增强（不排期，按需）
- 健康因子（request-error/llm-stream 失败分类 → rank）；billing/peak 配置系数；更多语言包；README en/zh；setup 硬门槛开关。

---

## 6. 风险与需要你拍板的开放问题

- **Q1 双源配置**：pools/rank（本插件）与 `subagent-model-selection.allowedModels`（出厂）并存。计划按「白名单=准入、池子=推荐」分工，页面加说明但互不改写。是否接受？还是希望池子页代管白名单？
- **Q2 静态/动态分层**：persona suffix（YAML 静态，order 10200）与运行时注入段（语言行/水位横幅/推荐表）分层共存，动态段 order 需协调避免与出厂 TEAM_POLICY 段互相覆盖。实现时会用 `getSectionOrder` 校验。
- **Q3 setup 硬门槛**：opencode 未配置即硬阻断派发；DSH 侧建议默认软门槛（推荐表标注 + 提示），enforce 由开关控制。你的偏好？
- **Q4 与 compaction-basic 协调**：force 档阈值若低于 thresholdRatio(0.8) 对应 tokens 会双触发。计划让 force 默认对齐或高于 0.8 水位、或直接复用 modelPolicies。接受哪种？
- **Q5 hard 档 deny 力度**：默认「cap + 强建议」（读预算仍强制），全量 deny 做成可选严格模式。你的偏好？
- **Q6 语言范围**： locales 翻译已有 11 语种，建议 UI 先开 zh/en（+可选 ja），其余随语言包逐步放开的节奏是否 OK？
- **风险**：DSH 版本漂移（本机 0.2.0-rc.2；出厂 preset plugins 变更需按 README:79 重新同步 cordis.patch.yml）；改 `package.json` 的 `dsh.client` 后需 Host 完全重启（模块判定缓存）；设置页为手写表单，工作量集中在 Phase 2。

---

## 7. 调查来源

- oc-i18n / oc-context / oc-routing / dsh-platform 四份调查报告（本会话团队消息，含完整 file:line 引用）。
- Cordis Inspect 活体查询：Host Service/Event 目录、Client Service/Slots 目录（含 `settings.section`、`plugins.bundle.config`、`settings.models.*` 席位与 `replaceRisk` 标注）。
- dsh-switchman 现仓库：README.md、index.js（技能 provider）、client.js（徽标 + locale 模式）、cordis.patch.yml（四预设 override + 插件 insert 行）。

---

## 8. 实施决策记录（2026-10-01，Phase 0 完成时）

### 8.1 平台验证结论（源码级证据，超越调查报告）

- **市场/插件页展示**：`readPluginMeta`（dsh-app-boot）读 `<pkg>/locale/en.json` + `<lang>.json` 兄弟文件（各含 `meta.title/description`）与 package.json `icon`（≤256KiB 的 SVG/PNG/JPEG/WebP）。→ 本包已加 `locale/{en,zh}.json` + `icon.svg` + exports `./locale/*.json`。
- **安装通道**：`plugin_manager install_bundle` 接受 npm spec（registry 回退 npmmirror）；**peerDependencies 版本不兼容会在 pnpm 前被拒**。→ 本包零 peer 依赖，仅一个 dependencies：`@deepseek-ai/schemastery@3.18.4`（与宿主同版）。
- **settings ns 机制**：ns = 插件模块 `name` 导出（例证：`subagent-model-selection-settings`）；schema 用 schemastery `z.object({...}).volatile()`；volatile 字段在 Host 侧是活引用（`config.<field>.get()`）；持久化落 profile 的 cordis.patch.yml 行 config。→ 本包 ns = `dsh-switchman`，扁平字段（host/config.js）。
- **客户端表单 API**：`ctx.configForms.get(ns)` → scope（`getSnapshot(){status,writable,value,revision}` / `subscribe` / `mutate([{op:'set', path, value}], revision)`）；`ctx.configForms.whileServed([ns], register)` 门控可用性；模型候选来自 `ctx.remote.session.modelCatalog()`（`{groups:[{models:[{provider,model}]}], failures}`）；刷新监听 `ctx.remote.$on('llm/adapters-updated')`。ui-primitives 在平台冻结模块表内可直接 require（含 `SettingsFormModel`）。
- **systemPrompt 动态段**：`section({name, order, text})`，text 可为每次装配求值的函数；外部插件可用任意有限 order（现有 persona suffix=10200，我们用 10300 起）。
- **client 单文件约束**：client bundle 是单自包含入口，不能同步 require 其它相对 client 文件 → client.js 保持单文件、React.createElement 手写。
- **运行时状态目录**：DSH 数据根 = `$DSH_HOME` else `~/.dsh`（dsh-home-paths）；npm 发布后包目录不可写状态 → 运行态状态（子代理 cap 登记等）放 `~/.dsh/dsh-switchman/`。

### 8.2 新增约束（用户 2026-10-01 追加）

1. **npm 正式发布 + dsh-market 兼容**：市场安装即 `install_bundle` npm spec 通道；发布就绪 = validate.mjs 全绿 + `npm pack` 干跑内容审计。
2. **脱敏**：发布前审计（凭据/内部主机名/个人路径/账号信息）。预审：db-query 技能无硬编码凭据（默认 host=127.0.0.1、密码走环境变量、文档为占位示例）。
3. **开发完暂不发布**：发布动作（npm publish）明确推迟，Phase 5 停在干跑。

### 8.3 Phase 5（新增）：发布就绪（不实际发布）

- `npm pack` + tarball 内容审计（files 完整、无多余文件、无 .git/状态文件）。
- 脱敏扫描：grep 凭据模式（password/secret/token/api-key/内部 IP/个人路径）→ 人工复核清单。
- README 双语化（en 主体 + zh）+ repository/homepage 字段核实。
- `plugin_manager inspect`（本地 tarball）+ 全新 profile 安装验证。
- 产出 `docs/release-checklist.md`，等待用户明确指令再发布。

### 8.4 Phase 0 完成状态

- [x] package.json 市场加固（icon/locale/engines.dsh/manifestVersion/files/exports/依赖钉版；移除 private）
- [x] locale/en.json + locale/zh.json（展示 meta）
- [x] icon.svg
- [x] host/config.js：全量扁平 volatile Config（lang ×3 / pool ×6 / modelRank / dispatchEnforce / wm ×8）
- [x] index.js re-export Config；client.js locale ns 化（badge 文案进字典）
- [x] validate.mjs 扩展（市场面检查），当前全绿

### 8.5 Phase 1 完成状态（2026-10-01）

- [x] host/lang.js：`[SWITCHMAN:LANG]` 动态段（order 10300，字节稳定锚点）+ 温和一次性 ask 指引（marker `switchman-lang`）+ `tools/post-execute` 答案捕获 → `settings.update` 持久化；一次性 latch；全防御式
- [x] index.js 接线（inject += systemPrompt/settings）
- [x] 三个 SKILL.md 加 `## Language` 让渡条款
- [x] client.js：settings.section 设置页（语言偏好三行 + 建议值 + 官方同款 draft/revision 保存模型）
- [x] dsh.client.inject += @deepseek-ai/dsh-client-ui-settings（configForms 服务先载）
- 验证：validate.mjs 全绿 + node --check 全过 + 双侧 mock 冒烟测试；真机端到端待用户重启 DSH 后核验
- 硬门不移植（按定案：温和询问 + 设置页预填）

### 8.6 Phase 2 完成状态（2026-10-01）

- [x] host/lib/rank.js：normalizeModelKey / defaultTiers / orderedPool / loadCapabilityDefaults（纯函数 + 179 模型快照）
- [x] host/dispatch.js：`[SWITCHMAN:POOLS]` 动态段（order 10400，未配置静默，configured=n/6 锚点）+ enforce 闸（仅 subagent 显式 provider+model，越界 `{kind:"deny",reason}`）
- [x] host/data/capability-default.json 数据资产
- [x] client.js：六池编辑器（目录 ∪ 已存不可用项、provider 分组、全选/清空）+ 排序编辑器（宇宙过滤、tier 下拉、上移/下移/移出、WYSIWYG 固化）+ enforce 三态 + 进度行；11 字段原子保存
- [x] 修复 config.js 三个加载即崩 bug（块注释终止、z.enum→z.union ×3，shipped schemastery 3.18.4 无 z.enum——实现者以 asar 解包实证）
- 验证：validate.mjs 全绿 + 4+1 文件 node --check + rank 30+ 断言 + dispatch 8 组 mock + client mini-React 全回归 + 真实 schemastery 环境接线测试

### 8.7 Phase 3 完成状态（2026-10-01）

- [x] host/context-watch.js（~430 行）：`[SWITCHMAN:WATERMARK]` 横幅（order 10500；根会话五档 / 子会话三段式 <50% 静默→省用→HANDOFF→触顶）、读预算双闸（post-execute 记账 len/3.5 + inbox 轮重置 + 15min 自清；pre-execute deny(≥hard, 2.4×R*) 或 cap（enrich 追加警示行，形状核实后落地）、force 自动 handover（fire-and-forget compactIfNeeded(agent,"pressure")，幂等协调 compaction-basic 0.8 阈值 = 定案 Q4）、/ctx-pause /ctx-resume /ctx-handover
- [x] 五项形状源码级核实：AssembleContext{agent,scope}、TokenMeasurement.totalTokens、exec.agent 完整 Agent、compactIfNeeded(agent, trigger∈{pressure,context-overflow})、commands handler {commandId,agent,rawInput}→{kind,text}
- [x] client.js：水位区块（8 字段 + min/严格递增校验 + 数字编辑覆盖层 + 命令文案）；19 字段原子保存；字典 94 对 zh/en 程序化对齐
- [x] inject 扩至 7 服务（+tokenMeter/compaction/commands/agents）
- 验证：14 组 mock + 全链路挂载 + Phase 1/2 回归；与 oc 的差异：cap 持久登记不需要（DSH 活体测量）；title/compaction 内部代理可能收到根横幅（待实机观察）

### 8.8 Phase 5 完成状态（发布就绪，未发布）

- [x] `npm pack --dry-run` 审计：**32 文件 / 97.2 kB / 零 node_modules**（files 精确枚举，排除技能本地依赖；`.npmignore` 对 files 白名单无效已实证并移除）
- [x] 脱敏扫描：干净（仅公开 GitHub URL；docs/ 不随包发布）
- [x] README.md（英）+ README.zh.md（中）重写
- [x] docs/release-checklist.md：当日发布流程 + 已知边界
- [x] validate.mjs files 检查同步 files 枚举
- [ ] `npm publish`：**按用户要求推迟**，等明确指令

### 8.9 实机集成记录（2026-10-01，本机 desktop profile）

1. **link 开发模式依赖**：link: 安装的包，其 dependencies 必须装在**仓库自身** node_modules（Node 按真实路径解析）——`npm install` 一次即解决（首次安装报 `failed to import` 的根因）。npm 正式安装无此问题（依赖落 profile node_modules）。
2. **compaction 根注入陷阱**：compaction 服务只存在于各预设的 `isolate: {compaction: true}` 每代理隔离组，根组合没有——根级插件 `inject: ['compaction']` 会永远 pending。已修：inject 移除，`host/context-watch.js` 的 `compactionOf(agent)` 经 `agent.ctx`（预设组合作用域）解析、回落插件 ctx。
3. **模块代缓存**：运行中 Host 对包代码替换有模块代缓存（plugin-manager README 明示），改代码后重装仍报旧错误属预期——**完全退出 DSH Desktop 重开**后才加载新代；客户端模块表的 package.json 元数据缓存同样只到进程重启。
4. **探针验证方法**：用 subagent 探针引用其系统提示词可判定注入层是否生效（根级段如 DSH checkout 说明能到达子代理，我们的段未到达 ⇒ 插件 pending，与 3 一致）。重启后应看到：`[SWITCHMAN:LANG]` 一次性询问指引 + `[SWITCHMAN:WATERMARK] level=ok` 行 + doctrine 段回归。
5. **tarball 识别**：`npm pack` 产物 98KB；`plugin_manager` list_bundles 已正确显示 dsh-switchman 1.3.0（4 个 preset overrides + host 行 + rows）。
6. **市场确认**：用户所指 dsh-market = `dshmarket` v1.66.7（DSH 可视化插件市场，本机已装）；其收录形态即 npm 包 + description/icon，与本包市场化加固完全对齐。

### 8.10 根因修复：受限客户端运行时（2026-10-01，配置页不出现的真因）

- **症状**：重启后徽章、settings.section、plugins.bundle.config 全部不出现；Slots keyDomain 显示 `dsh-switchman` 键从未注册。
- **根因**：client.js 模块导出的服务级 `inject` 含 `remote`/`remote.session`/`configForms` —— 这些是 Web 应用**内部插件的上下文**，不属于动态客户端模块可用的服务目录（实测目录仅 layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces）。浏览器侧 vendored loader 对缺失服务**永远静默等待**（与宿主侧 compaction pending 同构）。对照物：skill-explorer 注入 `['slots','locale','layout']`、dshmarket 注入 `['slots','locale','theme']`，全部 ⊆ 目录。
- **通信通道修正**：受限运行时无直接网络（fetch 被禁列于 dsh-cordis-client-runner：`network belongs to the HOST half`）；boot-graph 客户端（声明 `dsh.client` 的包）走 skill-explorer 模式 —— **宿主半边在 `ctx.webServer.register({kind:'exact',path,handler})` 注册 `/api/<pkg>/*` 路由（loopback+同源信任围栏），客户端文档相对 fetch**（无前导斜杠，base href）。
- **已实施**：新增 `host/routes.js`（GET/POST `/api/dsh-switchman/config` 带 expected 值乐观并发栅栏（409 回新值）、`/models` 经 `sessionController.modelCatalog()` 回落 `llm.listProviders()`、`/health`）；index.js inject += `webServer`；client.js：模块 inject 缩为 `['slots','locale']`、删除全部 configForms/remote/whileServed 用法、页面状态层改为 fetch 加载 + 409 冲突采纳、目录改走路由、settings.section 与 plugins.bundle.config **无条件注册**。
- **验证方法**：重启后查 Slots 目录 `plugins.bundle.config` keyDomain 是否出现 `dsh-switchman`；页面内保存后重开设置页数值保持。

### 8.11 联调收尾（2026-10-01，保存回路修复）

- **候选为空**：sessionController.modelCatalog 的模型条目字段是 `{id, name}`，客户端 indexCatalog 找的是 `model.model` —— 全部条目被跳过。已修为 `model.model ?? model.id` 双形状兼容（client.js indexCatalog）。
- **保存报“本部署没有接受这些值”**：`ctx.settings.update` 的 ns 按**装载条目 id** 查找（dsh-settings write(): `entry.options.id === ns`），即 cordis.patch.yml 的 `- id: dsh-switchman-host`，而非插件 `name` 导出。routes.js 与 lang.js 两处同步改指 `dsh-switchman-host`（后者此前一直静默失败，语言捕获从未真正落盘）。
- **验证闭环**：POST /api/dsh-switchman/config 写入成功；GET 读回一致；写入落在 profile patch 层 `dsh-switchman-host` 行 config（重启持久）；用户 GUI 保存/重开确认数值保持。
- 经验沉淀：**受限客户端运行时的三条铁律** —— ① 模块 inject 只能列浏览器服务目录内的键；② 网络一律走宿主半边 webServer 路由 + 同源 fetch；③ settings 写入命名空间 = 装载条目 id（patch 行 id），不是插件名。
