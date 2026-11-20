# 意图识别自动选模型（Intent Routing）设计

状态：待 rc.3 侦察确认后冻结实现。本文是 host/client 并行实现的契约，字段名与 JSON 形状改动必须先改这里。

## 0. 需求（用户拍板）

1. 主会话模型选择器（输入框下拉）出现「自动」入口；选中后由 switchman 按当前对话内容自动路由真实模型。
2. 新增独立配置分组【意图识别】：分类器用小模型（本地部署或云端，支持 TypeSafe Jev 类「决策模型」与通用对话模型两类）。
3. 候选列表独立配置（不与 poolMain 复用）。
4. 每条用户消息分类一次；同一轮（turn）内后续模型步锁定该决策。
5. 缓存续用：厂商 prompt cache 约 5 分钟。当前模型与分类最优差异不大（置信度不足）且仍在缓存窗口内 → 沿用当前模型；置信度足够高或当前模型不在候选 → 必须切换。

## 1. 架构决策（依据 DSH 0.2.1-rc.2 侦察，rc.3 待核对）

- **挂点 = `agent/request` waterfall**（官方 per-call model override 机制，`installModelSelection` 即参照实现，packages/core/agent/src/model-selection.ts:97-110）。插件在宿主 ctx apply() 时注册 → 位于 installModelSelection 更外层 → `const config = await next()` 拿到会话选择 → 若是伪模型则分类决策 → **返回改写后的 LlmCallConfig**。prepareCall 收到改写后配置，能力校验/日志全部按真实模型走。
  - 不能用 `llm/stream`（loop 请求深冻结、next() 零参，无法改写）。
  - 不用 `sessionController.selectModel` 切换（它追加 `[model changed]` 消息 = 主动制造 cache 断点 + 污染会话记录）。改写在调用层静默完成。
- **伪 provider = `ctx.llm.registerAdapter(["dsh-switchman-auto"], adapter)`**：让「自动」出现在原生 ModelCatalog（composer 下拉原生渲染）。rc.3 已核实（LlmAdapter packages/llm/llm/src/index.ts:208-303）：
  - 仅 `stream()` 抽象必须实现；`listModels` 必须覆写（默认空数组→目录分组被 `models.length>0` 过滤），返回 `[{provider, id:"auto", name, description}]`；`resolveModel` 最小实现 `{provider, id, name}` 即通过 selectModel 全部校验；`providerInfo` 返回 `{id:"dsh-switchman-auto", name:"Auto · Switchman"}`（composer 分组标题，host 侧固定）；不提供 reasoning（picker 不出 effort 子菜单，伪模型 effort 无意义）；context 给 `{contextWindow: 128000}` 兜底。
  - 目录准入无 endpoint/key 检查（catalog.ts:22-77）。
  - adapter.stream 仅兜底（agent/request 拦截失效时）：按状态机取路由（pinned/routedCurrent/兜底链），`yield* ctx.llm.stream({...options, provider: 真实provider, model: 真实model})`——新对象+真实 provider 不会重入伪 adapter；日志会记伪路由，仅 last resort。
- **「自动」入口本地化 = client 注入官方 `conversation.input.model.label` slot**（ui-model-selection slots.ts:16-38，ModelSelect.tsx:437-445）：owner payload `{provider:{id,name}, model, placement:'trigger'|'menu'|'option', selected}`；provider.id 匹配伪 provider 时返回本地化文本「自动（意图识别）」，否则**必须显式渲染 model.name**（单席位 slot 的 owner fallback 只在席位无注册时生效，见 ui-renderer scoped-slots.tsx SlotOutlet single 分支；注册后返回 null = 空白标签）。菜单条目本身靠伪 provider 进 catalog 自动出现。
- **不需要 `agent/inbox/claimed` 监听**：分类输入在 agent/request 时点直接 `ctx.sessions.get(sessionId).snapshotEvents()` 读（该时点本轮用户消息已准入，session-title/src/index.ts:137-146 是提取参照：user/message + source.kind==='user'，text block join）。单一监听器，最简。
- **分类器调用照 session-title-llm 模式**：`ctx.llm.prepareCall({provider, model, maxTokens}, deadline(signal, timeoutMs), configure→effort)` + GenerateOptions（省略 purpose，自发调用不带 agent-loop 标记，天然不重入我们的 agent/request 监听器——监听器只认伪 provider）+ BlockAssembler 收流，finish error/aborted 转 throw → fail-open。

常量：`AUTO_PROVIDER = "dsh-switchman-auto"`，`AUTO_MODEL = "auto"`（catalog 分组名/显示名在 rc.3 侦察后定，目标显示「自动（意图识别）」）。

## 2. 配置字段（host/config.js，`// --- Intent recognition` 组，全部 .volatile()）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| intentEnabled | boolean | false | 主开关；关 = 伪模型被选中时直接走兜底链，不发分类调用 |
| intentClassifierRoute | ModelRouteSchema | {provider:"",model:""} | 分类器小模型路由 |
| intentClassifierEffort | string | "" | 可选 reasoning effort pin（空=adapter 默认） |
| intentClassifierKind | union(["chat","systemone"]) | "chat" | 1.8.0 收敛为两通道、必须显式指定：chat=直接选 LLM 目录（route+effort）；systemone=手填端点+手填模型（auto/decision 已移除，host zod 加载直接拒绝旧值 auto/decision；client 快照读取归一为 chat；patch 文件已迁移） |
| intentCandidates | Array<IntentCandidateSchema> | [] | 独立候选列表；IntentCandidateSchema = {provider, model, effort?, note?}，note 是给分类器看的一句话能力描述 |
| intentCacheTtlSeconds | number(min 0) | 300 | 缓存续用窗口 |
| intentSwitchConfidence | number(0-100) | 80 | 分类置信度 ≥ 此值才允许离开当前模型 |
| intentTimeoutMs | number(min 200) | 3000 | 分类调用预算；超时/失败 fail-open |
| intentHistoryMessages | number(1-20) | 6 | 喂给分类器的最近消息条数 |
| intentHistoryMaxChars | number(200-20000) | 2400 | 摘录总字符预算 |
| intentContextWindow | number(>=1024) | 200000 | Auto 伪模型声明的上下文窗口（token）：驱动用量浮层与自动压缩水位（原硬编码 128k，1.8.0 起可配） |
| intentCandidates | Array<IntentCandidateSchema> | [] | 独立候选列表；1.9.0 起 IntentCandidateSchema = {id, preset?, enabled?, provider, model, effort?, note?}，读取端经 mergeIntentCandidates 与内置预置分类合并 |
| intentFallbackRoute | ModelRouteSchema | {provider:"",model:""} | 可选兜底模型；空 = 用候选第一位 |

### 2.1 预置分类（host/intent-presets.js，1.9.0 起）

内置 8 个预置分类，对齐六泳道心智（economy/mechanical/main/hard/review + docs/vision）：quick-chat / mechanical-edit / codebase-exploration / general-coding / deep-reasoning / code-review / docs-writing / vision-input。

- **合并规则（mergeIntentCandidates）**：预置永远全部在场且排前、顺序固定；存储条目按 id 覆盖预置的 provider/model/effort/enabled，但 **note 恒为代码值（不可改不可删）**；未知 id 降级为自定义行（向下兼容）；无 id 的旧条目派生稳定 id（`user:<provider>/<model>`，重复加 #n）；带 id 的半成品行可在保存/快照往返中存活，匿名全空行剔除。
- **生效规则（effectiveIntentCandidates）**：`enabled && provider/model 非空` 才进分类器；预置出厂 enabled=true + 模型空 → 填上模型即激活（UI 行内显示「未选模型」提示）。**同路由归并**：多条候选映射同一模型时（如 6 个预置都指 flash），分类器前会归并成一行——note 为组内全部非空描述按序拼接（完整携带用户映射，避免只取首条导致其余映射被静默忽略）、effort 取组内首个非空、组内相同描述去重。
- 预置描述为英文、面向分类器措辞（每条含互斥锚点，如 codebase-exploration 的 "Output is an explanation, not a diff"）。
- routes.js：快照输出合并后的完整列表（含空模型预置）；coerceValues 保留 id/preset/enabled、强制预置 note 回代码值；schema 放宽 provider/model 允许空（仅带 id 行合法存活）。

routes.js 镜像：BOOLEAN_FIELDS += intentEnabled；NUMBER_FIELDS += intentCacheTtlSeconds/intentSwitchConfidence/intentTimeoutMs/intentHistoryMessages/intentHistoryMaxChars；ENUM_FIELDS += intentClassifierKind（["chat","systemone"]）；STRING_FIELDS += intentClassifierEffort；对象/数组字段照 poolX 的处理方式进 coerceValues（对象字段 {provider,model} 沿用现有 route 校验逻辑——rc.3 recon 后按 routes.js 现状对齐，池数组怎么校验 intentCandidates 就怎么校验）。

## 3. 分类协议

输入（单条 user message，system 一句话）：
- 候选清单：`#编号 provider/model — note`（当前路由模型标注 `(当前)`，中立提示「无明显优势时倾向当前模型」）
- 对话摘录：最近 intentHistoryMessages 条 user/assistant 纯文本，总量截到 intentHistoryMaxChars

要求输出严格 JSON：`{"best": <编号>, "confidence": <0-100>, "scores": {"<编号>": 0-100}?}`（scores 可选）。

解析宽容链（chat 通道）：① 直接 JSON.parse → ② 抽第一个 `{...}` 平衡段 → ③ markdown 代码块内 JSON → ④ 首个裸整数行（best，confidence=100）。全失败 → fail-open。
kind=systemone（1.8.0 新增，2026-10-24）：绕过 llm.prepareCall，直接 `fetch(intentClassifierEndpoint)`（ollama `/v1/systemone` 决策端点）。请求 `{model, state, questions:{best:{type:"choice", instructions, criteria}}}`——criteria 是有序 map：键 `#N provider/model (current)`（当前路由加后缀），值 = 候选 note；state = 候选清单行 + 倾向当前模型提示 + 对话摘录（键与 state 双列候选，实测可显著锐化 probabilities）。响应 `answers.best.choice` 原样回显 criteria 键 → `keys.indexOf(choice)` 精确映射回 0 基索引。置信度优先 `probabilities[choice]`（真实分布），退 `min(1, confidence)`，再退 0（保持当前模型）；×100 保留 1 位小数。超时 AbortController + `AbortSignal.any(turnSignal)` 合并取消；intentClassifierEndpoint 未配置/HTTP 非 2xx/choice 未知键 → throw → 外层 fail-open。payload model 来自独立自由文本字段 `intentClassifierSystemoneModel`（不取自 route——与 LLM 供应商目录完全解耦，模型无需注册 provider）；guard 放宽为 `kind==='systemone' || classifier!==null`，即 systemone 不再要求分类器 route，未配端点/模型 → throw → fail-open。配置语义两分（1.8.0 收敛，2026-10-25）：chat = 下拉选目录模型、走该 provider 标准 chat API（endpoint 即 provider baseURL）；systemone = 手配端点 + 手配模型。auto/decision kind 已删除（decision 的裸整数 prompt 分支移除；宽容解析仍接受裸整数以兼容旧回复）。设置页按 kind 条件显隐对应行（systemone → 端点+模型行，其余 → route+effort 行），SettingsRow 新增 `hidden` prop。

## 4. 决策状态机（host/intent.js）

per-session 模块级 Map（照 handover-state.js 模式；`session/disposed` 事件清理）：

```
state = {
  pinnedTurnKey,   // `${sessionId}:${最新一条 kind=user 的 user/message 事件 id}` 已决策的轮（2026-10-25 起按消息 id，见步骤 2；缺 id 退 seq，无用户消息退 no-user）
  decision,        // {provider, model, effort?} 本轮锁定结果
  routedCurrent,   // {provider, model, effort?} 上一轮实际路由（跨轮缓存续用依据）
  routedAt,        // 上次路由时间戳（决策落点与 pin 命中都续期——滚动窗口）
  lastDecision,    // {best, confidence, at, switched: bool} 供 UI 展示（at = 决策时间戳，不随 pin 命中变动）
}
```

路由入口 = 伪 adapter 的 `stream()` → `routeAutoRequest`（§1 的 agent/request waterfall 已弃用：step 准备阶段固定 provider/model，listener 改写会 throw，见 host/intent.js 文件头；2026-10-24 迁移，2026-10-25 回写契约）：

1. `config = await next()`；`config.provider !== AUTO_PROVIDER` → 原样返回（非自动会话零开销）。
2. 轮内锁定（2026-10-25 修正）：GenerateOptions 无 turn/step 字段（waterfall 弃用后流层拿不到轮号，原 `` `${sessionId}:${turn}` `` 数字 pin 是死代码——每次模型调用都重新分类，agent 自主干活时 dock chip 决策持续变化，每步白付一次分类调用）。现 pin key = 最新一条 `source.kind==='user'` 的 `user/message` 事件 id（缺 id 退 `seq:`，无用户消息退 `no-user`）：同一条人类消息内所有模型步复用决策，且 **pin 命中同样续期 routedAt**（滚动窗口规则：同路由持续命中 = 厂商缓存持续在用；lastDecision.at 不动——它是决策时间戳）；goal 轮（kind `goal`）、compaction/recall（kind `plugin`）、`subagent-settled` 通知等其他 source.kind 的 user/message 不触发重分类（与摘录的用户消息准入同判 type+kind；摘录另要求非空文本并纳入 assistant 消息，条件略窄）；新用户消息或 intent-reset 后重新分类。
3. 首次：读会话最近消息（snapshotEvents）→ 分类（本地 deadline 超时，不引 @deepseek-ai/dsh-timeout 依赖，自写 AbortController+setTimeout）→ 决策：
   - `intentEnabled=false` 或候选空 且无兜底 → 保持伪模型原样返回（adapter 兜底 stream 会再兜一层并告警）。
   - 解析失败/超时 → 兜底链：routedCurrent → intentFallbackRoute → 候选[0]（都不存在则保持伪模型原样返回）。
   - best 对应候选 == routedCurrent → keep（刷新 routedAt）。
   - routedCurrent 不在候选列表 → 必须切换到 best。
   - confidence ≥ intentSwitchConfidence → 切换。
   - `now - routedAt < intentCacheTtlSeconds` → keep（缓存续用；**滚动窗口**：keep 分支与步骤 2 的 pin 命中分支同样刷新 routedAt——厂商 cache 命中即续期，轮间隔超过 TTL 时自然过期切换。复审确认语义可接受，2026-10-24 回写契约；pin 命中续期为 2026-10-25 复审必修项）。
   - 否则 → 切换。
   - 自引用防护：候选/兜底/现路由中 provider === `dsh-switchman-auto` 的一律剔除（routeOf/readCandidates/decideRoute 三层），防止 rewrite 落回伪 provider 导致 adapter 兜底无限重入（复审必修项修复）。
4. 写 state（pinnedTurnKey/decision/routedCurrent/routedAt/lastDecision），返回 rewrite(config, chosen)。

分类调用（步骤 3 内）：`ctx.llm.prepareCall({provider: intentClassifierRoute.provider, model: intentClassifierRoute.model, maxTokens: 512}, signal, configure→intentClassifierEffort 非空时设置 reasoningEffort)` + GenerateOptions（省略 purpose）+ BlockAssembler 收流，finish error/aborted 转 throw → fail-open。分类器 provider 必为真实 provider ≠ AUTO_PROVIDER → 不重入本监听器。

rewrite 规则：`{...config, provider: chosen.provider, model: chosen.model, reasoningEffort: chosen.effort || undefined}`——伪模型上用户选的 effort 一律忽略（真实模型未必支持，避免 UNSUPPORTED_REASONING_EFFORT）；候选条目未 pin effort 时省略该字段让 adapter 默认物化（rc.3 recon 确认省略安全性）。

分类器自发调用防递归：不标 agent-loop、provider 是真实 provider ≠ AUTO_PROVIDER → 不会重入。

## 5. 路由与 client 契约

- `GET api/dsh-switchman/intent-state?session=<id>`（routes.js ROUTES 表 + intentState handler，照 vision-state 形状）：
  ```json
  {
    "enabled": true,
    "autoSelected": true,          // 该会话 modelSelection 是否伪模型
    "configured": true,            // 候选非空 + 分类器就绪（systemone：端点+模型已填即就绪，不要求 route）
    "current": {"provider":"...","model":"..."} | null,
    "lastDecision": {"best":"...","confidence":86,"at":1730000000000,"switched":true} | null,
    "cacheWindowRemainingMs": 123456,
    "candidates": [{"provider":"...","model":"...","note":"..."}]
  }
  ```
  per-session 读取复用 sessionModelSelectionOf（subagent-model.js:70 observeSession 通道）。
- `POST api/dsh-switchman/intent-reset` body `{session}` → 清该会话 state（调试/重置记忆）。
- client dock chip（新 slot 条目 `conversation.input.dock` / order 89，VisionDockEntry 是 90）：autoSelected 时显示「自动 → provider/model (+置信度)」；非自动会话渲染 null。15s 轮询 intent-state，失败渲染 null（fail-silent）；另订阅输入 kit 的 draft：非空→空跳变（发送瞬间）触发 400/1800/4000ms 三次补拉，配合 tick 的 inflight/rerun 串行化，决策落定后亚秒级上屏（1.8.1 起）。
- client 模型标签 slot：注入官方 `conversation.input.model.label`（ui-model-selection），owner.provider.id === 'dsh-switchman-auto' 时按 placement（trigger/menu/option）返回本地化「自动（意图识别）」文本，否则显式渲染 model.name（单席位无 per-dispatch fallback，返回 null 会空白）。
- 设置页【意图识别】section：开关、分类器 route 选择器（复用池编辑器的 route row）、kind 两选（chat/systemone，必须显式指定）、**决策端点文本输入 + 决策端点模型文本输入**（仅 kind=systemone 时显示；留空且意图开启 → 行内「未设置」警示行；模型 placeholder `tev1:4b-mxfp8`，自由填写不经供应商目录）、分类器 route 选择器与 effort 文本（systemone 时隐藏）、候选分类编辑器（每行卡片：行首启用开关 + provider/model/effort + 行尾删除（预置行显示 Preset 徽标不可删）；描述独占下一行整行 textarea 自动增高，预置行只读；预置行上方显示英文标签；启用但未选模型 → 行内提示；自定义分类可增改删，新增行带客户端生成 id；快照读自 mergeIntentCandidates）、兜底 route 选择器、五个数字输入（含上下文窗口，渲染顺序与代码一致）。词典键 `intent*`，11 个内联词典（zh/en DICTS + EXTRA_UI_DICTS 9 语言）全补（systemone 六键：KindSystemone/EndpointLabel/EndpointHelp/SystemoneModelLabel/SystemoneModelHelp/intentEndpointUnset；注意 it/fr 文案内撇号需转义 `\'`）。

## 6. 文件接线清单

1. host/config.js：intent* 字段组 + IntentCandidateSchema 导出。
2. host/intent.js（新）：applyIntent(ctx, config) + intentStateOf + 决策状态机 + 分类器调用 + 解析器（纯函数分离便于测试）。
3. host/routes.js：ROUTES 表 2 条新路由 + intent-state handler + intent* 镜像字段（snapshotOf/coerceValues/四个镜像数组）。
4. index.js：import + applyIntent(ctx, config)（inject 列表不变——需要的服务 ctx.get 取）。
5. client.js：词典 + readCurrent/canonical/desired 字段 + 设置 section + dock chip slot。
6. locale/en.json zh.json：meta.description 顺带。
7. README.md（主）+ 后续各语言变体。
8. cordis.patch.yml：不动（纯插件功能）。

## 7. 风险与已排除方案

- ~~llm/stream 改写~~：不可行（冻结+零参 next）。
- ~~selectModel 静默切换~~：追加 notice 消息 = cache 断点。
- 伪 provider 会出现在 DSH 其他 provider 列表 UI：接受，文档说明。
- syncWhitelist 六池并集不含伪 provider：子代理白名单不受污染 ✓。
- rc.3 API 漂移：**已核对完毕（2026-10-24），清单内全部 API 零语义变化**（agent/request、LlmAdapter、registerAdapter、listProviders、buildModelCatalog、resolveModelInfo、selectModel、ui-model-selection）。
- **挂载生命周期（2026-10-24 实测教训，已修复）**：applyIntent 必须用 `ctx.inject(["llm"], …)` 挂载，不能用一次性 `ctx.get("llm", false)`——插件 apply 可能先于 llm 服务入 store，一次性读取必然 undefined → 层永久 no-op（表现为选择器无 Auto 组）。且 `registerAdapter` 的 backing effect 活在 LLM fiber 上而非本插件 fiber，必须在本侧 effect 里显式 `handle()` 释放，否则插件重载（任意设置变更）会 DUPLICATE_ADAPTER。cordis `_unload` 保证旧 disposer 全部排空后才重跑 apply，同步释放无竞态。`routeAutoRequest` 第二参必须是插件 live config（曾经误传 downstream 选择对象 → intentEnabled/candidates 恒空 → 分类静默短路，只走 fallback 链）。
- **systemone 分类器实测（2026-10-24，ollama 0.40.10 / tev1:4b-mxfp8）**：契约限制 questions 1–64 字段、state 非空、criteria 键→描述(null 可)。冷启动（模型换入显存）0.8–2.3s，intentTimeoutMs 建议留足（当前 30000ms）。tev1 不支持 chat 通道——systemone 是它唯一可用的调用方式。置信度语义：probabilities[choice] 与 confidence 可能差距大（如 0.97 vs 0.82），以 probabilities 为准更锐利。分类延迟稳定后 ~160–200ms。

## Amendments (2026-10-25, post-1.8.0)

Three behavior amendments shipped after 1.8.0; they override the sections above where noted.

- **(a) Configurable context window with an effective-value floor.** `intentContextWindow` is configurable (default 200000), replacing §adapter's hardcoded `contextWindow: 128000`. The value declared by `resolveModel` (and reported by intent-state) is `effectiveContextWindow(config)`: `max(user, ceil(wmForceTokens / 0.8))` while `wmAutoHandover` is on, else the raw user window. Rationale: the whole point of a custom Auto window is to position DSH core's 0.8×-window auto-compaction line (compaction-basic's default `thresholdRatio`, a documented assumption — docs/porting-plan.md §1) AFTER switchman's absolute force-tier handover, so the smooth four-step handover always fires before the cruder single-shot compaction. Users who turn automatic handover off get their raw window respected — they opted out of the handover pipeline.
- **(b) OFF = degraded-resident adapter, not unmounted.** `applyIntent` no longer skips mounting when `intentEnabled` is off. The adapter is always registered; OFF only makes `listModels` return `[]` (read per call from the live config), which hides the Auto group because the selector drops adapters with empty model lists. This closes the gap left by §config's "OFF = the pseudo model routes through the fallback chain" row and §adapter's always-mounted assumption: a session already on Auto keeps streaming through the documented fallback chain (routedCurrent → intentFallbackRoute → first candidate) with NO classifier call, and toggling the switch re-exposes the catalog entry without a remount. When nothing is routable at all (disabled + no fallback + no candidates), `routeAutoRequest` returns null and the adapter's stream now throws an explicit error ("pick a concrete model") instead of the old TypeError on `route.provider`.
- **(c) intent-state candidate-window probe.** `GET intent-state` gains a `context` object: `{contextWindow, minCandidateWindow, minCandidateModel, overflowRisk}`. `minCandidateWindow` is the smallest real context window across the candidates, probed via `llm.resolveModelInfo(provider, model)` — the call must stay receiver-bound (see host/vision.js): fetch the service with `ctx.get("llm", false)` and call it on the llm object; every failure reads as null ("don't know"), fail-open. `overflowRisk = minCandidateWindow !== null && minCandidateWindow < wmForceTokens` (no enabled gating): informational only — it drives a dock-tooltip warning line (dictionary key `intentDockOverflowRisk`, `{model}`/`{window}` params) when a candidate is narrower than the handover line and may overflow near the cap. Routing behavior is unchanged (context-aware routing is out of scope).

