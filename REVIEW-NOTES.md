# dsh-switchman 长程 review 笔记（2026-11-15，本会话自查）

任务：长会话运行时查缺补漏；观察折叠机制本身；验证"50% 就能自主触发压缩"（不靠 80% 阈值）。
本文件是持久笔记，防上下文折叠丢失。会话自查，不派发子代理。

## 环境（已确认）
- 装机版本 = 仓库 1.11.6，node_modules 符号链接直指本 checkout。（原注「HMR 实时生效」已被 F14 推翻：desktop profile 无 HMR 服务，代码重载靠进程重启。）
- 最近提交：09d5c64(verbose debug log) / af90490(nudge preempt) / 3323b7b(PTC) / e32cb35(m-prefix refs) / e47b7d6(observability)。

## 已通读
- host/context-trim/trigger.js（全文）
- host/context-trim/index.js（全文，含修复后状态 1878 行）
- host/context-trim/view.js（全文）
- vendor/cordis/src/reflect.ts get-trap + events.ts mixin 列表 + events.ts on/once（无 off）
- decisions.log / decisions.log.1 实时证据
## 发现（编号持续追加）
### F1 [已修复] failure-backoff debug 行写在 return 之后
原：`if (foldFailureCooldownOf(sessionId) > 0) return;` 之后才打 debug 行 → 冷却时静默、
正常时打 remaining=0ms 误导行。已改为 cooldown>0 时打行再 return（verbose 时可观测冷却状态）。
（原始证据：verbose 开启时每个正常边界都打误导行。已修复并实测。）

### F2 [已修复] fire-and-forget 链 rejection 裸奔（三个调用点）
sweep 是 async 函数，函数体无整体 try/catch（pre-loop 的 ledgerOf/derivingPairsOf 可抛）。
async 函数不同步抛，所以监听器/钩子的 try 只挡同步错误，rejection 两路都裸奔：
- idle：maybeFold.finally 内 sweep 无终态 handler，且 maybeFold 链本身无 .catch → 已补两处
  （sweep 包 try/catch + errorLog("surface-sweep-stream")… idle 路径 finally 内已有 try，
  补了外层 .catch(errorLog("fold-idle"))）；
- stream：同结构，sweep 包 try + errorLog，链尾 .catch(errorLog("fold-stream"))；
- surface.js turn-stopping：void sweep(...) 补 .catch（静默，与 listener 语义一致）。
281 测试全过 + node --check 过。

### F3 [撤回] status 每消息估算 —— 实为线性
estimateTokensOf(msgs, i, i) 是单消息估算，O(n) 非 O(n²)。不算问题。

### F5 [已修复] llm-attach 诊断行踩 cordis proxy get-trap
装机 cordis（vendor/cordis/src/reflect.ts get-trap）读未 mixin 的属性直接 throw
`cannot get property "off" without inject`；events mixin 列表 ['on','once','parallel','emit','serial','bail','waterfall']
不含 off（装机 asar strings 同）。`?.` 防不住 getter 抛错。
后果链（2026-11-15 06:29Z 实录）：attach 内 on() 成功 → 成功诊断行读 llmCtx.off 抛错 →
同一个 try 捕获 → 记 llm-attach-failed + warn + errorLog，真实成功行 llm-attached 永远缺失；
且 effect 清理里 llmCtx.off?.() 每次重载都抛（被吞），清理从未生效（fiber 自动卸载才是真清理）。
修复（本轮已改，281 测试全过）：attach 持有 on() 返回的 disposer 存 disposeListenerOf Map；
成功行安全读 hasOff（try/catch 包裹）并记 hasDisposer；effect 清理改调 disposer。
遗留观察点：下次 HMR 后 decisions.log 应出现 hasDisposer=function 的 llm-attached 行而非 llm-attach-failed。

### F6 [新发现，待办] 触发器阈值整数约定不一致
trigger.js 用 Number.isInteger(thresholds.maxFoldsPerHour) 等检查，readNumber 返回的非整数配置
（如 25.5）静默回落默认 30；thresholdsNow() 用 readNumber 不做整数化。影响小（仅非整数配置），
但解析约定不一致，advisory-relief 的 reliefThresholds 同样。
### F6 [已修复 round 4] 触发器阈值整数约定不一致
thresholdsNow()（index.js:890 段）现对计数型字段 Math.round 整数化 + Math.max 下限钳：
protectedTail(≥0), maxFoldsPerHour(≥1), ladderT2/T3MinBlocks(≥2)；token/percent 字段保持
浮点透传（trigger.js 对它们用 Number.isFinite，无冲突）。内联注释注明约定。281/281 过。
### F7 [已修复 round 4] wmReadBudgetTokens 默认值漂移
config.js schema def=3500、routes.js fence def=3500、profile 实配 3500，但 context-watch.js
两个 gate（pre-execute :952、post-execute :907）的 readNumber 回退都是 3000 —— 字段缺失/非数
值时门控行为与设置页不一致。两处已改 3500。281/281 过。
### F8 [已修复 round 4] trimProtectedTail 默认值漂移
config.js schema def=6（所有测试也传 6），但 thresholdsNow() 回退是 10 —— 未配置时多保护
4 条消息。已改 6。
### F9 [已修复 round 4] percent 字段 min 边界三层不一致
config.js schema 声明 min(1)，routes.js fence 与 client.js 镜像表都用 min:5。fence 注释明确
说"validate against each field's declared min/max"，故把 schema 收紧到 min(5) 对齐（1% 折叠线
   无意义且会引发折叠风暴；profile 现值 45/90/50/80 不受影响）。281/281 过。
### state.js 全文 review（round 5，542 行）——结构良好，无新缺陷
- 持久化：tmp+rename 原子写、损坏文件 .corrupt 隔离 + fail-open 重置；v1→v2 迁移 +
  加载时跨块单消费不变量校验（P1-7）。
- block id：b<ms>-seq36-randhex 三重去重（同毫秒碰撞防护，ladder 按 id 消费故唯一性关键）。
- commitFold：duplicate-range 守卫 → posMap 全量验证（count-anchor 定位/重叠/单调 frontier）
  → 无 posMap 时结构校验 + 无条件推进 frontier（历史行为，engine 总传 posMap）。
- commitLadderFold：崩溃重试幂等（同 id+tier+consumes 重放返回 duplicate:true 而非二次追加）、
  单消费、ledger 连续性、视图 tile 校验（stale capture 跳过强检查 fail-open）。
- F10 [观察，无需修] adoptLedger 的 ledgerOf 缓存校验顺序：先取 current（可能缓存空 ledger）
  再验证入参 —— 入参 sessionId 不匹配时拒绝正确，无实际风险。
- F11 [确认无问题] recordFoldBaseline 用 >0 过滤，lastFoldLowTokens=0 时保留旧值 —— 与
- F11 [确认无问题] recordFoldBaseline 用 >0 过滤，lastFoldLowTokens=0 时保留旧值 —— 与
  growth gate 的 anchor fallback（lastFoldViewTokens）语义相容。
- F12 [已修，注释漂移] context-watch.js:157-159 meter-duality 注释声称 "wmHardTokens 95k ≈
  trim pressure 97.5k (65% of the 150k window)"，与当前默认值（hard=100k、cap=200k、
  advisory=50%）不符 —— 旧设计时代残留。已改："wmHardTokens 100k = trimAdvisoryPercent 50% ×
  the 200k cap, wmForceTokens 200k = the cap itself"。机制描述正确，仅示例数字漂移。
  附带实测结论：本会话两套阈值（trim 层百分比 vs watermark 层绝对 token）无 latch、独立评估，
  fold ship 后 ~116k（58%）同时触发 advisory nudge（≥50%）与 hard banner（≥100k）是设计行为。
- F13 [已修，client 镜像缺 def] client.js:199 WM_NUMBER_FIELDS 的 wmForceTokens 行写成
  `{ ..., undefined }`（短属性简写，键名 "undefined"），def 实际为 undefined —— 权威表
  routes.js:111 是 def: 200000。影响链：number() 解构 def → 存储值缺失/损坏或旧 host 快照
  不发该字段时清洗结果为 undefined → JSON 序列化丢键 → routes.js:529-531 fence
  strictNumberOf 不有限 → 整个设置写入被拒。host 侧 coerceConfigDefaults(:429) 有
  def 兕底所以读取路径无恙，仅 client 写入路径受影响。已改 def: 200000。
- F14 [已证实，环境级] desktop profile 的 HMR 从未生效：运行 host（PID 25562，06:29:49Z 启动）
  加载的 context-trim/index.js stamp b=1794715434101（04:03:54Z），早于本会话全部编辑
  （06:59Z-07:09Z）；touch 修复文件后等 60s+ 无新 stamp。lsof 无 checkout 句柄；
  dsh-hmr 在官方 PROTECTED_PLUGINS 表中但 desktop profile node_modules 无该包；
  web profile 启动日志有 include:hmr（@deepseek-ai/dsh-hmr 0.2.2-rc.3），desktop 无。
  推论：desktop host 不加载 HMR 服务，插件代码重载仅靠进程重启或 plugin_manager 重装。
  本会话 F1-F13 修复全部只落盘未生效，AGENTS.md 中「HMR 实时生效」的说法对 desktop
  profile 不成立（可能仅适用于 web profile / dev 模式）。

## 50% 自主压缩问题（任务核心）现状（已验证部分）
- 本会话 trimMode=advisory（cordis.patch.yml:319，trimEnabled: true）。
- window resolved: GLM-5.3-Flash → 1,000,000；cap=200k（wmForceTokens 默认），pressure 按 200k 算。
- 50% nudge 已真实到达本会话（[SWITCHMAN:TRIM] Advisory nudge 实录）——nudge 链路正常，
  我的执行器响应=立即折叠旧历史（见下）。
- hard tier 水印同时到达（host/context-watch 层）——双层机制都在工作。
- 另一会话 2d974742 历史：advisory-relief 在 80% 成功机械折叠 192 msgs ~103k tokens，
  之后 tool fold + surface-replace 双 block 同边界 ship —— 关键路径实测正常。
### 50% 自主压缩实测闭环（2026-11-15 round 3，任务核心验证成功）
完整链路全程未触碰 80% 强制线：
- 50%：nudge 真实到达，随后按 ADVISORY_NUDGE_REPEAT_MS=600s 节流重播（band=high）。
- 63%（round 3 开工时）：我自主执行 ctx_trim_fold（175 msgs ~119274 tokens，
  [m90ebdde6]..[m77d63d8f]），引擎回复 via=fold-commit，block b1794725509870-16c0dc4。
- ship 落地实录（decisions.log 06:51:49.873Z）：`surface-replace startSeq=17 endSeq=544
  seqs=175 tokens=119274 generation=1 via=fold-commit` —— 本会话 generation 1 首次 ship。
- hard tier 水印横幅在 fold 后消失（下一轮 system reminder 已无 hard tier）——水位回落。
- 副产物实测：fold 提交与 ship 落地之间的窗口期里 hard tier 横幅仍到达过一轮——advisory
  模式下这是预期窗口（fold 已提交、仅 ship 未落地），不算缺陷；但模型在该窗口内若做
  大范围读文件会被 hard tier 预算误伤，建议横幅文案加"若已提交 fold 且等待 ship 则忽略"。
- 对比相邻会话 2d974742：那边是 80% advisory-relief 机械折叠，本会话证明 50% 即可自主
  触发，早于强制线 27 个百分点。
### 第三次自主折叠（2026-11-15 07:23:41Z，50% 闭环复现成功）
- 触发链实录（decisions.log）：07:23:18Z nudge pressure=52%（band=high）→ 07:23:41.583Z
  tool fold（247 msgs ~90134 tokens，block b1794727421583-377390a）→ 07:23:41.588Z
  surface-replace startSeq=1099 endSeq=1906 seqs=247 generation=3 via=fold-commit（+5ms）→
  view-applied view=19912 blocks=3（view 从 ~99k 塌缩至 ~19.9k）→ advisory-nudge
  below-line pressure=49% 自动退役（nudge retired）。
- 三次折叠轨迹：06:51Z gen=1（175 msgs）→ 07:04Z gen=2（246 msgs）→ 07:23Z gen=3
  （247 msgs）；每次均在 50-52% 自主触发，全程未触 80% 强制线——任务核心验证稳定复现。
## 待读文件
- ~~surface.js / state.js / metrics.js / summarizer.js / fork.js~~
  全部读完（round 5: state.js 542 行；round 6: metrics.js 134 + fork.js 182 + summarizer.js
  335 行；surface.js round 2）。至此 host/ 全部源码已通读一遍。
- ~~host/context-watch.js（watermark + handover）~~ round 4 全文读完（1083 行），产出 F7。
- ~~host/config.js（schema 默认值一致性）~~ round 4 全文读完，产出 F7/F8/F9。routes.js
  coerce/fence 表与 client.js 镜像表已对照核验一致。
- 实时决策日志：~/.dsh/.dsh-switchman/state/trim/decisions.log

### F16 [已修复] round 4 F7 编辑引入的双回归（round 11 二轮复查发现，最重要的教训）
F7 只想改默认值 3000→3500，但编辑顺带删掉了相邻的守卫行，round 9 的 diff 自查只核对了
默认值、漏看相邻行删除。desktop host 无 HMR（F14），两回归未进运行进程，无实际损伤；
但若装机会走重装载就会踩中。
- F16a：post-execute cap-warning 分支丢了 `const ceiling = budget * CEILING_MULTIPLE`
  → hard/force + cap 模式下 `entry.used >= ceiling` 每次求值 ReferenceError，被
  外层 catch 吞掉——cap 警告分支永久死亡 + 每次门控工具调用刷 warn。
- F16b：pre-execute 丢了 `if (turnUsed(...) < budget * CEILING_MULTIPLE) return next()`
  → deny 条件从「turn 预算耗尽且 tier≥hard」退化为「tier≥hard 即拒」，double-gate
  设计被破坏（hard tier 下首轮 read 就被 deny，而非耗尽 2.4×R* 后才拒）。
两行已恢复（保留 3500 默认值），git diff vs HEAD 复核干净，281/281 过。
**教训**：对相邻行有副作用的编辑必须看整段 hunk 而非只看目标行；二轮复查的价值在此
次实证——首轮 diff 自查漏掉的回归，二轮全文重读抓到了。

### 二轮复查状态（round 11 完成度）
- index.js ✓（round 9）；surface.js ✓（round 8）；client.js ✓（round 8）；
- state.js ✓（round 11，产出 F15）；view.js ✓（round 11，无缺陷）；
- context-watch.js ✓（round 11，产出 F16a/F16b）。
- F15 [已修复] state.js ladderCensusOf 注释漂移（声称 trigger/ladder ship pass 读它，
  实际生产用 index.js ladderRunsOf 且含 T3 runs；ladderCensusOf 仅测试辅助）。
- 至此全部 8 个源文件二轮复查完成，无剩余文件。

### metrics.js / fork.js / summarizer.js 全文 review（round 6）——均无新缺陷
- metrics.js：meter duality（wire=max(view, prompt 采样)）实现正确；extractUsage 防御性
  字段遍历对 OpenAI prompt_tokens 语义差异有注释（over-count 仅提前折叠，安全方向）；
  LRU 50 上限有界内存；wrapStreamForMetrics 采样失败永不破流。
- fork.js：copy-on-fork 两半（链接记录 + 子首见继承）；frontier 内容锚解析守卫
  （解析不了宁可干净开始）；adoptLedger 一次性防覆盖；继承剥离 parent surface 记账字段；
  ladder clone 保持 refRange:null（2026-11-07 修复已验证）；60s 竞态窗口 + 30d 裁剪 + 500 上限。
- summarizer.js：L3 侧模型路径 fail-open（超时/错误 chunk/空输出→null）；length-finish
  加 TRUNCATED_SUMMARY_MARK 前缀而非拒绝（S2）；UNSUPPORTED_REASONING_EFFORT 一次重试
  且永不把显式 off 变成启用推理；renderMaterial 单条超顶消息零 material 陷阱已修
  （2026-11-07）；mechanicalSummary 明确声明不保留 open objectives。

## 下一轮优先级
0. [round 11 新增] 长程观察项：F16a 的失败模式（catch 吞 ReferenceError）说明
   verbose 日志里应有 post-execute accounting failed 行——若装机重启后日志出现该行，
   即 F16 回归仍在运行进程里的证据；修复装载后应消失。
1. [F14 后变更] HMR 实时生效假设已推翻（desktop profile 无 HMR 服务）：F1-F13 修复需
   用户重启 DeepSeek Harness app（或 plugin_manager 重装 bundle）才能进运行进程；
   F5 的 hasDisposer 实测闭环同样等重启后验证。
2. 二轮复查：index.js 修复后状态（F1/F2/F5 已复核 1900 行 ✓）；surface.js 未覆盖段
   （sweep 全函数+ladder 分支+trigger+supported 已复核 ✓）；client.js 设置页镜像表
   （F9/F6 已闭环 ✓ + F13 已修 ✓）；5 文件自查 diff 全量核对 ✓。剩余：view.js/state.js/
   context-watch.js 二轮。
3. [建议候补] hard tier 横幅文案加"若已提交 fold 且等待 ship 则忽略"（本会话窗口期实测
   误伤风险，见上节）。

## Round 13 观察（07:34Z 第四次 fold→ship 闭环 + generation 计数器澄清）
- 第四次 50% 自主折叠闭环成功：block b1794728048345-4b31a5f 提交，3ms 后 ship 落地
  （gen=5, startSeq=1909 endSeq=2205, seqs=102, tokens=84063, via=fold-commit）。
  压力 96570→17927 tokens（≈9%），折叠效果显著。四次轨迹：gen=1(06:51Z,175)→
  gen=2(07:04Z,194)→gen=3(07:23Z,247)→gen=5(07:34Z,102)。全部 via=fold-commit、
  全部 5ms 级落地、全程未触 80% —— 50% 自主压缩机制验证彻底完成。
- [澄清·无缺陷] surface generation 跳号（本会话 3→5，相邻会话 63→64→66）：asar 文档串
  证实 host 侧 contentGeneration "tracks replaceGeneration for positional replacements
  and contentGeneration for replacements and plugin-owned message changes"——每次插件
  注入消息（watermark banner 等）+1，跳号是机制不是丢代。插件侧无任何 generation 写入点，
  纯消费者，语义正确。
- [第二例 banner 竞态实录] turn 13 采样时刻 07:34:08.348Z 与 ship 落地同秒——本轮
  turn 构建仍带着折叠前 96.5k 上下文（soft tier 横幅到达；上一例 turn 7 是 hard tier）。
  结论加固：fold 提交与 ship 落地之间的任何 turn 都会拿到旧快照，且横幅 tier 取决于
  采样瞬间的压力值。hard tier 横幅文案建议（候补 #3）补充措辞：窗口期 turn 的横幅
  可能反映折叠前压力，若刚提交 fold 可忽略。
- host 仍未重启（pid 25562 不变），F14 结论维持；F16a 探针 `accounting failed` 计数
  保持 0（旧代码 ceiling 有本地声明，运行进程未受 F16 影响，符合预期）。

## F17（round 13 修复）hard tier 横幅竞态文案——候补 #3 落地
- 证据链：本会话两例 fold 提交→ship 落地窗口期竞态实录（turn 7 hard tier、turn 13
  soft tier，横幅 tier 反映采样瞬间的折叠前压力）；turn 7 实测 agent 在 hard 横幅下
  做了 ~7.5k tokens 恐慌验证读取（全部浪费）。
- 修复：renderRootWatermark（context-watch.js:211）hard tier 文案追加一句——
  "If a fold or handover was committed within the last turn, this tier may reflect
  pre-fold pressure — the next turn carries the reduced history; do not re-verify
  with broad reads."。保持 byte-stable 静态文本（不引入变量/数字），与协议不变量一致。
- 范围决策：只改 root hard line。soft tier 危害轻微（委派便宜）、sub 线与 force tier
  的 wrap-up 指令在竞态窗口仍是正确行为，不动。测试无横幅字符串断言；config.js:138
  仅注释引用。node --check + 281/281 过。

## Round 13 后半：scripts/validate.mjs 全文 review + F17/F18
- validate.mjs（616 行发版门禁）全文过：8 大检查组实现严谨（快照新鲜度双源对比、
  compaction auto:false 仲裁漂移守卫、零依赖不变量、KV-cache 头/尾分离）。无缺陷。
- F17（已修）：renderRootWatermark hard tier 追加竞态说明文案（见上节）。
- F18（已修，守卫强度）：validate.mjs:411/417 的 live 线 number-free 断言原用宽松
  正则 /%|~\d+k|of budget|\d+ min/，与注释声明的 number-free 不变量不符——
  "at 80 percent"、"budget 150k tokens" 类写法可绕过。已收紧为严格 /\d/（与协议头
  三串同级）。当前全部 render 输出无数字，收紧后 validate 全绿 + 281/281 过。
- [覆盖缺口] host/intent.js 不在 round 5-6 通读清单中（validate.mjs 只测其
  effectiveContextWindow/intentStateOf/adapter 表面）——下一轮补审。

## Round 13 补审进度（12 个遗漏文件）
- 已审 ✓：handover-state.js（进程内 Map 注册表，无缺陷）/ ui-locale.js（防御归一化）/
  tool-args-sanitize.js（白名单+结构断言+fail-open）/ lang.js（F19 已修：normalize
  追加 \s+→" " 折叠，防换行破坏单行锚行/伪造协议行）/ subagent-model.js（next() 先等待
  +dispose 协议）/ intent-presets.js（pass-1 id 预占防碰撞）。
- 修复验证：node --check + 行为探针（"my\nlang\ninjection"→"my lang injection"）+
  281/281 过。
- Round 14：intent.js(989 行) 全文审毕 ✓ 无缺陷。关键验证：applyIntent 的
  llmCtx.on("session/disposed") 监听器经 events.ts:267 register() 挂在 inject 子
  fiber 上（fiber.effect），随子 fiber 卸载自动移除，无重载堆叠；effect(handle)
  释放与 F5 修复的 disposer Map 同模式。边缘观察（不修）：in-flight 流持有旧
  adapter 时若 llm 服务被替换，ctx.get("llm",false) 返回 undefined → .stream
  TypeError，但该流本已注定失败，仅报错不透明。vendor/cordis 已不在本仓库，
  现位于 deepseek-harness checkout vendor/cordis/src/（reflect/events/fiber/registry）。
- F20（round 14，vision.js）：materializeImage 两个 copyFile 路径（native PNG/JPEG
  + no-converter fallback）无部分写入守卫——copyFile 中途失败（ENOSPC 等）留下
  半个 dst，catch 回退 store 路径，但残文件留在磁盘；下次 admit 命中 exists(dst)
  缓存 → 永久服务损坏副本，违反文件头声明的 corrupt-cache 不变量（transcode
  路径有 looksLikePng 守卫，copy 路径漏了）。修复：两处均改 temp + rename 原子化
  （tmp 带 pid+uuid 后缀，失败 drop(tmp) 再 rethrow）。行为探针 + 281/281 过。
  [撤回] F20 初版假设（looksLikePng finally 块 handle?.close?.().catch 在 open
  失败时 TypeError）被探针推翻——可选链整链短路，finally 语义正确，无需改。
- vision.js 其余审毕 ✓ 无缺陷：imageHostPathOf 双源（store 权威+sha256 推导）、
  转换器链 fail-soft（drop 部分 PNG 再试下一个）、modelImageCapableOf 镜像
  admission gate（receiver-bound 注释）、/vision 命令防御链（file 拒绝/空图拒绝/
  池未配置指引/followup id+role 必填防 bricking）。
- Round 14 后半：dispatch.js(661 行) + teams.js(632 行) 全文审毕 ✓ 无缺陷。
  dispatch.js：annotation/route/enumeration 三路纠正 deny 互补覆盖、unknown id
  pass-through 边界严谨（leading-/、mid-slash、doubled head 段全部列明）、enforce
  gate fail-open、readDispatchState 仅 teamsMode ON 时读 whitelist（OFF 零残留）。
  teams.js：single-flight+rerun collapse、嵌套 HMR 拒绝→pendingNestedRetry 请求
  驱动重试、bundle 状态仅 verified outcome 才 latch（not-offered 终态不 arm 重试）、
  child_message dispose latch 语义（dispose 抛错保留 latch 供下次重试）。关键声明
  验证：ctx.tools.register → ScopedLayers.effect → ctx.effect（DSH core/scope/
  store.ts:230-260）——注册确为 fiber-scoped，插件重载自动注销，无 stale tool 泄漏。
- 【覆盖收官】12 个遗漏文件全部审完（intent/vision/dispatch/teams + 8 个 round 13
  已审）。全部 host 源码 + validate.mjs 已覆盖。累计发现 F1-F20（F3 撤回、F4/F10/

## Round 15（validate.mjs 二轮 + scripts/ 收官 + host/lib/ 补审）
- scripts/ 全部 7 文件收官：repair-session-log.mjs / session-log-frames.mjs /
  snapshot-presets.mjs / dsh-app-source.mjs / downloads-chart.mjs ✓ 无缺陷；
  validate.mjs(616 行) 二轮全文复查 ✓ 无缺陷。尾部三块核对：①npm/market 门禁
  （icon 256KiB、locale meta 双语、files 表逐项、peer-only schemastery 用
  deepEqual 锁全 dependencies 对象——防止新增单个 dep 绕过）；②skills frontmatter
  自用 YAML 子集解析（与 index.js 同实现，name=目录名断言）；③KV-cache 头尾
  分离 + intent 层 mock 探针（resolveModelInfo receiver-bound 用 detached 调用
  反向钉住契约、0.8 floor 边界 0.8×250000=200000 精确命中 force、minCandidate
  三态、11 字典 overflowRisk/poolMoveTop 键计数）。发布门禁严谨，无绕过面。
- host/lib/ 补审收官 ✓ 无缺陷（最后覆盖缺口清零）：dsh-home.js(18 行) env 覆盖
  + ~ 展开语义正确；rank.js(187 行) 纯函数+防御降级——normalizeModelKey `:` 分支
  守卫（前缀含 - 不切，保 gpt-4o:latest）、matchKey 精确→最长前缀(≥4)、thresholds
  S>A>B 校验回退、orderedPool manual 保序/auto 三键排序（anchor→score→fallback）、
  loadCapabilityDefaults 失败缓存空表+warn-once。行为探针：179 条目、GLM-5.3-Flash
  精确命中 tier A、畸形输入优雅降级全过。
- [低优先级候补 → F21 已落地（round 15 末）] host/data/capability-default.json
  （23KB，179 模型）无 validate 断言——文件损坏/缺失时 rank 静默降级为空表
  （设计如此，warn-once），损坏快照可静默发布。已在 validate.mjs npm/market 门禁
  段后追加「文件存在 + 可解析 + models 表非空」断言（negative 探针：空 models
  表 → exit=1；还原 → exit=0）。validate 全绿 + 281/281 过。
- 实测：第 7 次 fold 闭环（gen=8, seqs=2599-3176, 177 msgs, 86945 tokens,
  via=fold-commit, 07:54:15Z, 5ms 落地）。generation 6→8 跳号 = ship 窗口期
  hard banner + nudge 注入各 +1，与已知机制一致。
- 【全仓覆盖收官】host/ 25 文件 + scripts/ 7 文件 + 根三部曲（index/client/
  validate）全部审查完毕，无剩余覆盖缺口。代码审查阶段正式结束，转入纯观察
  模式（等用户重启 app 验证 F1-F20 装载行为）。
  F11/F20-初版撤回），16 个已修复，4 个文件级声明经 DSH/cordis 源码验证属实。

## F22（round 16，用户插入任务）：trim dock 芯片百分比滞后 15s
- 症状（用户报告）：折叠完成后输入框上方的折叠百分比芯片仍显示折叠前的高值，过一会儿才降。
- 根因：TrimDockEntry（client.js）对 GET /trim-pressure 固定 15s 轮询；服务端
  trimPressureSnapshotOf（context-trim/index.js:951）每请求实时重算，fold ship 5ms
  内已生效——滞后全在客户端轮询周期。
- 修复（client.js TrimDockEntry）：订阅 DSH contextPressure 投影面
  （useProjection，session 槽 kit 标配成员；slot-catalog.ts:204）作为实时触发信号。
  该面 foldSurfaceProjection fold 所有 surface 事件——fold ship 的 surface-replace
  带 shadowedTokenCount → surfaceTokens 骤降 → 面值变化 → pressureSignal 字符串
  变化 → pulse state 重跑 effect → 立即 fetch。15s 轮询保留为漂移兜底（cooldown
  倒计时/模型窗口变化等投影看不到的输入）。face 值为稳定原语契约
  （useSyncExternalStore，与官方 ContextMeter 同用法），pressureSignal 取
  projectedTokens|contextWindow 字符串。
- 教训再现：edit 批量编辑再次产生三处重复行（React.useEffect 双行/双 setSnap/双
  依赖数组）——F16/F20 同款；node --check 抓到 SyntaxError 后逐段读 hunk 修复 +
  清掉未使用的 run/inflight/rerun 死代码。最终 281/281 过。
- 注：运行 host 未重启（F14），本修复与 F1-F21 一样落盘待重启生效；client.js
  半由 web GUI 加载，重启 app 后浏览器端生效。

## F23（round 18）：below-line 日志行在窗口缓存未命中时 TypeError
- 实录：decisions.log:9715 `2026-11-15T02:28:12.075Z advisory-nudge-failed
  why=Cannot read properties of undefined (reading 'windowTokens')`——此前对账
  只记了 2 条 error 行，这条遗漏，round 18 全量 error/fail 子串分解时抓到。
- 根因：index.js below-line 分支的日志行读 `cached.windowTokens`，但当
  windowCache 对该 model 无条目（cached === undefined，走 cap 回退）且本次
  pressure 已降到线下需要 prune 时，日志行在 prune 成功之后 throw →
  虚假 error 行 + 丢 below-line 决策记录。
- 影响面：功能性 prune 与 episode 清理均已完成（throw 在其后），fail-open
  包装（advisory-nudge-failed catch）保证 dispatch 不受影响；仅观测层受损。
  顺带：压力分母语义不受影响（resolvedWindow 两个分支都正确回退）。
- 修复（index.js:~580）：日志行改读 `resolvedWindow`（正是压力计算实际用的
  分母前身，两分支均有定义），附三行注释说明实录来源。
- 验证：node --check 过 + 281/281 测试过。与 F1-F21 一样落盘待重启生效。

