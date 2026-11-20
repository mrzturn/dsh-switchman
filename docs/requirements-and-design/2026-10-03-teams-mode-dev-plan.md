# dsh-switchman 升级实施计划（已拍板 + 待办）

日期：2026-10-03 ｜ 状态：方案已获用户拍板，待实施
源码参考：/Users/mrzturn/Documents/code/my/GitHub/deepseek-harness（0.2.1-alpha.1，装机 0.2.0-rc.2）

## 已拍板决策

1. **白名单同步语义 = replace**：六池并集去重后整体覆写 DSH「允许 Agent 为子智能体选择模型」，switchman 为唯一事实源。
2. **开关 OFF 不禁用 Agent Teams bundle**：只停规程注入与检测，不调 `setBundleEnabled(false)`（避免撤走运行中会话的 Team 工具）。
3. **修掉 fork 限制**：`cordis.patch.yml` 四个预设的 `tool-subagent-fork` 行加 `modelSelectionSettings: true`。

## 功能规格

- 新配置：`teamsMode`（主开关，默认 off）+ `syncWhitelist`（白名单同步子开关，默认 off）。
- **OFF（默认）**：纯 subagent 派发模式。团队条款（反转保守策略 + spawn_teammate 触发条件 + 任务板纪律）从 persona suffix 抽出、不注入 → DSH 出厂保守团队策略自然接管；`authorizedChildRoutes()` 不调用（dispatch.js 置 null，⚠not-authorized 标记自动消失）；设置页 unauthorizedBadge 同步隐藏。
- **ON**：注入 `[SWITCHMAN:TEAMS]` 动态段（order 建议 10250，在 persona suffix 10200 之后、POOLS 10400 之前）；保留白名单实时检测；异步编排：`ctx.pluginManager.setBundleEnabled('@deepseek-ai/dsh-experimental-agent-team-profile', true)` → `ctx.settings.mutate('subagent-model-selection-settings', [...], revision)` 同步六池并集。

## 关键 API 备忘（源码已核实）

- 白名单写入：`ctx.settings.describe()` 取 revision → `settings.mutate(ns, [{op:'set',path:['enabled'],value:true},{op:'set',path:['allowedModels'],value:[...]}], expectedRevision)`（deepseek-harness packages/settings/settings/src/index.ts:302,347,367）。写后 configEditor 文件锁+热生效+UI 自动刷新。
- 不变量：`enabled=true` 时 allowedModels 必须非空且 (provider,model) 唯一，否则新会话组装 `current()` 抛错（tool-subagent/src/model-selection-settings.ts:54-56）→ 空池跳过同步。
- bundle 开启：`ctx.pluginManager.setBundleEnabled('@deepseek-ai/dsh-experimental-agent-team-profile', true)`（boot/plugin-manager/src/index.ts:451）。**不得在插件 apply 同步路径调用**（HMR 事务禁嵌套，boot/hmr/src/index.ts:262），从设置变更回调 setImmediate/queueMicrotask 异步触发。
- 白名单 enforcement 为**每新会话快照**（"Applies only to new sessions"，tool-subagent/src/index.ts:638-641,699-701）——同步只对之后新建的顶层会话生效，需在 UI 注明。
- 白名单只约束 `subagent` 工具显式路由；隐式派发 / subagent_fork(未开 settings 时) / workflow / spawn_teammate 均不经它。

## 新增需求（设计已定稿，调查 subagent 722fa090 已核实）

4. **子智能体模型可见性**（两条路径均可行，b 为主 a 为辅）：
   - **(b) 子会话内显示（主路径，纯 client 改动）**：扩展现有 `conversation.session.header.actions` 徽标（slot 是 session-scoped，props 带 sessionId，ui-conversation/contract/slots.ts:156-162）渲染当前会话实际模型：已 retain 会话用 `sessions.binding(sessionId).session.projections.faceOf('modelSelection')`（活更新）；未 retain 的子会话 fallback `remote.session.projections({sessionId})` 一次性拉取 + 缓存（session-controller/src/index.ts:497-519）。切换会话按 sessionId 重建 face。
   - **(a) 父会话派发点显示（辅路径，host 改动）**：`ctx.on('tools/post-execute')`（waterfall 存在，core/tools/src/index.ts:171-176；`PostToolDecision = {kind:'accept', content?}` :617-620，accept.content 替换模型可见且落日志/UI 的 content blocks，先例 experimental/claude-code-mods/src/index.ts:436-447）。命中 `subagent`/`subagent_fork` 时向结果 content 追加一行 `model: provider/model@effort`；模型真值从子会话投影读：`ctx.sessionQuery.observeSession(sessionId).projections.values.modelSelection`（session-query/src/index.ts:89-93，冷会话可用不激活 Agent；权威记录=子会话 request/header 的 `EpochHeader.config`）。必须 next() 透传、处理 background/continuable 两种结果形态。
   - 事实备忘：DSH UI 现状处处不显示子会话模型（SubagentHeaderLineage.tsx:240-250 仅 label/mode；process 分组只计数；会话列表无模型）；one-shot descriptor 无模型字段（descriptor.ts:136-137），continuable 才有（:76-81）。
5. **vision chip 误报修复**：`visionStateOf`（host/vision.js:220-225）的 `imageCapable` 取自 root 会话模型且路由无会话参数 → 子会话误报。修法（定稿）：`/api/dsh-switchman/vision-state` 增加 session 参数，服务端按该会话 `modelSelection` 投影解析其模型再判多模态（复用需求 4 的 observeSession 通道）；会话未知时回退 root 判定。client 轮询时携带当前 conversation 的 sessionId。

## 实施顺序（建议）

1. `host/config.js`：新字段 + Config schema。
2. `cordis.patch.yml`：suffix 拆分（基础纪律留静态；团队条款抽出）+ fork 行加 `modelSelectionSettings: true`（四预设）。
3. `host/teams.js`（新）：动态段 + 设置回调异步编排 + agentTeams presence 检测。
4. `host/dispatch.js`：authorizedChildRoutes 条件化（仅 ON）。
5. `client.js`：开关 UI、徽标条件化、白名单同步状态展示、（依调查结果）模型可见性 + vision chip 修复。
6. 验证：>20 行交 tester；总改动预计 >300 行 → 交独立 reviewer（作者模型 ≠ 复审模型）。

## 已完成

- AGENT.md（fork 位置 + 同步授权 + 开发注意）。
- 可行性调查两份（白名单机制、Agent Teams 启用机制），结论见上文 API 备忘。
