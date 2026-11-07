# dsh-switchman 逐模块深度巡检报告

巡检范围（按阅读顺序）：`host/context-trim/state.js` → `host/context-trim/view.js` → `host/context-trim/trigger.js` → `host/context-trim/summarizer.js` → `host/context-trim/surface.js` → `host/context-trim/index.js` → `host/context-watch.js` → `host/config.js`。
巡检方式：逐文件完整阅读源码，每个文件记一节（导出函数职责 / 参数与返回形状 / 边界条件与失败模式 / 问题与可疑点），最后通读全报告追加总结。
本报告由主会话亲自完成，未派发任何子智能体。

---

## 第一节 host/context-trim/state.js（514 行）——台账（ledger）存储层

### 1. 模块概览

本模块是 context-trim 子系统的持久化底座：每个会话一份「折叠台账」，记录有序的 fold block 列表及元数据（frontier、上次折叠的视图 token 估计、每小时折叠节奏限制、fork 继承标记）。台账以 JSON 文件形式存放在 `<dshHome>/.dsh-switchman/state/trim/<sanitized-session-id>.json`，写入采用 tmp+rename 原子替换；文件损坏时 fail-open（重置台账，绝不因簿记数据毁掉会话）。台账格式 v2 引入 T1/T2/T3 阶梯折叠：每个 block 带 `tier`（1=原始区间折叠，2=蒸馏活跃 T1，3=蒸馏活跃 T2）、`active`（被阶梯块消费后置 false，块永不删除以保持覆盖可表达）、`consumes`（被吸收的 ledger 连续块 id 列表，T1 为 `[]`）。阶梯块 `refRange` 为 null——其材料是被消费块的摘要而非原始消息；原始折叠前沿（frontier）是 T1 独有概念。

### 2. 导出一览（模块级）

| 导出名 | 形状 | 职责一句话 |
|---|---|---|
| `LEDGER_VERSION` | `const 2` | 当前台账文件格式版本 |
| `tierOf(candidate)` | `(unknown) → 1\|2\|3\|null` | 旧版 tier 字符串/数字 → 数值 tier；非法返回 null |
| `isLadderBlock(block)` | `(any) → boolean` | 判断是否阶梯块（tier 2/3 的对象）；null/非对象安全返回 false |
| `emptyLedger(sessionId)` | `(string) → Ledger` | 构造空 v2 台账 |
| `normalizeBlock(candidate, now)` | `(any, number) → Block\|null` | T1 候选的公开规范化入口（阶梯候选被拒，走 commitFold 内部路径） |
| `createStore(options?)` | `({stateDir?, warn?}) → Store` | 创建存储实例（惰性缓存 + 提交 + 持久化） |
| `ledgerFoldedTokens(messages, ledger)` | `(Message[], Ledger) → number` | 估算台账中 T1 原始区间折叠的 token 总量（测试/巡检用） |
| `ladderCensusOf(ledger, countTokens?)` | `(Ledger, fn?) → {t1, t2}` | 活跃 T1/T2 种群普查（trigger 与阶梯派发读取） |

### 3. 逐函数细节

#### `tierOf(candidate)`
- 职责：兼容旧版 tier 字符串（"emergency"/"pressure"/"growth"/"model" → 1）与数值 1/2/3 直通；其余（含 undefined、字符串垃圾、0、4）返回 null。
- 边界：`null`/非值安全；数字 2、3 会直通，这意味着 v1 迁移路径上一个声称 tier=2 的记录会以 tier 2、空 consumes 进入 `normalizeStoredBlock` 并被整判为非法记录（见问题 #2）。

#### `isLadderBlock(block)`
- 职责：`block.tier === 2 || block.tier === 3` 且 block 为非 null 对象。
- 备注：state.js 内部并未使用此函数，属于对外契约（推测 view/trigger/surface 使用，待后续章节核对）。

#### `emptyLedger(sessionId)`
- 返回形状：`{ version: 2, sessionId, blocks: [], frontier: null, lastFoldViewTokens: 0, lastFoldLowTokens: 0, lastFoldAt: 0, foldsThisHour: [], inheritedFrom: null, inheritedAt: 0 }`。
- 边界：不校验 sessionId 类型；空串也照单全收（`createStore` 侧才有 sanitize）。

#### `normalizeStoredBlock(record)`（内部，加载/迁移共用）
- 职责：把一条持久化记录规范成 v2 形状；结构性不可用返回 null。
- 校验链：id 非空字符串 → summary trim 后非空 → tierOf 非法拒绝 → count 为正整数 → approxTokens 有限正数否则回退 `count` → kind 仅识别 "mechanical"（其余一律归 "summary"）→ consumes 必须是非空字符串数组且无重复（过滤后长度必须与原长度相等，否则整条拒）→ tier≥2 且 consumes 空 → 拒（阶梯块失去消费清单即覆盖不可知）→ tier===1 时 refRange.firstId/lastId 必须非空字符串（用 `?.` 取，refRange 为原始类型不会崩）。
- 附带：`surfaceSeqs`/`surfaceReplaced`/`surfaceSkip`/`surfaceHeadClamped` 四个 surface 簿记字段原样携带（不做形状校验，交给 surface.js 解释）。
- 边界：`active` 仅在显式 `false` 时为 false，其余一切值（含 undefined、字符串"false"）都按 true 处理——宽容方向正确但意味着手改文件写 `"active": "no"` 会被当成活跃。
- 失败模式：任何一步失败返回 null，由调用方决定整文件重置。

#### `upgradeLedgerFile(parsed, sessionId)`（内部）
- 职责：v2 直读（逐块 normalize，全过才收）；v1 升级（每个记录强制 `tier: tierOf(record.tier) ?? 1, active: true, consumes: []` 再 normalize）；其他版本/形状返回 null。
- 关键失败模式：**全有或全无**——任何一个 block 记录非法，整个文件判废（`blocks.some(null) → null` → 调用方重置并改名 `.corrupt`）。一个坏块会带走全部折叠历史（见问题 #2）。
- v1 迁移的隐患：v1 记录若带数值 tier 2/3（正常 v1 不可能，但手改/损坏文件可能），会被塞入空 consumes 后在 normalizeStoredBlock 被拒 → 整文件判废。方向安全（不会让幽灵阶梯块混入），但后果是重置而非跳过。

#### `hydrateLedger(sessionId, parsed, blocks)`（内部）
- 职责：从解析后的文件字段 + 已规范化 blocks 拼装内存台账；标量字段逐个做 `Number.isFinite` / `typeof` 防御，foldsThisHour 过滤非数值时间戳。
- 边界：不校验 frontier 是否真的指向某个块；脏 frontier 会原样进入内存（宽容设计，下游 view/trigger 需容忍）。

#### `normalizeBlock(candidate, now)`（公开，T1 候选）
- 参数：candidate 为调用方（index.js 的 fold 事务）构造的原始块；now 为时间戳。
- 返回：v2 形状 block（自动分配 id：`allocateBlockId`），或 null。
- 与 commitFold 前半段逻辑几乎重复（字段校验、approxTokens 回退、kind 归一），属于**两份手工同步的代码**，存在漂移风险（见问题 #8）。
- 边界：带非空 consumes 的候选直接拒（阶梯候选必须走 commitFold 派发路径）；id 允许调用方指定（透传非空字符串）。

#### `createStore(options?)`
- 参数：`{ stateDir?: string（测试注入，赢过 dshHome 默认）, warn?: (msg) => void（软失败通道，默认 noop） }`。
- 返回 Store：`{ ledgerOf(sessionId) → Ledger（缓存）, commitFold(sessionId, candidate, posMap?, now?) → Result, recordFoldBaseline(sessionId, viewTokens, lowTokens) → Ledger, adoptLedger(sessionId, ledger) → boolean, persist(ledger) → boolean, stateDir: string }`。
- 注意：`commitLadderFold`/`locateT1Range` 是闭包内私有函数，外部只能通过 commitFold 的 consumes 派发触达——封装良好。

#### `ledgerOf(sessionId)`（闭包内）
- 职责：惰性加载 + 内存缓存（Map: 原始 sessionId → ledger）。文件存在则 JSON.parse → upgradeLedgerFile；判废/异常时 warn 并尽力 `renameSync(file, file + ".corrupt")` 留证，然后以空台账继续。
- 失败模式：JSON.parse 抛错、读权限错误、文件是目录等一切异常都走「重置 + 改名」；改名也失败则静默吞掉（下次加载再试）。
- 关键点：加载失败也**写入缓存**（空台账），本进程内不会再尝试读盘。

#### `persist(ledger)`（闭包内）
- 职责：`mkdirSync(recursive)` → 写 `<file>.tmp` → rename 原子替换；任何异常 warn + 返回 false。
- 边界：无 fsync（进程崩溃可能丢最近一次持久化，属可接受的簿记损失）；无跨进程锁。

#### `locateT1Range(positions, refRange, count)`（闭包内）
- 职责：按「计数锚定」在 posMap 里定位区间：遍历 firstId 的出现位置列表，取首个满足 `firstIdx + count - 1` 恰好落在 lastId 位置列表里的组合。
- 返回：`{firstIdx, lastIdx}` 或 `{reason: "refs-not-found" | "count-mismatch"}`（用 `reason` 字段区分失败，调用方以 `located.reason !== undefined` 判断——形状上是「成功对象无 reason」的判别联合）。
- 边界：依赖 refPositions 返回升序列表；同一 ref 多次出现（fork 后消息 id 复用？）取最早可行对。

#### `commitFold(sessionId, candidate, posMap?, now?)`（公开）
- 派发：candidate.consumes 为非空数组 → `commitLadderFold`；否则走 T1 路径。
- T1 校验链：字段校验（同 normalizeBlock 前半段，**代码重复**）→ 构造 block → 精确重复区间守卫（对台账所有块线性扫描 refRange 相等即拒，含 inactive 块——正确的：被消费 T1 的覆盖仍在）→ 有 posMap 时 locateT1Range → 与每个有 refRange 且能在当前 posMap 定位的既有块做**重叠检查**（`firstIdx <= eEnd && eStart <= lastIdx` 即拒 "overlaps-existing-fold"）；posMap 定位不了的旧块跳过（fail-open）。
- 成功副作用：push block、`ledger.frontier = block.refRange.lastId`、lastFoldAt=now、foldsThisHour 滑窗（3_600_000ms）清理后 push now；写缓存。**不持久化**（注释明说 memory only，由调用方 persist）。
- 返回形状：成功 `{ok: true, ledger, block}`；失败 `{ok: false, reason}`，reason ∈ invalid-block / duplicate-range / refs-not-found / count-mismatch / overlaps-existing-fold（以及阶梯路径的一组 ladder-*）。

#### `commitLadderFold(sessionId, candidate, posMap, now)`（闭包内）
- 校验链：tier 必须 2/3 → consumes 过滤后非空 → summary 非空 → **幂等重放**：同 id + 同 tier + consumes 逐项相等的已提交 summary 块 → 返回 `{ok: true, block: existing, duplicate: true}`（崩溃重试语义，绝不二次追加）→ 每个 consumed id 必须存在（ladder-consumed-missing）、active（ladder-consumed-inactive）、tier 恰好低一级（ladder-tier-mismatch）→ 累加 approxTokens、收集块索引 → 索引必须严格连续（ladder-not-contiguous；重复 id 天然被连续性检查拒绝）→ 有 posMap 时做视图邻接检查：逐块 locateT1Range，`located.firstIdx !== prevEnd + 1` 即拒 "ladder-not-adjacent"；无 refRange 的块（T3 消费 T2）跳过；定位失败（过期快照）则 break 放弃检查（fail-open，结构校验兜底）。
- 成功副作用：构造 `refRange: null, count: consumes.length` 的块；先把所有被消费块置 `active = false`，再 append、更新 lastFoldAt/foldsThisHour。同样不持久化。
- 返回形状：同 commitFold，外加成功时可能带 `duplicate: true`。

#### `adoptLedger(sessionId, ledger)`（公开，fork 继承）
- 职责：把 fork.js 构造好的父台账收编为子会话台账。一次性：子会话已有任何 block 或已有继承标记即拒（返回 false，真实状态永不被覆盖）；ledger 为 null/非对象/`sessionId` 字段不匹配也拒。
- 副作用：写缓存 + persist；返回值取 persist 的布尔结果。

#### `recordFoldBaseline(sessionId, viewTokens, lowTokens)`（公开）
- 职责：记录上次折叠时刻的视图 token 估计（growth 闸基线）与低水位 token，持久化并返回台账。
- 边界：非有限或 ≤0 的入参被**静默忽略**（不重置基线——无法主动清零）。

#### `ledgerFoldedTokens(messages, ledger)`
- 职责：对每个有 refRange 的块，在 messages 的 posMap 里定位并用 `estimateTokensOf` 估算区间 token，累加；定位不到的块跳过。返回数字。null/缺字段 ledger 安全（`ledger?.blocks ?? []`）。

#### `ladderCensusOf(ledger, countTokens?)`
- 职责：遍历 `active === true` 的块，产出 `{t1: Entry[], t2: Entry[]}`；Entry = `{id, tier, summaryTokens, approxTokens, count}`，summaryTokens 用注入的 countTokens 或缺省「长度/4 向上取整，最少 1」估算。纯函数、不抛。

### 4. 边界条件与失败模式（汇总）

1. 文件损坏/未知格式/读异常 → 重置台账 + 改名 `.corrupt` 留证，fail-open 不阻塞会话；但**任何一块非法即整文件判废**（放大数据丢失面）。
2. persist 失败（磁盘满/权限）→ 仅 warn，内存态与磁盘态静默分叉，进程重启后丢最近折叠簿记（幂等重放机制可部分兜底 T1 的重复区间守卫与阶梯的精确重放）。
3. posMap 缺失（对过期快照执行 ctx_trim_fold）→ 只做结构校验与精确重复守卫；邻接/重叠检查全部跳过（fail-open，注释明说）。
4. 跨进程/并发：无文件锁；同一会话两个进程各自缓存、各自持久化，最后写者赢。
5. 时钟回拨：foldsThisHour 用 `now - ts < 3_600_000` 过滤，回拨时旧时间戳全保留，节奏限制偏向更严格（安全方向）。

### 5. 问题与可疑点

1. **【疑似 bug·重要】frontier 可能回退**：头注释声称 frontier「only ever advances (monotonic)」，但 commitFold 第 448 行无条件 `ledger.frontier = block.refRange.lastId`。重叠检查只拒绝与既有块相交的区间，**不拒绝**提交一个完全位于既有块之后（更新消息）或之前（更旧消息）的区间。若先折叠较新区间、再经 advisory 中段折叠提交较旧区间，frontier 会倒退到更旧的 lastId。下游若把 frontier 当「到此为止都已折叠」的游标（view/trigger 待核对），会产生错误判断。建议：仅当新 lastId 在 posMap 中位于旧 frontier 之后才前移。
2. **【设计取舍·数据丢失放大】单坏块判废整份台账**：upgradeLedgerFile 对 v1/v2 都是 all-or-nothing。一条 surface 簿记写坏或 id 缺失会让该会话全部折叠历史重置。可考虑「剔除坏块、保留好块 + warn」策略；当前选择偏保守（覆盖可表达性优先），但值得在文档里明示。
3. **【可疑】sessionId 128 字符截断可碰撞**：sanitizeSessionId 先编码再 `slice(0, 128)`。两个会话 id 前 128 码点相同即共享同一台账文件；且缓存键是原始 id，两个缓存条目写同一文件，后写者赢，形成跨会话台账串写。DSH 会话 id 通常 UUID 级别前缀即唯一，实际风险低，但映射非单射与注释「must never share one ledger file」的意图相悖（截断破坏了单射性）。
4. **【小】`.corrupt` 留证会被覆盖**：`renameSync(file, file + ".corrupt")` 在 POSIX 语义下无冲撞保护——若已有 `.corrupt`，再次损坏会静默覆盖上一份 forensic 副本。另外瞬时读错误（EACCES/EIO）也会被当损坏改名，真实数据被挪走。
5. **【小】幂等重放判定过严**：阶梯重放要求 consumes 顺序逐项相等；同样的 id 集合不同顺序的重试会落到 ladder-consumed-inactive 失败而非 duplicate 成功（只在崩溃重试恰以原序重放时成立）。
6. **【小】返回形状不一致**：T1 成功无 `duplicate` 字段，阶梯成功才有；调用方若统一读 `.duplicate` 需容忍 undefined。
7. **【小】文档漂移**：头注释说 v1 「re-persist as v2」，ledgerOf 内注释说 v1 迁移只在内存、推迟到下次写盘才落 v2；两处说法不一致（实际行为是后者）。
8. **【可维护性】normalizeBlock 与 commitFold 的 T1 前半段代码重复**，字段规则改动需同步两处，漂移风险中等。
9. **【备注】census 只看活跃 T1/T2**：活跃 T3 块的体量不出现在任何普查桶里（T3 是终端层，是否需要单列待 trigger 章节核对）。
10. **【备注】approxTokens 缺失时回退为 count**（消息条数当作 token 数），对 legacy 记录会显著低估体量；仅影响旧文件迁移场景。
11. **【备注】adoptLedger 不做形状校验**：收编对象直接进缓存与磁盘，完全信任 fork.js 的构造；若父台账带脏字段会原样落地。

## 第二节 host/context-trim/view.js（486 行）——纯函数视图构建器

### 1. 模块概览

view.js 是 context-trim 的「出站视图」半边：把台账里的 fold block 应用到消息数组上，把被折叠的连续区间各替换为一条合成 user 消息。核心契约是**纯函数 + 确定性**：同一 (messages, ledger) 输入必须逐字节渲染出相同视图（golden test 钉死），因为折叠间隙之间稳定的序列化前缀是 provider prompt-cache 命中的前提。阶梯视图是确定性三遍覆盖：Pass 1 定位所有 T1 块（活跃与被消费的都要渲染——被消费的 T1 摘要是阶梯原料）；Pass 2 用活跃 T2 摘要替换其消费的 T1 摘要连续段；Pass 3 同理处理活跃 T3。全模块 fail-open：定位不到、越入保护尾、切割工具对的块一律跳过，绝不猜测——过期台账最多退化为「不折叠」，不会丢消息。消息 ref 的取法：显式 id 可寻址（≤512、无空白/控制字符）则直接用，否则用规范化消息（键排序、丢易变字段）的 sha256 前 12 位十六进制加 "h" 前缀，使 ref 在全量重发历史下保持稳定、跨进程重启台账依然适用。

### 2. 导出一览

| 导出名 | 形状 | 职责一句话 |
|---|---|---|
| `TOKENS_PER_CHAR` | `const 1/4` | ASCII 字符→token 启发式系数 |
| `TOKENS_PER_CJK_CHAR` | `const 1` | CJK/全角字符 token 系数（钉 1.0，偏高即偏早折叠，安全方向） |
| `refOf(message, _index)` | `(msg, n) → string` | 稳定消息 ref：可用显式 id，否则 "h"+内容哈希（index 参数故意不用） |
| `refPositions(messages)` | `(msg[]) → Map<string, number[]>` | ref → 升序索引列表（重复内容消息共享同一 ref） |
| `messageTokens(message)` | `(msg) → number` | 单条消息 token 估计（正文+tool_calls+8 字符框架开销），不抛 |
| `estimateTokensOf(messages, startIdx?, endIdx?)` | `(msg[], n, n) → number` | 闭区间 token 估计，参数自动夹取 |
| `segmentBounds(messages)` | `(msg[]) → [start,end][]` | 原子分段：发起工具调用的 assistant 与紧随的 tool 结果合并成一段 |
| `rangeIsSegmentAligned(messages, startIdx, endIdx)` | `(msg[], n, n) → boolean` | 折叠区间必须起于段首、止于段尾（不许切散工具对） |
| `renderSummaryText(block)` | `(block) → string` | `[SWITCHMAN:TRIM] ${summary}`，所有 tier 同形（下游识别锚） |
| `summaryMessageOf(block)` | `(block) → Message` | 合成 user 消息，id 为 `acp_summary_${block.id}`（阶梯按此 id 定位） |
| `buildView(messages, ledger, options?)` | `(msg[], ledger, {protectedTail?}) → {messages, applied, foldedMessages, unlocated}` | 应用全部可应用块，返回新数组（不改输入） |
| `ledgerIsStale(view, ledger)` | `(view, ledger) → boolean` | 全部 T1 都定位失败 = 宿主换过历史，台账整体过期 |
| `injectView(options, messages, view)` | `(opts, msg[], view) → "in-place"\|"swapped"\|"none"\|"nothing-to-apply"` | 把视图装进本次派发（原地拼接 / 引用替换 / 放弃） |
| `replaceInPlace(target, source)` | `(arr, arr) → arr` | 保身份的原地内容替换（2048 分块 push 避开参数上限） |

内部函数：`isLadderBlock`（为避免 state.js⇄view.js 循环依赖而**内联复制的副本**）、`countChars`、`canonicalValue`、`canonicalizeMessage`、`usableId`、`locateBlock`、`summaryPositionsOf`、`locateLadderRun`、`applyLadderTier`。

### 3. 逐函数细节与边界

#### `refOf` / `refPositions`
- usableId：非空字符串、≤512、每个码元 >0x20 且 ≠0x7f；非 ASCII id 放行。
- 内容寻址：VOLATILE_KEYS（ts/time/timestamp/createdAt/updatedAt/receivedAt/sentAt）在**每一层**对象上剔除；bigint→String、非有限数→null、深度 >8 截断为 "[depth]"；`{a: undefined}` 与 `{}` 同哈希（JSON.stringify 丢 undefined）。canonicalizeMessage 抛错时回退 `String(message)`（仍可哈希，不会崩）。
- refPositions 把重复内容消息聚到同一 ref 的多索引列表——这是后续所有「count 锚定」消歧的基础。

#### `messageTokens` / `estimateTokensOf`
- 字符串正文直接计数；数组正文逐块取 `block.text`（字符串）或整块 `JSON.stringify`；`message.tool_calls` 整体 JSON 计数；任何异常吞掉后保留框架开销估计（8 ascii）；返回 `max(1, round(ascii/4 + cjk*1))`。
- estimateTokensOf 夹取 start≥0、end≤len-1；start>end 返回 0。安全。

#### `segmentBounds` / `rangeIsSegmentAligned`
- opensToolCalls：role=assistant 且（tool_calls 非空数组 或 content 含 tool_use/tool-call 块）——覆盖 DSH 原生、OpenAI、Anthropic 三种形状（注释记录了曾因漏掉原生形状把调用与结果拆开的教训）。
- carriesToolResults：role=tool 或 content 含 tool_result/tool-result 块。
- 分段算法：从 i 出发，若 opener 则吞并所有连续结果消息；段恰好铺满数组。前导孤儿 tool 消息自成一段，不会崩。
- rangeIsSegmentAligned：入参先做整数/非负/序校验；要求 startIdx 命中某段起点且 endIdx 命中某段终点。段是连续铺满的，因此两端对齐即保证中间无切口。

#### `renderSummaryText` / `summaryMessageOf`
- 纯字符串/对象构造。合成消息 role=user、content 为单 text 块；id 前缀 `acp_summary_` 是阶梯视图定位的锚（summaryPositionsOf 依赖该前缀）。

#### `locateBlock(positions, block, afterIdx)`（内部）
- 严格定位：两端 ref 必须都能解析；count 为正整数时（anchored）用 count 锚定 `start + count - 1 ∈ lastList`，解析出的 span 必须恰等于 count；无 count 时宽松取 firstList 中 afterIdx 之后首个起点 + lastList 中首个 ≥firstIdx 的终点（expected=span 恒过）。返回 [firstIdx,lastIdx] 或 null。
- count 锚定专门对付重复内容消息共享 ref 的歧义；buildView 以 afterIdx=-1 调用。

#### `buildView(messages, ledger, options?)`
- 归类：t1Blocks = refRange !== null 的块；ladderBlocks = isLadderBlock 的块（活跃与否都参与，applyLadderTier 逐块决定是否为锚）。
- Pass 1 定位每个 T1（locateBlock），失败计 unlocated；按 firstIdx 升序、lastIdx 降序排序后线性铺装：firstIdx < at（与已应用块重叠）跳过；触及保护尾（`lastIdx >= length - protectedTail`）跳过；firstIdx===0 且 messages[0] 是 system 跳过（保护系统提示词，且**故意不计入 unlocated**，避免污染 ledgerIsStale 的 epoch 语义）；不段对齐跳过（绝不切散工具对）。间隙消息原样保留。
- 阶梯两遍：先 tier 2 后 tier 3（T3 的锚是 T2 摘要，必须后跑）；applied 经共享 state 累加，**锚替换不计 applied**（只有活跃块替换才 +1）。
- 返回 `{messages（新数组）, applied, foldedMessages（被活跃 T1 替换的原始消息条数）, unlocated}`。纯：从不改输入数组。
- protectedTail 缺省/非法（非正整数）时为 0 = 无尾保护——保护责任完全落在调用方（index.js 待核对）。

#### `applyLadderTier`（内部）
- 参与者：活跃 tier-t 块 + 「被活跃 tier-(t+1) 块直接消费」的非活跃 tier-t 块（纯锚材料：T3 消费的 T2 摘要必须先渲染出来，否则 T3 遍永远找不到自己的段）。
- locateLadderRun：consumes 逐 id 在 summaryPositionsOf 里必须存在且索引严格连续递增，否则该块本轮跳过（fail-open）。
- 拼接按 firstIdx 降序（从后往前），前部索引不受影响；`run.lastIdx >= out.length` 的 run 跳过。
- O(n²) 的 consumedByActive 查找，规模可接受。

#### `ledgerIsStale(view, ledger)`
- 判据：t1Count > 0 && applied === 0 && unlocated === t1Count。只有 T1 计入（阶梯块经其消费的 T1 摘要定位，自身无原始 span）——纯阶梯台账永远不会自判过期。因保护尾/系统提示/对齐被跳过的块不计 unlocated，不会误触发 epoch 重锚。

#### `injectView(options, messages, view)` / `replaceInPlace`
- applied ≤ 0 → "nothing-to-apply"（原始历史即视图）。
- 先试原地 splice（保身份——llm/stream 契约 mutate 的是活请求数组）；冻结数组时 splice 抛错（冻结数组 splice 在变更前即抛，**不会留下半替换状态**），落到 `options.messages = view.messages` 引用替换；options 也冻结 → "none"（本次派发带不动视图，线上发原始历史）。
- replaceInPlace：先清空后分块（2048）push，返回 target。

### 4. 边界条件与失败模式（汇总）

1. 台账 ref 定位失败（历史被宿主自己的 compaction 重写、内容被变更）→ 块跳过、unlocated 计数；全体 T1 失败 → ledgerIsStale 触发 epoch 重锚（调用方职责）。
2. 折叠区间触及保护尾或系统提示 → 跳过（不是 unlocated）；protectedTail 缺省为 0 意味着调用方漏传时**没有任何尾部保护**。
3. 工具对切断 → rangeIsSegmentAligned 拒绝（与上游 API 校验规则一致，注释引 dsh-compaction/lib/index.js:557）。
4. 冻结对象/数组 → injectView 三级降级，最坏 "none"（发原始历史），绝不抛出。
5. 重复内容消息 → 同 ref 多索引，靠存储的 count 锚定唯一解析；count 缺失时宽容解析可能产生退化 span。

### 5. 问题与可疑点

1. **【漂移风险·中】`isLadderBlock` 在 state.js 与 view.js 各有一份手写副本**（为断循环依赖故意内联）。两份逻辑当前一致，但任何一侧改动（比如未来 tier 4）都会静默分叉——建议把判别式收敛到一个无依赖的叶子模块。
2. **【可疑·低概率但后果重】损坏台账可导致阶梯拼接错位**：state.js 的 normalizeStoredBlock 只校验单条记录 consumes 的自身去重，**不校验跨块单消费不变量**（同一 T1 被两个 T2 同时消费的台账能通过加载）。此时两个 T2 的 run 会共享一个索引，applyLadderTier 虽从后往前拼且挡住了越界（lastIdx ≥ out.length），但**部分重叠且都在界内**时，先拼的高位段会让低位段的 lastIdx 指向已错位的消息，splice 出错误内容。合法提交路径（commitLadderFold 要求被消费块 active）保证了单消费，所以只有人工编辑/历史版本文件能触达。建议在加载时做一次全局单消费校验或在 applyLadderTier 里检测 run 相交。
3. **【小】`block.refRange === null` 的过滤让 `refRange === undefined` 的畸形块混进 t1Blocks**：buildView 第 399 行与 ledgerIsStale 第 450 行都只判 `!== null`；undefined 块会在 locateBlock 处安全失败计 unlocated，但会让 t1Count 虚高，理论上可把「部分失败」误判成「全体失败」触发不必要的 epoch 重锚。实际加载路径（normalizeStoredBlock）保证 T1 必有 refRange，只有手造台账能触达。
4. **【备注·性能】refPositions 对每条消息做规范化 JSON + sha256**：每次 buildView 全量重算，O(总内容长度)。大上下文高频派发下可感知（注释以「与 JSON.stringify 同量级」自辩），如需优化可缓存按内容哈希的 ref。
5. **【备注】视觉/非文本块的 token 估计粗糙**：无 text 字段的 content 块（如图片块）按整块 JSON 长度 /4 估——base64 大图会显著膨胀估计，折叠调度偏早（安全方向但浪费）；准确率未知，建议列为已知误差源。
6. **【备注·理论】显式 id 与哈希 ref 的命名空间无隔离**：若某消息的显式 id 恰为另一消息的 "h"+12hex，两族 ref 会合并定位列表。需要攻击者控制 id，现实中概率可忽略。
7. **【小】protectedTail=0 时无尾保护是隐式契约**：buildView 自己不兜底，若 index.js 某条调用路径漏传 options.protectedTail，折叠会吃掉最新消息。等 index.js 章节回查每个调用点。
8. **【备注】系统提示词保护只认 index 0 且 role==="system"**：system 不在首位或 role 变体的历史不受保护（与宿主实际形状对照后大概率无虞，但值得记录）。
9. **【备注】locateBlock 宽松路径（无 count）在 lastList 中取「首个 ≥firstIdx」**：若 lastId 的出现早于 firstId 的全部出现，取到 firstIdx 本身，span=1 恒过——宽容方向的退化而非错误。

## 第三节 host/context-trim/trigger.js（216 行）——触发分层决策（纯逻辑）

### 1. 模块概览

trigger.js 是折叠的「要不要现在折」决策半边，只在空闲边界（agent/status idle）被调用——绝不在 llm/stream 内、绝不同会话折叠在途时调用。分层检查，emergency 优先：emergency（视图用量 ≥ emergencyPercent，默认 95%）走强制机械 T1 折叠（不经副模型，95% 时付不起延迟与失败）；pressure（≥ pressurePercent，默认 60%）走副模型 T1；growth（自上次折叠后低点增长 > growthTokens 且连续可折叠增量 ≥ incrementTokens）是主用的缓存友好闸；阶梯 T3/T2 是维护路径——活跃 T2/T1 摘要种群的体量（mass）与数量门槛同时满足才蒸馏，块数底线只过滤退化 run（bili #379：块数本身不是需求信号）。副模型折叠受 trimMaxFoldsPerHour 与最小间隔节流；emergency 有独立 90 秒冷却；阶梯折叠距任何折叠至少 120 秒（每次折叠都会重建序列化视图，蒸馏夹在原始折叠之间会让尾部每分钟抖动两次）。所有判定只依赖测量输入——刻意不含时钟与宿主访问（可单测的黄金阈值），唯 Date.now() 作 now 缺省是例外（见问题 #5）。

### 2. 导出一览

| 导出名 | 形状 | 职责一句话 |
|---|---|---|
| `FOLD_MIN_INTERVAL_MS` | `const 60_000` | 副模型折叠间的硬性最小墙钟间隔 |
| `EMERGENCY_COOLDOWN_MS` | `const 90_000` | 机械折叠的冷却窗口 |
| `LADDER_MIN_INTERVAL_MS` | `const 120_000` | 距「任何」折叠的阶梯最小间隔 |
| `computeFoldableRange(messages, ledger, protectedTail)` | `(msg[], ledger, n) → {startIdx, endIdx}\|null` | 本次可折叠 span：前沿之后、任务意图之后、保护尾之前的连续段对齐区间 |
| `evaluateTrigger(input)` | `(Input) → {action, kind, tier, reason, startIdx, endIdx, incrementTokens, consumes?}` | 分层评估，返回 none/fold/emergency 决策 |

内部函数：`bestLadderRun(runs, minBlocks)`——在满足数量底线的 run 里挑 mass 最大者。

### 3. 逐函数细节与边界

#### `computeFoldableRange(messages, ledger, protectedTail)`
- 防御：messages 非数组或空 → null；protectedTail 非正整数按 0；`tailStart = length - tail ≤ 0` → null（保护尾盖满）。
- 起点推定：frontier 为非空字符串时在 refPositions 里定位，取**最后一次出现** +1（重复内容 ref 取最晚出现——保守，避免重折重复段）；ref 定位不到则 startFrom 回落 0（依赖 commitFold 的重叠拒绝兜底，见问题 #2）。
- 双重头部保护：messages[0] 是 system → startFrom 至少 1（注释引宿主 assertSystemHeadRewrite——节点 0 只能被 system/message 改写，表面替换操作盖到系统提示词会被宿主直接拒绝）；第一条 user 消息所在段（任务意图声明）之后才可折——其摘要将成为全会话唯一的任务载体，是主要早期漂移失败源，故永不折叠。
- 终点：逐段扫描，`start < startFrom` 跳过，`end >= tailStart` break；首个合规段成为 best，其后连续延伸。段天然铺满数组，best 按构造段对齐。
- 返回 null 的情形：空历史、全部不可折、保护尾盖满。

#### `evaluateTrigger(input)`
- 输入形状：`{ foldable, messages, viewTokens, windowTokens, thresholds: {growthTokens, incrementTokens, pressurePercent, emergencyPercent, maxFoldsPerHour, ladderT2Tokens, ladderT2MinBlocks, ladderT3Tokens, ladderT3MinBlocks}, now, lastFoldAt, foldsThisHour, lastEmergencyAt, ledger, ladderRuns: {t2, t3} }`。
- 阈值缺省：emergency 95 / pressure 60 / growth 22_500 / increment 50_000 / maxFoldsPerHour 6 / T3（2 块，6000 mass）/ T2（3 块，8000 mass）——全部「非法值回落缺省」，配置写坏不会崩，只会静默用默认。
- 小时上限：`foldsThisHour.filter(now - ts < 3_600_000).length >= maxFoldsPerHour`，与 state.js 的滑窗口径一致。
- emergency 层：windowTokens 有限正数才启用；`usagePct >= emergencyPercent` 时只受 90 秒冷却约束（**不受**小时上限与 FOLD_MIN_INTERVAL 约束——设计意图：95% 时付不起等待），冷却中返回 `{action:"none", reason:"emergency-cooldown"}` 并**提前返回**（见问题 #4）。
- pressure/growth 层：需 `!hourlyBlocked && now - lastFoldAt >= 60s`。growth 锚点优先 lastFoldLowTokens（>0），否则回退 lastFoldViewTokens（旧台账），否则 0；`growth > growthTokens && incrementTokens >= incrementGate` 双闸。
- 阶梯层：与 foldable 无关（蒸馏不需要原始空间），任何原始层之后必然评估。就绪判定先行（数量底线 + 各自 mass 闸），再就绪者中挑大者（`t3Run.mass >= t2Run.mass` 平局取更深）；T3 未就绪不得遮蔽就绪的 T2。通过后受 120 秒阶梯间隔与小时上限约束。返回 `kind:"ladder"`、`tier:"ladder-3"/"ladder-2"`、`consumes: run.consumes.slice()`（防调用方改写）。
- 兜底 reason：nothing-foldable / empty-increment / hourly-cap / below-thresholds / emergency-cooldown / ladder-min-interval / below-thresholds（阶梯未就绪）。
- 返回形状：none 时 `{action:"none", kind:"raw", tier:null, reason, startIdx:-1, endIdx:-1, incrementTokens:0, consumes:null}`；raw fold 的 tier 是字符串 "pressure"/"growth"/"emergency"；action:"emergency" 时 tier 仍是 "emergency" 字符串（state.js 的 tierOf 可映射回 1；"ladder-*" 不在 tierOf 词表里，index.js 必须另行映射——待 index.js 章节核对）。

### 4. 边界条件与失败模式（汇总）

1. 非有限 viewTokens（未传/垃圾）→ usagePct 为 NaN，NaN 比较恒 false：emergency/pressure 静默失效，growth 的 `growth = NaN - anchor` 亦恒 false——**所有基于窗口的层静默失能**，不报错（宽容但不可见，见问题 #3）。
2. foldable=null 且用量 95%：emergency 无从发起（无候选区间），只剩阶梯可能出手；阶梯 mass 也不足时会话只能等宿主自身的 compaction。
3. frontier ref 从历史中消失 → startFrom 回落 0，候选区间覆盖已折叠旧段 → commitFold 重叠拒绝逐次打回，折叠停摆直至 epoch 判定（全体 T1 失定位）重置台账。部分失定位（旧块仍在）时不触发 stale——退化窗口存在。
4. 首条 user 消息永不折叠：若它本身就是巨型粘贴文件，该体量永远无法回收（设计取舍，非缺陷，但值得在容量规划时知晓）。

### 5. 问题与可疑点

1. **【与第一节问题 #1 联动·重要】frontier 回退会让折叠整会话停摆**：state.js 的 commitFold 无条件前移 frontier；若一次 advisory 中段折叠把 frontier 拉回到较旧消息，computeFoldableRange 的 startFrom 随之回退，候选区间将覆盖已折叠段，commitFold 以 overlaps-existing-fold 拒绝——此后每次评估都生成同样非法候选，raw 折叠全面卡死，直到 epoch 语义救场。修复建议同第一节：frontier 只单调前移。
2. **【小】emergency 提前返回遮蔽其余各层**：用量 ≥95% 且冷却中时直接返回 none，pressure（哪怕 90% 用量）与已就绪的阶梯同轮全部跳过。若是有意「紧急冷却期不叠加任何折叠」，建议在注释里写明；否则冷却期可考虑放行 pressure/阶梯。
3. **【小】viewTokens 未校验有限性**：thresholds 每个字段都有缺省兜底，唯独主输入 viewTokens 没有；NaN/undefined 会静默关掉所有窗口层。建议入口处 `Number.isFinite(viewTokens) ? viewTokens : 0` 并让 0 用量走 growth 层的自然判定。
4. **【备注】T3 的 mass 闸（默认 6000）低于 T2（默认 8000）**：深层蒸馏反而更容易点火——合理（T3 run 的 mass 是已被压缩过的 T2 摘要体量），但两个数字的关系没有注释说明，调参时容易误改反。
5. **【小】头注释「no clock」与 `now = Date.now()` 缺省矛盾**：显式传 now 即纯，缺省值引入真实时钟。测试必须显式传 now 才可复现——黄金阈值测试应已如此，但契约上值得把「now 必传」写进注释。
6. **【备注】阶梯返回的 tier 字符串（"ladder-2"/"ladder-3"）不在 state.js tierOf 词表中**：两层之间的映射契约完全落在 index.js；若 index.js 直接把 tier 透传给 commitFold 的 tierOf，会得到 null → invalid-ladder-tier。待 index.js 章节验证。
7. **【备注】bestLadderRun 忽略 run.count**：类型注释声明 count 字段，决策只看 mass 与 consumes.length（count 与 consumes.length 语义重叠），字段冗余无害。
8. **【备注】每轮 computeFoldableRange 都全量 refPositions + segmentBounds**：与 view.js 同款的 O(总内容) 哈希成本，空闲边界频率下可接受。

## 第四节 host/context-trim/summarizer.js（237 行）——摘要生产

### 1. 模块概览

summarizer.js 负责为一个 fold block 产出摘要文本，共三条路径：`summarizeWithModel`（L3 主路径——经 llm.prepareCall + call.stream 的副模型调用，与意图分类同一瀑布形态；硬截止 AbortController，**任何**失败——超时/错误块/空输出——都返回 null，调用方跳过本轮折叠，fail-open）；`mechanicalSummary`（emergency 层的确定性回退——每条消息一行结构头，无模型往返；阶梯折叠禁用机械路径，摘要的摘要收益小且毁工艺）；两个物料渲染器 `renderMaterial`（原始区间→带 ref 戳的标注块）与 `renderLadderMaterial`（被消费块 run→带块戳的段落），共享 400k 字符物料上限（超出保头尾并标记截断，避免烧穿副模型调用）。两份系统提示词携带 bili 压缩规则：文件路径与 ref 逐字保留、决策必须带理由、精确值保留、开放目标逐条带 ref 下放、冗长日志丢弃；输出语言跟随被压缩物料。

### 2. 导出一览

| 导出名 | 形状 | 职责一句话 |
|---|---|---|
| `SUMMARY_TIMEOUT_MS` | `const 120_000` | 副模型摘要默认硬截止 |
| `MAX_MATERIAL_CHARS` | `const 400_000` | 物料字符上限（两条渲染器共用） |
| `SUMMARY_SYSTEM_PROMPT` | `string` | T1 压缩系统提示词（KEEP/DROP/FORMAT 三段） |
| `LADDER_SYSTEM_PROMPT` | `string` | T2/T3 蒸馏系统提示词（输入摘要视为已定事实，永不重推导/不矛盾） |
| `renderMaterial(messages, startIdx, endIdx, refOf)` | `(msg[], n, n, fn) → string` | 渲染原始区间物料：`--- [m<ref>] (role) ---` 头 + 正文，确定性 |
| `renderLadderMaterial(blocks)` | `(block[]) → string` | 渲染蒸馏物料：`--- [block <id>] (tier, ~tokens, msgs) ---` + 摘要 |
| `mechanicalSummary(messages, startIdx, endIdx, refOf)` | `(msg[], n, n, fn) → string` | 机械摘要：每条消息一行（ref、role、首行 160 字符内），自带「细节未保留」免责声明 |
| `summarizeWithModel(llm, route, materialText, options?)` | `async (svc, route\|null, str, opts) → Promise<string\|null>` | 副模型摘要；route null 或任何失败返回 null |

### 3. 逐函数细节与边界

#### `renderMaterial`
- 每条消息：注入的 `refOf(message, i)`（依赖注入便于测试；**必须与台账锚定用同一个 refOf**，否则物料里的 [m<ref>] 锚与定位系统脱钩——契约在调用方手里）；role 非字符串按 "unknown"；文本提取三级：字符串正文 → 数组正文逐块（text 字符串 or 整块 JSON，序列化失败 "[unserializable]"）→ 整条消息 JSON；`tool_calls` 非空时整体 JSON 追加为 `[tool_calls]` 段。
- 上限逻辑：push **前**检查 `chars + head + body > MAX`，超限则 truncated=true 并 break——放不下的那条消息整条丢弃，绝不半条进入；截断尾注给出已渲染字符数与丢弃条数（`endIdx - startIdx + 1 - parts.length`，算术自洽）。
- 边界：startIdx > endIdx → 空串；messages[i] 为 undefined 不崩（refOf 与 JSON 路径都容忍，只是产出退化的 "null" 哈希 ref）。

#### `renderLadderMaterial`
- 与 renderMaterial 同构的封顶/截断模式；块头含 tier（非 2/3 一律标 1）、approxTokens（非有限标 "?"）、count（非正整数标 "?"）。
- 边界：**没有 Array.isArray 防御**——blocks 不可迭代直接抛（本模块其余函数普遍宽容，此处是风格例外，靠调用方契约兜底）；summary 非字符串按空串渲染。
- 截断尾注的丢弃块数用 `blocks.length - parts.length`，同样自洽。

#### `mechanicalSummary`
- 首行提取：字符串正文整段；数组正文取**第一个非空 text 块**；随后 `replace(/\s+/gu," ").trim().slice(0,160)`。tool_calls 信息完全丢弃（设计如此）。
- 尾部固定声明「开放目标与精确细节未被本机械折叠保留；下一个模型驱动折叠将取代它」——诚实的降级标注。
- 边界：区间越界不崩（undefined 消息 → "(no text content)"）；行数受消息数 ×160 上限约束，无需物料封顶。

#### `summarizeWithModel(llm, route, materialText, options)`
- options：`{ onFail?(reason)（唯一失败遥测通道）, deadlineMs?（默认 120s）, maxTokens?（默认 8192）, systemPrompt?（默认 SUMMARY_SYSTEM_PROMPT；阶梯蒸馏传入自己的） }`。
- 流程：route 为 null/undefined → fail("no-route") + null；llm.prepareCall 非函数 → fail + null；AbortController + setTimeout(deadline) 兜底中断；`prepareCall({provider, model, maxTokens}, signal, (controls)=>controls)`；streamOptions = `{...call.config, system, messages:[{randomUUID, user, text=materialText, source:"dsh-switchman-trim-summary"}], signal}`（注释强调 **stream 选项必须携带准备好的 call.config**——适配器凭它绑定凭证/路由，丢掉会挂 prepare 完整性校验）；流循环只认 text-delta 累积与 finish（kind 为 error/aborted → fail + null，其余记入 finishKind）；输出 trim 后为空 → fail(`empty-output finish=…`) + null；任何异常 → fail + null；finally 清定时器。
- 成功返回：非空摘要文本，无长度上限检查（见问题 #4）。

### 4. 边界条件与失败模式（汇总）

1. 副模型任何形态的失败（超时/错误/中断/空输出/异常）统一 null，调用方跳过折叠周期——绝不把失败变成半成品摘要。
2. 截止执行**依赖适配器在 prepare 与 stream 两个阶段都尊重 signal**：若 prepareCall 在 signal 已中止后仍长期挂起，await 不会返回，定时器无法救场（泄漏一个 pending promise 直至适配器自返）。
3. 单条消息超过 400k 字符 → renderMaterial 首条即放不下 → 物料只剩截断尾注（见问题 #1，最重的边界问题）。
4. finish kind 为 length（maxTokens 截断）不算失败：摘要可能被拦腰截断仍照常返回提交。

### 5. 问题与可疑点

1. **【边界缺陷·中】巨型单消息产生「零物料」摘要**：单条消息体量超过 MAX_MATERIAL_CHARS 时，renderMaterial 一个 part 都放不进，返回的物料只有截断尾注；summarizeWithModel 拿到这个非空小文本会正常产出一段无信息量摘要，且**非空 → 折叠照常提交**——原始消息被一条近乎无内容的摘要永久替换，保真度崩塌。机械路径无此问题（不封顶）。建议：物料为「纯截断尾注」时返回 null（让调用方跳过），或对超限单消息做头尾保留截断（注释里声称的行为「keeps head+tail」与实现不符——实现是整条丢弃，**注释与代码矛盾**）。
2. **【小】注释声称「keeps head+tail」，实现是「整条丢弃放不下的消息」**：第 28-29 行注释与 renderMaterial/renderLadderMaterial 的实际行为（break 丢弃当前条）不一致；头尾保留只体现在「已放进去的条 + 截断尾注」的粗粒度上。
3. **【备注】refOf 注入点无一致性校验**：物料 ref 与台账/视图 ref 必须同源；index.js 若误传不同实现，[m<ref>] 锚静默失效（摘要里的 ref 无法被后续 unfold 对回）。建议模块级常量绑定而非参数注入，或注释加粗契约。
4. **【小】无「摘要必须显著小于物料」的收益检查**：模型把物料原样吐回也能通过（非空即收）。阶梯层有 mass 闸兜底（bili #198），raw 层没有对应物；一次无收益折叠照样重建视图、打断 prompt 缓存。可考虑 `summary.length * k < material.length` 的门槛。
5. **【备注】finishKind 只进遥测不进决策**：length 截断、无 finish 块（finish=none）都只反映在 onFail/空输出消息里，调用方无法区分「完整摘要」与「截断摘要」。
6. **【备注】onFail 是唯一可观测性通道**：summarizeWithModel 不打日志、不抛错；index.js 必须把 onFail 接到日志系统，否则失败完全不可见（待 index.js 章节核对是否接线）。
7. **【外观】第 207 行 `let finishKind` 缩进多一级**：纯格式瑕疵。
8. **【备注】materialText 无大小预检**：调用方若直接把超长字符串塞进来（绕过 renderMaterial），token 消耗无防线；封装上 summarizeWithModel 信任物料已封顶。

## 第五节 host/context-trim/surface.js（1090 行）——表面替换（surface-replace）通道

### 1. 模块概览

surface.js 是折叠触达线材（wire）的第二通道：当宿主把装配好的请求深度冻结、view.js 的 splice 级视图发不出去时（那些会话 wire=raw、折叠沦为仅计量的幻影），本通道走源层级——宿主自身 compaction 证明了逃逸口：历史是 append-only 事件日志的**派生投影**，追加一条带 `surfaceOp {op:'replace', startSeq, endSeq}` 的事件即可在投影中遮蔽一个区间（Session.deriveMessages 遍历 surface.nodes）。本模块在串行边界为每个待发块追加「影子计量事件（compaction/prune）+ 一条 user/message 替换消息」的同步相邻对。区间映射双策略：**提交时捕获为主**（commitFold 后 captureFoldSeqs 把块 ref 区间对活跃会话表面解析出的 event seq 存为 block.surfaceSeqs——seq 是不可变日志索引）；**发送时活定位为兜底**（捕获缺场时按 count 锚定在 surface.nodes 上重定位）。关键不变量：表面节点的 seq 是**模型可见序而非日志序**（replace op 会把新高 seq 拼进中段），因此区间是有序集合而非升序区间；校验器逐位置比对、绝不假设单调（注释记录了 2026-11-05 因升序检查造成 incomplete-seqs 死锁的教训）。全模块 fail-open：缺 agents 服务/append/表面支持时退回今天的 wire=raw 行为，所有 no-op 写 decisions.log。

### 2. 导出一览

模块唯一导出 `createSurfaceFoldPass(deps)`，deps = `{ ctx, config, store, decisionLog?, warn? }`；返回：

| 成员 | 形状 | 职责一句话 |
|---|---|---|
| `sweep(sessionId, via?, sessionHint?)` | `async (string, string, obj\|null) → Promise<number>` | 一个会话的替换扫描：每个待发块至多追加一对计量+替换事件，返回发货数；**从不 reject 是文档契约** |
| `captureFoldSeqs(sessionId, block)` | `(string, block) → boolean` | 提交时捕获：把块的 ref 区间解析成 event seq 存入 block.surfaceSeqs（尽力而为） |
| `enabledNow()` | `() → boolean` | surfaceFold 与 trimEnabled 两个开关的与 |
| `supported(sessionId)` | `(string) → boolean` | 折叠闸能力探测：开关开 + 活跃会话表面可用 + 无持久 compaction 锁（**刻意不含新鲜度**——2026-11-05 冻结死锁的教训） |

模块内私有函数群：`isLadderBlock`（**isLadderBlock 的第三份手写副本**）、`toolCallIdsOf`/`toolResultIdsOf`（三种线上形状的调用/结果 id 提取）、`denseMessagesOf`（节点索引对齐的稠密消息表）、`closeToolPairSpan`（活表面上的工具对闭合）、`readBool`（普通布尔或 .get() 对象两吃）、`sessionIdOfAgent`（index.js agentSessionIdOf 的**本地孪生**，避循环依赖）、`replacementMessageOf`（summaryMessageOf + 纯 `{kind:'user'}` source——compact-checkpoint 源会被 v4 校验器拒绝，识别只靠 acp_summary_ id 与 [SWITCHMAN:TRIM] 前缀）、`messageOfEvent`（优先宿主 deriveEventMessage，否则内联投影规则）、`eventsOf`（snapshotEvents 或 eventAt 全量步走）、`compactionLockOpen`（开着的 compaction/start..end 对扫描）、`derivingPairsOf`（能派生消息的 (nodeIndex, message) 对）、`locateOnSurface`（count 锚定节点定位，**无 count 直接 null 硬跳**）、`validateStoredSeqs`（唯一性/安全整数/端点在表面/跨度逐位稠密相等/端点 ref 身份复核）、`overlapsReplacedRange`（与他块已替换区间的碰撞检查：精确 seq 集优先，legacy 数字区间兜底，**异常时 fail-closed 返回 true**）；闭包状态：lockCache（200 上限，按 session.seq 键控）、replacedKeys（500 上限 + 1h TTL 的内存幂等带）、skipSeen（200 上限的去重日志）。

### 3. 关键函数细节与边界

#### `closeToolPairSpan(pairs, startIdx, endIdx, nodeCount)`
- 前置：整数/序/越界校验，`messageAt` 对界外与 null 派生节点都安全。
- 后向：起点若携带结果，向前找最近拥有匹配 call id 的节点并拉入（owner 不到 = 调用已被遮蔽/不存在 → 既有孤儿，愈合方向，区间不动）；前向：每轮重算跨度内「开启未应答」的 call 集合，非空时下一个节点必须应答其中之一，否则 null（不可闭合 → tombstone tool-pair-unclosed）；表面先尽也 null。双 pass 各带 `guard <= count` 终止护栏。
- 双重身份节点（既开调用又带结果）两个 pass 都防御性处理。

#### `validateStoredSeqs(session, nodes, stored, block)`
- 校验链：非空数组 → 全部为唯一非负安全整数 → stored[0]/stored[last] 都在 surface.nodes 且 startIdx ≤ endIdx → 节点跨度切片与 stored **逐位完全相等**（稠密覆盖，检测表面已前进）→ 端点身份复核：eventAt(stored[i]) 派生的消息 refOf 必须等于块 refRange 的对应 id（surfaceHeadClamped 块只查末端——头部 seq 是被故意丢弃的系统头）。任何失败 null → 走兜底或 tombstone，**绝不静默改靶**。
- 明确不要求 seq 升序（模型可见序；升序检查曾把刚产出的合法捕获判死）。

#### `overlapsReplacedRange(block, seqs, blocks)`
- 三级判定：marker.seqs（发货时写下的精确集合）或退化用他块 surfaceSeqs → 精确交集；都没有才用 startSeq..endSeq 数字区间（对非单调跨度是过近似，可能误杀合法重定位——注释明言这是安全方向）。异常 → **true（fail-closed，安全检查绝不放行）**。
- 小孔：legacy marker 的 startSeq/endSeq 缺失时 `Number.isFinite` 双双为假 → 该 marker 不参与碰撞判定（静默放行）；仅损坏 marker 可触达。

#### `sweep`（主流程）
- pending 过滤：无 surfaceReplaced 且（无 tombstone，或 generation 可用且与 tombstone 记录的 generation 不同）。**generation 只取自 sessionHint**（见问题 #1）。
- 整体闸：disabled / no-service / compaction-lock 三种整轮 skip（dedupe：同签名只记一次，pending 数变化重开）。
- 活快照（nodes/pairs/nodeMessages/headIsSystem/liveGeneration）在**每次成功发货后整体刷新**——被遮蔽的 seq 已离开 surface.nodes。
- 阶梯分支（tier ≥ 2）：消费块缺失 → ladder-consumed-skipped；有消费块未发货且自身被 tombstone → 同因连带 tombstone，未发货但健康 → 静默等待（账本序保证消费块先处理）；消费块的替换节点（surfaceReplaced.atSeq）任一不在活表面 → ladder-span-gone；首末替换节点之间的跨度必须**恰好**只含这些节点、且每个节点都派生 acp_summary_ 消息，否则 ladder-span-mismatch；防御性 system-head 检查后走同一追加协议。
- T1 分支：stored 捕获经 validateStoredSeqs；失败落兜底活定位，但必须过三道闸——端点匹配（stored 首末 seq 仍在活节点且等于定位端点，否则 incomplete-seqs）、overlapsReplacedRange（否则 incomplete-seqs）、定位失败（有捕获 incomplete-seqs / 无捕获 not-located）。
- 工具对闭合（两条路径共用）→ 不可闭合 tombstone tool-pair-unclosed → 闭合若改变了区间则按闭后区间重算 seqs。
- 发送时 system-head 钳制：首节点是系统头则丢头 seq（区间只剩头 → system-head tombstone）。
- 追加协议：先 compaction/prune（计量），后 user/message + surfaceOp replace + sourceEventSeqs；成功后写 durable marker（含精确 seqs、atSeq、via、generation）、内存幂等带、发货计数、快照刷新、decisionLog、persist。**crash 窗口被完整文档化**：prune 落盘而 marker 未持久化时的三条恢复路径（孤儿 prune 无害定价零 / 替换已落则稠密校验失败转 incomplete-seqs / 进程内 replacedKeys 挡重放），最坏只是一行重复的日志内 prune。
- append 抛错 → tombstone `append-rejected:<消息160字符>`；收尾 shipped>0 时 persist + warn。

#### `captureFoldSeqs`
- 全 try 包裹（失败一律 false，只剩兜底路径）；count 锚定定位；捕获时即做 system-head 钳制（startIdx===0 且头是 system → startIdx=1 并标 block.surfaceHeadClamped；纯头区间 → false）；**不做工具对预闭合**（注释详述：预闭合会让端点 ref 身份复核失败，造成静默不可发块；权威闭合在 sweep）。

### 4. 边界条件与失败模式（汇总）

1. 宿主无表面机制/会话未注册 → no-service skip，退回 wire=raw + 水位缓解的老行为。
2. compaction/start..end 锁打开 → 整轮让路（supported 同步报 false，避免 maybeFold 白烧副模型调用）；锁状态按 session.seq 缓存。
3. 日志不可读 → compactionLockOpen fail-open false（不可读的日志不得重新制造折叠死锁），overlapsReplacedRange fail-closed true（安全检查不放行）——两个方向的容错各按语义选择。
4. 消息 id-less → refOf 内容寻址 → 早期“长得一样”的跨度同样定位得到——这正是端点匹配闸存在的原因。
5. sweep 内部**全同步**（无 await 点）：同一会话两次 sweep 不会交错——这个原子性依赖 session.append 是同步 API 的事实。

### 5. 问题与可疑点

1. **【可疑·中】无 hint 的 sweep 永远无法重开 generation 键控的 tombstone**：pending 过滤的 generation 只取自 `sessionHint.surface.contentGeneration`（第 638-644 行），而 session 对象在几行之后才解析出来（第 657 行）。sessionHint 为 null 的调用方（idle 路径待 index.js 核对）generation 恒为 null，`tomb.contentGeneration !== generation` 恒 false → **一切 tombstone 块（incomplete-seqs/not-located/tool-pair-unclosed/append-rejected/system-head）在无 hint 扫描中永久被过滤**，即使表面内容早已变化。修复很直接：session 解析后再取一次 generation 参与过滤。待 index.js 章节确认 hint 的实际传参情况后定级。
2. **【文档漂移】模块头注释写返回 `{ sweep, captureFoldSeqs, supported }`，实际返回还含 `enabledNow`**；`createSurfaceFoldPass` 的 deps 注释同样漏掉决策日志可选性之类细节。小事，但头注释是本模块唯一的接口文档。
3. **【复制蔓延】isLadderBlock 第三份副本 + sessionIdOfAgent/agentSessionIdOf 孪生**：三处 isLadderBlock（state.js 导出、view.js 内联、surface.js 内联）、两处 sessionIdOfAgent，全部以「避循环依赖」为由手写复制。建议抽一个零依赖叶子模块（类型谓词 + id 提取），循环问题与漂移风险一次解决。
4. **【小】not-located / incomplete-seqs 三处 tombstone 写了 block.surfaceSkip 但不立即 persist**（第 858-891 行一带），与其他 tombstone「写完即 persist」的风格不一致；进程死掉则 tombstone 丢失，下次重启重新尝试并重新 skip——仅多一次尝试与一行日志，无正确性影响。
5. **【备注·契约脆弱】`void sweep(...)` 依赖「sweep 从不 reject」的口头契约**：sweep 主体没有整体 try/catch，deps 注入的 decisionLog/warn 若抛错会以 unhandled rejection 形式逃逸。当前实现里这些路径确难抛错，但契约应落成结构（sweep 内部顶层 catch 或调用处 .catch）。
6. **【备注·保真】闭合/后向愈合可能把摘要未覆盖的消息拉进发货跨度**：向前闭合拉入的 tool 结果、向后愈合拉入的 assistant 节点，其内容不在 renderMaterial 的物料里，却被同一条摘要替换。对 engine 折叠（trigger 段对齐，闭合是 no-op）无影响；只影响 legacy/重定位块。方向安全（不发货会切散工具对、直接被序列化器拒绝），但值得知晓摘要保真度边界。
7. **【小】overlapsReplacedRange 对损坏 legacy marker 静默放行**（见上）；fail-closed 只覆盖「抛异常」，不覆盖「字段缺失」。
8. **【备注·好设计】crash 窗口三段式恢复论证**（第 966-979 行注释）是本模块质量最高的部分：先证明孤儿 prune 无害、再证明替换已落时稠密校验必然失败、最后进程内幂等带兜底——值得在其他写路径复用这个论证模板。
9. **【备注】supported 刻意不查新鲜度**（注释引 2026-11-05 135k 冻结事故）：「上次发货是一小时前」不等于通道失效——recency 永远不得闸折叠。这条经验与 lockCache 的 O(1) 探测配合得很好。
10. **【备注】skipSeen 去重以 `${sessionId}:${reason}` 为键**：跨会话不串；同会话同因不同 extra（如不同块 id）会互相覆盖签名——`dedupe=false` 的四处按块调用恰好绕开了这个粒度问题，设计自洽但依赖调用方记得传 false。

## 第六节 host/context-trim/index.js（1061 行）——装配层与折叠事务

### 1. 模块概览

index.js 是 context-trim 的总装：`applyContextTrim(ctx, config)` 把五条管线接进宿主——(1) llm/stream 监听器（经 `ctx.inject(["llm"], …)` 挂载、llmCtx.effect 释放以保重载安全）：从会话台账构建确定性出站视图、**原地**拼进 options.messages 后才调 next()，再包裹返回流采样用量；监听器**永远调用 next()**，任何内部失败退化为直通（fail-open），这里不做任何折叠决策。(2) agent/status idle 钩子——唯一做折叠决策的地方（设计 §4：只在空闲边界折叠）。(3) ctx_trim_fold / ctx_trim_status 两个 L1 咨询工具——会话模型可自行折叠区间、查看真实尺寸（明确永不披露水位/百分比，bili 教训 #2）。(4) 表面替换通道（surface.js，自带 turn-stopping 触发）。(5) fork 状态继承（fork.js，copy-on-fork）。**模型可见性不变量**：本层只注册字节稳定的协议头（无数字），水位/视图 token/增长数全是引擎内部量，人类诊断走 decisions.log。跨层视图注册表（trimViewBySession）按会话保存最近出站视图 token 估计与注入结果，供 context-watch 的水位层做「计量二元性」择优——但**绝不作为折叠闸**（2026-11-05 用新鲜度闸折叠导致会话冻结在 135k 的教训写进了三处注释）。

### 2. 导出一览（模块级）

| 导出名 | 形状 | 职责一句话 |
|---|---|---|
| `recentTrimViewTokensOf(sessionId, maxAgeMs?)` | `(string, n?) → number\|null` | 最近出站视图 token 估计；过期/非正/注入为 "none"/TTL 内发生过 "none"（粘性线材真值闸）都返回 null |
| `recentTrimInjectOf(sessionId, maxAgeMs?)` | `(string, n?) → "in-place"\|"swapped"\|"none"\|null` | 最近一次派发的注入结果（maybeFold 用：线材带不动视图且表面通道也不通时折叠无意义） |
| `agentSessionIdOf(agent)` | `(string\|obj) → string\|null` | agent 引用 → 会话 id（字符串直通；对象取 session.id ?? id） |
| `TRIM_PROTOCOL_TEXT` | `const string` | 字节稳定的协议头（无数字，免扰 KV 不变量） |
| `effectiveWindowTokens(resolved, cap)` | `(n\|null, n\|null) → n\|null` | 压力/紧急层有效窗口 = min(模型解析窗口, 配置上限)；两者皆不可用才 null |
| `applyContextTrim(ctx, config)` | `(ctx, config) → {store, metrics, captures, inFlight, maybeFold, maybeInherit, applyViewToOptions, surfacePass}` | 装配整层；返回内部句柄供测试与 context-watch 复用 |

### 3. 装配内部状态（闭包）

进程级注册表（均 FIFO 有界）：`captures`（200 会话 × {messages 原始浅拷贝, model, viewTokens, at}）、`trimViewBySession`（200，跨层视图注册）、`windowCache`（200，10 分钟 TTL，**null 结果也缓存**）、`lastEmergencyAtBySession`/`lastStreamCheckAt`/`epochResetDoneBySession`/`sideDispatchSkipsBySession`（各 200）、`foldFailureBySession`（200，退避 60s×2^(n-1) 封顶 15 分钟、计数封顶 16）、继承三件套 `inheritFirstSeen`/`inheritDecided`/`inheritWarned`（各 2000）。`decisionLog`：`<stateDir>/decisions.log` 追加（超 2MB 轮转为 .1，只留一代），全 try 包裹。`sideRouteFor`：显式 trimSideModel 路由优先，否则继承会话自身模型。`ladderRunsOf`：账本序上活跃 T1/T2 块的**极大连续 run**（被非活跃成员、换层、T3 插入打断），run = {consumes, mass, count}，mass 用 CJK 感知的 summaryTokensOf 累加；T1 run 喂 T2、T2 run 喂 T3。

### 4. 关键流程细节

#### `applyViewToOptions(options)`（每次 llm/stream）
- 空/非数组消息或无会话 id → null。maybeInherit 在**首次视图构建前**执行（copy-on-fork）。
- buildView(protectedTail) → **先**拍原始历史快照（宿主每次重建全新原始数组，refs/frontier 必须对原始历史解析——带折叠的捕获会让第二次起 refs 永不解析、frontier 静默重置）→ injectView（原地/换引用/放弃三级）→ 估计视图 token → view-applied 决策行（带最近 wire token 使视图-线材分歧可见）。
- 副派发守卫：`inFlight` 中，或（applied=0 且消息 <12 且会话已有台账/捕获/注册表）视为副候选（标题生成、web-search 摘要、折叠物料等借用会话 id 的小数组会污染计量——2026-11-04 基线被重置到 ~150 token 的事故）；连续跳过 2 次后放行为主历史（宿主 compaction 纪元合法缩水的释放阀），被跳过计数在真正主派发处清零。
- 纪元检测：非 inFlight 且 ledgerIsStale → 每纪元一次把增长基线重锚到真实视图（epochResetDoneBySession 去重；applied>0 时清除旗标）。
- 收尾：captureOf(原始快照)、metrics.noteView、trimViewBySession 更新（lastNoneAt 粘性传播）。

#### `runFoldCycle(sessionId, decision)`（折叠事务）
- 阶梯路径：consumes 逐 id 回查（缺失 → ladder-consumed-missing）→ summarizeWithModel(renderLadderMaterial, LADDER_SYSTEM_PROMPT)（null → summary-unavailable，fail-open）→ `commitFold({consumes, summary, tier: "ladder-3"?3:2, approxTokens=消费块体量和}, null)`（对账本校验，不对捕获）。
- 原始路径：切片 → refs（注入的 refOf）→ count/approxTokens → emergency 用 mechanicalSummary 且 **lastEmergencyAt 在事务前置位**（commitFold 拒绝也必须冷却，否则每个空闲边界无限重试——注释明说），否则 summarizeWithModel(renderMaterial)（默认提示词）→ `commitFold({refRange, count, approxTokens, summary, kind, tier: decision.tier}, positions)`。
- **tier 契约在此收口**：原始决策的 tier 是字符串（"pressure"/"growth"/"emergency"），commitFold 内 tierOf 映射回数值 1（原始折叠恒 T1，正确）；阶梯决策的 "ladder-2"/"ladder-3" 不在 tierOf 词表，index.js **显式映射** 2/3（第三节问题 #6 就此解除）。
- 成功后：surfacePass.captureFoldSeqs（提交时捕获，主策略）+ 基线对 recordFoldBaseline(capture.viewTokens, lowView)——**lowView 用新台账对原始消息重建视图估计**。注意 commitFold 本身不落盘，持久化实际由随后的 recordFoldBaseline 内部 persist 完成（隐式耦合，见问题 #7）。

#### `maybeFold(agent, via)`（空闲/stream 双入口；参数名 agent 实为会话 id）
- 闸序列：trimEnabled 且 trimMode==="auto" → 不在 inFlight → 失败退避冷却未到 → 捕获存在 → 注入不可用闸（recentTrimInjectOf==="none" 且表面通道 supported() 为假 → 让位给水位的 tally 强制层）。
- evaluateTrigger 输入：foldable 对**原始捕获**计算；windowTokens 经 10 分钟缓存解析（min(模型窗口, 配置上限，缺省跟随 wmForceTokens)）；**压力口径 = max(view, wire)**（视图估计漏掉 system/context 段，136k 线材曾读成 50k 视图）；ladderRuns 受 trimLadderEnabled 门控。
- outcome 驱动失败梯：folded: → 清梯；summary-unavailable / commit-rejected:* / ladder-consumed-missing → 记梯；异常也记梯。空转 outcome（no-capture/empty-slice）不动梯（防御性死路）。

#### 宿主注册
- systemPrompt.section：只挂 TRIM_PROTOCOL_TEXT（order 10450, interpolate false）——模型可见性不变量。
- agent/status idle：status==="idle" → `void maybeFold(sessionId).finally(() => void surfacePass.sweep(sessionId, "idle"))`——**先折叠后清扫，同一边界发货本pass提交的块；idle 清扫不传 sessionHint**（与第五节问题 #1 相关，已证实）。
- tools/post-execute（subagent_fork 通道 A）：仅成功 fork 记录父子链；记录成功后清除子会话的 inheritDecided/inheritFirstSeen 重开资格窗（补竞态）。
- ctx_trim_status：模式行 + renderStatusLedger（活跃块真实体量、被吸收数）+ 下一个可折原始区间（refs + 消息数 + token）+ **逐消息 ref/尺寸全量列表**（无分页/上限）。
- ctx_trim_fold：refs + count + summary；count 锚定解析，count 缺失/失配时回退「firstList[0] .. lastList 末位」猜测（见问题 #2）；保护尾检查（含友好报错）；段对齐检查（报错提示扩到段边界）；commitFold(tier:1) → captureFoldSeqs → 基线对 → 友好回执（视图下次模型调用时生效）。
- llm/stream 监听：视图构建（永远 next()）→ wrapStreamForMetrics 采样用量 → finally 里 60s/会话节流的 stream 路径折叠检查（agent/status 全局监听在某些宿主拓扑不可达的兜底）。挂载 `{global: true, prepend: true}`（cordis 派发过滤器会丢非全局监听——resume 会话曾在自家子树派发导致整条流路径静默）；llmCtx.effect 生成器做重载安全释放。

### 5. 边界条件与失败模式（汇总）

1. 视图构建抛错 → 决策行 + warn，仍 next()（直通）；流包裹失败 → 返回未包裹的原流。
2. capture 缺失（进程重启后首次折叠检查）→ no-capture 静默返回；下一次派发重建捕获。
3. commitFold 拒绝（重复区间/越界）→ commit-rejected:* 计入失败梯（60s 起倍增，15 分钟封顶），进程重启重开（内存态，注释明说）。
4. 注入 "none"（冻结 options+messages）→ 水位回退 tally；maybeFold 仅在表面通道同时不可用时让位。
5. 决策日志双保险：outcome 同时进 decisions.log 与 warn（某些宿主 warn 无可达 sink）。

### 6. 与前几章的交叉验证

- 第三节问题 #6（阶梯 tier 词表）→ **已解除**：index.js 显式映射 "ladder-3"→3、"ladder-2"→2。
- 第五节问题 #1（无 hint sweep 的 generation 恒 null）→ **已证实**：idle 清扫 `sweep(sessionId, "idle")` 不传 hint；tombstone 重开只能靠 surface.js 自带的 turn-stopping 监听（它传 payload.agent.session）。定级从「可疑」降为「确证的设计缺口，影响有限」。
- 第一节问题 #1（frontier 回退）→ 本层 computeFoldableRange 直接消费 frontier，回退即折叠停摆的影响路径成立。

### 7. 问题与可疑点

1. **【配置语义缺口·中】trimMode "off" 并不关掉一切**：mode 只门控 maybeFold 与流路径视图；ctx_trim_fold 工具的 execute 与 surfacePass.sweep 都不查 mode（sweep 查的是 surfaceFold && trimEnabled）。trimMode "off" + trimEnabled true 时，模型仍可经工具提交折叠、表面通道仍可发货。若 "off" 的语义是「彻底停用」，应在工具 execute 与 sweep 里同查 mode；若是有意（工具是显式咨询面），应在 config 注释写明。
2. **【边界·中】inFlight 副候选也消耗副派发跳过预算**：sideCandidate 的第一支（inFlight）与第二支共享 SIDE_DISPATCH_SKIP_BUDGET=2。折叠事务自身的副模型调用发生在 inFlight 期间；若此前已有两次副派发跳过，第三次（恰是 summarizer 调用）会被「预算耗尽」接受为主历史——capture/trimViewBySession/增长基线被物料子集污染，正是该守卫要防的 2026-11-04 事故形态。建议：inFlight 候选不消耗预算（折叠在途的派发永远是自噪声，不存在「合法缩水主历史」的释放需求）。
3. **【严格度不一致·小】ctx_trim_fold 的 count 缺失回退是「猜测」**：回退路径取 firstList[0]..lastList 末位并以推导出的 count 提交（count 锚定自洽，能过 commitFold）；但重复内容 ref 碰撞时可能折进模型未点名的中间重复段。surface.js 的 locateOnSurface 对同样场景明确拒绝猜测（「guessing there could shadow an unrelated range」），两个入口对同一风险采取了相反策略——建议工具侧也要求 count 严格匹配，失配即报错。
4. **【小】增长闸的单位混用**：maybeFold 把 pressureTokens（max(view, wire)）作为 evaluateTrigger 的 viewTokens，growth = pressureTokens − anchor，而 anchor（lastFoldLowTokens/lastFoldViewTokens）是纯视图口径。经表面通道发货的折叠会缩小 wire，混合口径让增长略偏早触发（安全方向但系统性偏高）；注释只解释了压力层需要真实口径，未提增长层的口径耦合。
5. **【小】ctx_trim_status 无输出上限**：逐消息 ref/尺寸列表随历史线性增长，大历史会话一次性吐回数百行工具结果（本身又进上下文）。可加截断或分页参数。
6. **【小】windowCache 负缓存 10 分钟**：resolveModelInfo 失败的 null 结果同样入缓存，llm 服务恢复后窗口在 TTL 内仍读 null（压力/紧急层继续跳过）。可对 null 用更短 TTL。
7. **【隐式耦合】commitFold 的持久化依赖随后的 recordFoldBaseline**：state.js 注释说「persist() separately」，本层所有成功路径恰好都接着调 recordFoldBaseline（内部 persist）——若未来某条路径只 commit 不记基线，折叠将只存在于内存。建议 commit 后显式 persist 或改注释。
8. **【命名】maybeFold(agent) 的参数实为会话 id**；agent/status 处传入的也是 id（agentSessionIdOf 的产物）。改名 sessionId 可消除误读。
9. **【备注】decisionLog 轮转只留一代（.1）**：超 2MB 即 rename，多进程同时轮转存在 stat+rename 竞态（最坏丢一两行日志），可接受。
10. **【备注】模块级 trimViewBySession 在插件重载后仍存活**（进程全局），与逐次 applyContextTrim 的闭包状态生命周期不一致；watermark 读取的是最新层数据，行为无害但值得知晓。
11. **【备注·好设计】三处事故注释（2026-11-04 基线污染 / 2026-11-05 注入不可用死锁 / 全局+prepend 监听丢失）把「为什么是现在这个形状」钉得很死**，是本模块可维护性的最大资产。

## 第七节 host/context-watch.js（982 行）——水位层与交接（handover）

### 1. 模块概览

context-watch.js 是从 opencode-switchman 移植的 context-watermark 层，四大件：(A) 水位横幅——KV-cache 不变量设计：systemPrompt 节 `switchman:watermark`（order 10500）只放**字节稳定的协议文本**（root/subagent 两个变体、无任何活数字），活层数 + 桶读数走 `systemPrompt.context`（order 300, required）的运行时上下文——DSH 把上下文拼进「Current runtime context」尾部快照，仅在其文本变化时作为新尾部 user 消息发出，缓存前缀按构造保持不变。root 会话有 ok（静默）/soft/hard/force 四层 + 静态 paused 行；subagent 会话有自己的 force 上限覆盖。(B) 读预算双闸——post-execute 按 `~len/3.5` token 记账 read/glob/grep/bash 的结果文本（每会话每轮，15 分钟空闲自重置）；pre-execute 在层 ≥ hard 且预算耗尽时按 wmDenyMode 拒绝（deny）或放行（cap，由 post-execute 追加警告文本）。(C) 交接——借会话自己的 per-agent /compact（桌面 profile 只在每个预设的隔离组内挂 compaction，根级 inject/get 都够不着，`ctx.commands.find(agent, "compact")` 的 handler 闭包自带正确组合）；四步流：写交接文档 → 每次压缩尝试前作为**最后动作**重枚举+刷新文档 → 借来的 /compact 以增长退避重试（自动化在 turn 中点火，只有 idle 能压实）→ 压实后再枚举一次差分补记，最后 followup+flush 唤醒会话填文档续任务，另有 20s/75s 两次迟到派发复查。(D) /ctx-pause、/ctx-resume（进程生命周期，重启即恢复执法——安全侧）与 agent 可调的 ctx_handover 工具（快速返回、交接后台跑）。全部会话状态是进程内 Map，所有路径 fail-open。

### 2. 导出一览

| 导出名 | 形状 | 职责一句话 |
|---|---|---|
| `measureNow(ctx, agent)` | `(ctx, agent) → number\|null` | 当前用量：token 计量器读数 + **计量二元性**（trim 层的新鲜视图估计优先，缺失/失败回退存量读数） |
| `applyContextWatch(ctx, config)` | `(ctx, config) → void` | 挂载水位层全部注册 |
| `PAUSED_LINE` / `PROTOCOL_ROOT_TEXT` / `PROTOCOL_SUB_TEXT` | `const string` | 字节稳定协议文本（paused 行/根协议/subagent 协议） |
| `renderRootWatermark(level, status)` | `(level, {phase?, autoHandover?, cooldown?, tool?}) → string` | root 活性行：分层指令 + 交接阶段/冷却/工具提示；ok 返回 "" |
| `renderSubWatermark(level)` | `(level) → string` | subagent 活性行：分层指令 + force 层要求 FINAL 消息带 HANDOFF 块 |

模块内常量：ACCOUNT_TOOLS（read/glob/grep/bash）、GATED_TOOLS（read/glob/grep，**bash 只记账不拒绝**）、TOKENS_PER_CHAR=1/3.5、CEILING_MULTIPLE=2.4（2×预算+0.4×容忍）、IDLE_RESET_MS=15min、HANDOVER_COOLDOWN_MS=10min。阈值缺省 soft 80k / hard 120k / force 150k。

### 3. 关键细节与边界

- **易变字段读取器**（readValue/readString/readNumber/readBool）：直接吃字段（.get() 或裸值），与 index.js 的 (config, key) 族是**两套并行实现**（注释承认 mirrors lang.js/dispatch.js）。
- `levelOf`/`isRoot`：isRoot 对未知 registry 按 root 处理（更丰富的横幅胜出）；`readThresholds` 三值全走易变读取，非法回落缺省。
- `renderWatermarkContext`：缺会话/计量失败/ok 层一律 ""（静默）；subagent 分支可用 wmSubagentForceTokens 只替换 force 层（wmSubagentCap 开关）；root 分支叠加 paused 行与交接状态（phase: backup/compacting/continuation、冷却、ctx_handover 工具提示）。任何异常 → ""。
- `measureNow`：计量器 totalTokens 非有限 → null；随后查 recentTrimViewTokensOf（跨层注册表），新鲜即**整体替换**返回（见问题 #2）；全 try 包裹。
- **交接核心 `runHandover`**：闸（无会话/已在途/无 compact 定义）→ inflight 加锁 → recordHandover(backup)（**backupId 恒 null**——fork 快照步骤已删除，因装机宿主无 ctx.subagents.startContinuable，fork 每次失败，2026-11-05）→ 文档路径冻结（一次 run 一个文件，刷新覆盖同一文件）→ Promise 内重试循环：delays [5s,15s,30s,60s,120s,300s]（共至多 7 次尝试），agent/status idle 监听即时触发（`payload?.agent === agent` 身份比较，事件丢失由定时器兜底），`attempting` 闩合并重入事件，**20 分钟 watchdog** 防 compact 永不落定卡死锁与监听。每次 attempt：先 recordHandover(compacting) → 枚举+重写文档（**压缩前最后动作**，2026-10-05 迟到派发事故的修复）→ 借来的 /compact（冻结 invocation + 全新未中止 signal——被借 handler 无条件触碰 signal.throwIfAborted）→ 结果为 RESOLVED {kind:"error"}（busy 即此形态）也走重试。成功后：phase continuation → 压实后枚举差分（appeared）→ 追加进文档 → armContinuation（followup 指令：文档路径、活跃子代理清单、「send_message 报 teammate not found 不是死亡证据」、填文档续任务）→ scheduleMaterializationRecheck（20s/75s 双探，新出现的派发追加进文档并以 [SWITCHMAN:HANDOVER-REFRESH] followup 推给会话）。finally：clearHandover + 解锁。
- `maybeAutoHandover`：wmAutoHandover（默认 true）→ 非 paused/非在途/仅 root → 10 分钟冷却（**在 run 之前置位**，失败也吃冷却，防热循环）→ force 层才点火，fire-and-forget + 结果分级日志。
- **读预算双闸**：post-execute 记账（空闲窗重置）+ cap 模式警告（条件：GATED 工具、非 paused、used ≥ 2.4×预算、层 ≥ hard、denyMode 非 "deny"、result.content 是数组 → 返回 accept + 追加警告文本块）；pre-execute deny 模式（同条件且 denyMode==="deny" → kind:"deny" + 理由）。`agent/inbox/claimed` 事件清账开新轮。
- **ctx_handover 工具**：register 级形状（裸 ctx.tools.register 不跑 defineTool 的 DSL 编译 → parameters 必须是完整对象根 JSON Schema）；execute **刻意快速返回**（在此等待压缩会让 agent 持续 busy、饿死只收 idle 的 /compact），交接 detached 跑，返回文本命令模型立即结束 turn；**不传 exec.signal**（压缩必须活得比调用 turn 久）；presentCall 卡片；注册成功置 state.handoverTool 供横幅提示。

### 4. 边界条件与失败模式（汇总）

1. systemPrompt.context API 缺失 → warn 一次（可诊断），静态协议头仍在——避免可选链静默失效。
2. 交接文档写失败 → 返回 null（fail-open，绝不阻塞压缩）；后续刷新失败保留上一个成功 docFile（`?? docFile`）。
3. 被借 /compact 中途消失（definition 变 undefined）→ 明确失败文案；followup 缺失 → 跳过唤醒并 warn。
4. 读闸任何异常 → 放行（fail-open，日志 read gate failed open）。
5. /ctx-pause 进程内生效，重启恢复执法（安全侧，注释明说）。

### 5. 问题与可疑点

1. **【管线行为·中】post-execute 的 cap 警告路径不调 next()**：返回 `{kind:"accept", content:[...追加警告]}` 直接短路了工具管线中**排在后面的其他 post-execute 处理器**（如 context-trim 的 fork-link 记账、任何第三方插件的 post-execute）。触发条件窄（hard/force 层 + 预算超限 + cap 模式 + content 数组），但一旦触发，同一次工具调用的下游观察者全部失明。建议改为「先拿 next() 的结果再追加警告块」的包装式返回（若宿主管线支持包裹语义）。
2. **【口径不一致·中】measureNow 的二元性是「替换」而非「取 max」**：index.js 自己的注释承认视图估计漏掉 system/context 段、压力层必须 max(view, wire)（136k 线材曾读成 50k 视图），而本模块在视图新鲜时**整体替换**计量读数——系统提示词/工具定义占比大的会话，水位层会比 trim 层的口径系统性偏低（force 层更晚点火）。两个消费者对同一注册表采取相反的合并策略，至少应统一或在文档里写明差异的意图。
3. **【小】state.readUsed / state.lastHandover 无界**：readUsed 仅在 inbox/claimed 或空闲覆盖时清理，无 FIFO 上限；长寿命进程 + 海量短会话下缓慢累积（条目小，风险低，但与本项目其他注册表「一律有界」的纪律不一致）。
4. **【小】记帐单位与视图估计单位不一致**：此处 1/3.5，view.js 1/4（CJK 再另算）——同一生态两个估算器，交接文档里「~used tokens」与横幅口径并不严格可比。记录即可。
5. **【备注】自动化点火在冷却置位之后**：maybeAutoHandover 先 set lastHandover 再 runHandover——失败的交接也消耗 10 分钟冷却；这是防重试风暴的正确取舍，但意味着「连续两次 force」之间最少 10 分钟，紧急场景只能手动 /ctx-handover 或 ctx_handover 工具绕过。
6. **【备注】bash 永不被拒绝**：预算闸只挡 read/glob/grep，bash 可绕过读文件（记账但不拦截）——模型在 hard/force 层用 bash 读文件不受 deny。有意的形状选择（bash 不可静态判断是否读操作），但在「budget-limited this turn」的横幅措辞下模型可能误以为全部读路径受限。
7. **【备注】idle 监听用对象身份比较**（payload?.agent === agent）：宿主若重建 agent 对象则事件不匹配，定时器兜底（最坏多等一个 delay 档）。
8. **【备注·好设计】「文档刷新作为压缩前最后动作 + 压实后差分 + 双定时复查」三重防线**，把 2026-10-05 迟到派发事故的竞态窗口压到秒级；交接文档内嵌的记录路径与 python 一行式检查是可操作的（自验过路径形状）。

## 第八节 host/config.js（299 行）——宿主侧配置 schema

### 1. 模块概览

config.js 用 `@deepseek-ai/schemastery`（宿主平面包，peer 依赖——符合仓库「零运行时依赖」不变量）声明整套扁平的 `.volatile()` 设置：每个字段在 DSH 设置系统里独立可编辑（设置页以插件 name 导出为键，持久化进 profile 的 cordis.patch.yml 行），宿主侧拿到的是**活引用**（`config.<field>.get()` 即时重读，插件无需重启）；扁平命名让设置改动路径保持单段，手写设置页依赖这一点。五组字段：lang*（项目语言偏好）、pool/rank（派发泳道与能力排序）、wm*（context watermark 控制）、teams*（Agent Teams 学说与白名单同步）、intent*（意图路由的「auto」伪模型）+ 本报告主角 context-trim 的 trim*/surfaceFold 组。schema 是「第一道防线」——设置写入时校验；宿主各模块的 readNumber/readBool 容错读取是第二道（运行时容忍非法值回落缺省），两层防御设计一致。

### 2. 导出一览

| 导出名 | 形状 | 职责一句话 |
|---|---|---|
| `ModelRouteSchema` | z.object | 可寻址 {provider(min1, required), model(min1, required)} 路由 |
| `RankEntrySchema` | z.object | 路由 + tier（z.union(["S","A","B","C"])——注释说明装机 schemastery 3.18.4 无 z.enum 的同款写法） |
| `EffortEntrySchema` | z.object | 路由 + effort（**刻意自由文本**：合法集合由各模型适配器决定，low/medium/high/off…） |
| `IntentCandidateSchema` | z.object | 意图候选行 {id, preset, enabled, provider, model, effort, note}，全字段无 .required()（schemastery 让 undefined 穿透，条目可缺键；消费方须容忍） |
| `Config` | z.object | 全部设置字段（字段名即设置改动路径） |
| `LANES` | `["economy","mechanical","main","hard","vision","review"]` | 六条派发泳道，展示序 |
| `laneField(lane)` / `laneManualField(lane)` / `laneEffortsField(lane)` | `(string) → string` | 泳道 → 字段名（poolX / poolXManual / poolXEfforts） |

### 3. 字段组与默认值（与各消费方核对）

- **trim 组**：trimEnabled(true)、trimMode("off"/"advisory"/"auto"，默认 "auto")、trimGrowthTokens(22500)、trimIncrementTokens(50000)、trimPressurePercent(60)、trimEmergencyPercent(95)、trimWindowTokens(0=自动跟随 wmForceTokens)、trimProtectedTail(6, 0-100)、trimMaxFoldsPerHour(6, 1-60)、trimSideModel(IntentRouteSchema 空=继承会话模型)、trimLadderEnabled(true)、trimLadderT2Tokens(8000)/T2MinBlocks(3, min 2!)、trimLadderT3Tokens(6000)/T3MinBlocks(2, min 2)、trimStateDir("")、surfaceFold(true)。**schema 默认值与 index.js thresholdsNow 的读取缺省逐项一致**（22500/50000/60/95/6/6/8000/3/6000/2）——目前同步，属双份手工维护（见问题 #3）。
- **wm 组**：soft 80k(min 1000)/hard 120k(min 2000)/force 150k(min 3000)、wmReadBudgetTokens 3000(min 200)、wmDenyMode(cap/deny 默认 cap)、wmAutoHandover(true)、wmSubagentCap(true)、wmSubagentForceTokens(0=共享 wmForceTokens)——与 context-watch 的缺省一致。
- **IntentRouteSchema 的双形状设计**：接受 {provider:"", model:""} 的「未设置」对——ModelRouteSchema 的 min(1) 会在**每次设置写入时拒绝恰好是这个声明默认值**的行（注释把踩坑过程写明了）；消费方自行校验非空。
- **intent 组**：intentEnabled(false——适配器常驻，OFF 只藏目录项，已在 Auto 上的会话走 routedCurrent → fallback → 首候选的降级链且**不调分类器**)、分类器路由/effort/kind(chat|systemone)/endpoint/model、候选列表(与内置 preset 由 mergeIntentCandidates 合并)、cacheTtl 300s、switchConfidence 80、timeout 60s(min 200)、history 6 条(max 20)/2400 字符(200-20000)、intentContextWindow 200k(min 1024，注释声明与 host/intent.js 的 effectiveContextWindow 存在 ceil(wmForceTokens/0.8) 下取的**跨模块契约**)、fallback 路由。
- **teams 组**：teamsMode(false——OFF 不注入学说、不做白名单探测、bundle 永不关闭)、syncWhitelist(false——**独立开关**：不要求 teamsMode，teamsMode 也不触发；六池去重并集整体覆写 allowedModels，只对之后的顶层会话生效)。
- **字段名助手核对**：laneField/laneManualField/laneEffortsField 的产出与 Config 里 poolEconomy/poolEconomyManual/poolEconomyEfforts 等字段名逐一对上，命名契约自洽。

### 4. 边界条件与失败模式（汇总）

1. schema 校验发生在设置写入时；绕过设置页直接改 cordis.patch.yml 的值是否过校验取决于宿主 profile 解析——宿主读取端的容错层（Number.isFinite/typeof 检查）因此仍必要。
2. 读取端只查有限性/类型，**不复查 min/max**：trimProtectedTail 上限 100、wmSoftTokens 下限 1000 等约束只在写入路径有效，异常路径进来的越界值会被照单全收。
3. min(2) 的 ladder MinBlocks 与 trigger.js 的「>0 才认」判定兼容（2 恒 >0），但 schema 的 min(2) 比 trigger 的缺省触发条件更严格——手工塞 1 会被写入路径拒绝，防御方向正确。
4. `z.union` 字符串枚举（tier、dispatchEnforce、wmDenyMode、intentClassifierKind、trimMode、langScope、uiLocale）在 settings 页渲染为选择器；非法值同样被写入路径拦截。

### 5. 问题与可疑点

1. **【文档/实现矛盾·重要】trimMode 三档的声明语义与代码行为对不上**：本文件注释写 "off" = measure only (**no banner, no folds**)；但 index.js 的 streamListener 只查 trimEnabled 不查 mode（"off" 时视图折叠**照常拼进每次派发**）、ctx_trim_fold/ctx_trim_status 工具注册与执行不查 mode、surfacePass.sweep 只查 surfaceFold && trimEnabled、TRIM_PROTOCOL_TEXT 无条件注册。"off" 实际语义是「只停自动折叠」，而非声明的「只测量」。同族问题：trimEnabled 注释写 "OFF disables view folding AND metrics sampling entirely"（流路径确实如此），但**协议头 section 与两个 trim 工具也不随 trimEnabled 关闭**——关掉总开关后会话系统提示里仍挂着「本会话有自动裁剪」的协议文本、模型仍可主动折叠。第六节问题 #1 由此**升级为确证的配置语义缺口**，建议在 streamListener/工具注册处统一检查 mode 与 enabled，或改写 config 注释为实际行为。
2. **【双份维护·小】schema 默认值与各模块读取缺省是两份清单**：trigger.js 的 evaluateTrigger 缺省、index.js 的 thresholdsNow 缺省、config.js 的 schema default 三处重复同一组数字。目前逐项一致；任何一处调参漂移后，异常路径（值非有限）会静默用旧缺省——建议缺省值提为共享常量。
3. **【备注】uiLocale 的 EXTRA_UI_DICTS 引用**：注释说额外语言包由 client 侧内联表解析，config 不持有数据——契约跨文件，巡检范围外未验证（client.js 不在本报告八文件之列）。
4. **【备注】effort 自由文本是特性不是漏洞**：EffortEntrySchema 不约束枚举的理由（适配器各自定义合法集）注释充分；消费方 intent/派发路径须自行处理无效 effort 值（待其它文件验证，超出本次范围）。
5. **【备注】syncWhitelist 的独立性与单向性写得很清楚**：不随 teamsMode 联动、开关各自成立、整体覆写、只影响后续顶层会话——这是本文件里语义最锋利的开关，注释质量配得上它的破坏力。

## 总结章节：八文件巡检总览与修复优先级

### 一、架构总印象

八个文件构成 dsh-switchman 宿主侧的两条主线。**context-trim 折叠管线**（config.js 声明 → index.js 装配 → trigger.js 决策 → summarizer.js 产摘要 → state.js 记账 → view.js 拼视图 → surface.js 触线）：T1 原始折叠为主节奏，T2/T3 阶梯蒸馏为维护路径，双通道触线（splice 级视图 + 表面替换事件对），台账 v2 持久化、块永不删除以保持覆盖可表达。**context-watch 水位层**（config.js → context-watch.js）：KV-cache 不变量（头部字节稳定、活数字走尾部快照）、读预算双闸、四步交接（文档→压缩→差分→唤醒）。两条线经「计量二元性」（recentTrimViewTokensOf）与「水位跟随视图」耦合。

跨模块的**设计纪律**相当高且高度自洽：几乎每条失败路径都显式选择 fail-open（簿记、视图、触发、摘要、横幅）或 fail-closed（安全检查——overlapsReplacedRange、v4 校验器规避），且选择理由都写在注释里；四起具体事故（2026-10-05 迟到派发、2026-11-04 视图污染基线、2026-11-05 注入死锁与 incomplete-seqs 升序检查、1.7.0 依赖事故）都有事故驱动注释。模型可见性不变量（绝不向模型披露水位/百分比）在 trim 与 watch 两侧一致执行。有界注册表（200/2000/500 上限 FIFO）是另一条纪律。这套注释质量本身就是可维护性的最大资产。

### 二、按优先级排序的问题清单（跨节汇总）

**P0（疑似真 bug，建议优先修复）**
1. **frontier 回退**（第一节 #1 → 第三节 #1 → 第六节交叉验证）：commitFold 第 448 行无条件前移 frontier，与「only ever advances」注释矛盾；advisory 中段折叠可使其倒退，computeFoldableRange 随之生成覆盖已折叠段的候选，commitFold 逐次以 overlaps-existing-fold 拒绝——**raw 折叠整会话停摆**，直到 epoch 语义救场。修一行：仅当新 lastId 位于旧 frontier 之后才赋值。
2. **trimMode/trimEnabled 配置语义缺口**（第八节 #1 + 第六节 #1 确证）：config.js 声明 "off" = measure only (no banner, no folds)、trimEnabled OFF 全停；实际 streamListener 不查 mode（"off" 仍拼视图）、ctx_trim_fold/ctx_trim_status 工具与 TRIM_PROTOCOL_TEXT 注册不查 enabled 也不查 mode、surface sweep 只查 surfaceFold && trimEnabled。要么补齐门控，要么改写声明。

**P1（口径/管线级不一致，特定条件下产生错误行为）**
3. **计量口径相反**（第七节 #2）：measureNow 对新鲜视图估计是「整体替换」，index.js 对同一数据是「max(view, wire)」——系统段占比大的会话水位层系统性偏低、force 层晚点。
4. **post-execute cap 路径短路 next()**（第七节 #1）：预算警告分支直接返回 accept，跳过管线中排在后面的其他 post-execute 处理器（含本插件的 fork-link 记账）。
5. **零物料摘要**（第四节 #1）：单条超 400k 字符消息让 renderMaterial 只剩截断尾注，非空照常提交——巨型消息被无信息量摘要永久替换；且「keeps head+tail」注释与整条丢弃的实现矛盾。
6. **inFlight 副候选消耗副派发跳过预算**（第六节 #2）：三次连续副派发（含折叠事务自身的 summarizer 调用）会让第三次被接受为主历史，重演 2026-11-04 基线污染；inFlight 候选应豁免预算。
7. **阶梯单消费不变量不做加载期校验**（第二节 #2 + 第一节）：人工编辑的台账可双消费同一 T1，applyLadderTier 部分重叠 run 会 splice 错位；建议加载时全局校验或拼接前检测 run 相交。
8. **无 hint 的 sweep 无法重开 generation 键控 tombstone**（第五节 #1，第六节确证）：generation 只取 sessionHint；idle 清扫不带 hint，tombstone 重开全靠 turn-stopping 兜底。修复：session 解析后再取一次 generation 参与过滤。

**P2（卫生/漂移风险，择机清理）**
- `isLadderBlock` 三份手写副本（state 导出 + view/surface 内联）与 `sessionIdOfAgent`/`agentSessionIdOf` 孪生——抽零依赖叶子模块一次性消除循环依赖与漂移（第二/五节）。
- 折叠阈值默认值三处重复（config schema / thresholdsNow / evaluateTrigger 缺省），目前逐项一致，建议提共享常量（第八节 #2）。
- ctx_trim_fold 的 count 缺失回退是「猜测」，与 surface.js locateOnSurface 拒绝猜测的严格性相反（第六节 #3）；ctx_trim_status 逐消息列表无输出上限（第六节 #5）。
- sessionId 128 字符截断破坏单射性、`.corrupt` 留证可被覆盖、台账单坏块判废整文件（第一节 #3/#4/#2）。
- windowCache 负缓存 10 分钟、readUsed/lastHandover 无界、refPositions 全量重哈希、ctx_trim_status 的 T3 普查缺位（第一/六/七节）。
- 小型文档漂移一组：state.js v1 迁移两说、surface.js 返回签名漏 enabledNow、summarizer「keeps head+tail」、trigger「no clock」vs Date.now() 缺省、base64 图片块估算粗糙（第一/三/四/五节）。

### 三、值得保持的设计（负面清单之外）

- surface.js 的 **crash 窗口三段式恢复论证**（孤儿 prune 无害 / 稠密校验必然失败 / 内存幂等带）与「文档刷新作为压缩前最后动作 + 压实后差分 + 双定时复查」的三重防线，是本仓库最好的并发推理范本。
- view.js 的纯函数 + 字节稳定契约、fail-open「最多退化为不折叠，绝不丢消息」的不变量；trigger.js 的无时钟黄金阈值设计；index.js 的三级注入降级（in-place/swapped/none）。
- 「水位永不给模型数字」的模型可见性不变量，以及每次违背都值得警惕——ctx_trim_status 只给真实尺寸不给百分比正是这条线的正确执行。

### 四、巡检覆盖说明

本次完整阅读并逐节记录的八文件合计 4,885 行；同目录的 fork.js、metrics.js、client.js、subagent-model.js、handover-state.js、subagents.js、intent.js、intent-presets.js 及 dispatch/lang 等模块不在本次八文件范围内，报告中凡涉及它们的判断（如 mergeIntentCandidates、effectiveContextWindow 的 wmForceTokens 下取契约）均标注为「待验证」。八个章节的每节均含导出函数职责、参数与返回形状、边界条件与失败模式、问题与可疑点四部分，问题条目均带 file:line 级定位或可复现的触发路径描述。

---

## 第二轮巡检 · 文件一：host/context-trim/state.js（514 行，台账存储层）

> 第二轮不再重复第一轮的逐函数字典，改为四条深挖线：控制流与调用图、不变量逐条审查（含「注释声称 vs 代码实际」比对）、具体故障场景逐步推演、与第一轮问题清单的交叉核对。第一轮结论凡被修正或加深处均显式标注。

### 一、控制流与调用图（第二轮复核）

- 模块级导出八个：`LEDGER_VERSION`、`tierOf`、`isLadderBlock`、`emptyLedger`、`normalizeBlock`、`createStore`、`ledgerFoldedTokens`、`ladderCensusOf`。`createStore` 闭包内含五个私有件：`fileFor`、`ledgerOf`、`persist`、`locateT1Range`、`commitLadderFold`，以及公开的 `commitFold`（在 state.js:400 按 `candidate.consumes` 非空分派到 ladder 路径）。
- 写路径全部汇聚到两个提交口：`commitFold`（T1）/`commitLadderFold`（T2/T3），二者都只改内存并 `ledgers.set`，**持久化一律由调用方显式调 `persist`**（两处头注释 state.js:307、state.js:396 都写了 "Memory only — persist() separately"）。这个「内存先行、落盘外包」的契约把原子性责任推给了 index.js 的 fold 事务——若 index.js 在 commit 与 persist 之间抛异常，内存与磁盘就永久分叉（进程内不再重读文件，分叉直到重启才暴露）。第二轮在 index.js 章节回查这一点。
- 读路径三个消费方：`ledgerOf`（缓存懒加载）、`ledgerFoldedTokens`（按当前捕获估算）、`ladderCensusOf`（活跃 t1/t2 普查）。三者对「损坏/缺失」的口径一致：返回空、跳过、或空普查，从不抛错——与 fail-open 声明吻合。
- `locateT1Range`（state.js:286-302）是 count 锚定定位：枚举 `firstId` 的每个出现位，要求 `start + count - 1` 恰好落在 `lastList` 里。返回形状是判别联合：命中 `{firstIdx, lastIdx}` / 未命中 `{reason}`，调用方一律用 `located.reason !== undefined` 判别（state.js:364、state.js:433）。posMap 值是**索引数组**而非单索引——同一 ref 在捕获中出现多次时的候选枚举，真正的多位置语义要到 view.js 的 surface replace 序里才成立，第二轮 view.js 章节回查。

### 二、不变量逐条审查

**N1（提交-加载形状矩阵不对称，潜在整本台账判废）— 本轮最重要的新发现。**

提交侧对块形状的校验是「按路径各查各的」，没有交叉验证 tier 与 refRange/consumes 的组合：

- `commitFold` 的 T1 路径（state.js:398-454）只验证 refRange 字符串、summary、count，**从不检查 `tier === 1`**：state.js:410 的 `tierOf(candidate.tier) ?? 1` 原样放行 tier 2/3。分派条件只有「consumes 非空走 ladder」（state.js:400），于是 `{tier: 2, refRange: {...}, consumes: []}` 会走 T1 路径并以 tier 2 入账。
- `normalizeBlock`（公开 T1 归一化器）同样不拒绝：state.js:206 的 `tierOf(candidate.tier) ?? 1` 保留调用方给的 2/3。即脏候选在进入 commit 之前就已经是毒块。
- 加载侧却执行严格矩阵：`normalizeStoredBlock` 对 tier≥2 强制 refRange 置 null（state.js:127-133 只在 `tier === 1` 时读 refRange），且 tier≥2 而 consumes 为空直接判 null（state.js:123）。

把三段串起来推演：tier 2 + refRange + 空 consumes 的块在内存里提交成功 → `persist` 落盘（带 refRange、consumes: []）→ 进程重启后 `ledgerOf` 重读 → `normalizeStoredBlock` 命中 state.js:123 判 null → `upgradeLedgerFile` 里 `blocks.some((block) => block === null)` 命中（state.js:160-161）→ 返回 null → 走「unknown format」分支：**整本台账 reset + 原文件改名 `.corrupt`**（state.js:247-254）。一次形状不合规的提交，代价是整个会话的全部折叠历史。提交侧只需一行守卫（T1 路径要求 `tier === 1`，或 normalizeBlock 强制归 1）即可封死。第一轮的 P1「阶梯单消费不变量无加载期校验」说的是另一件事（人工编辑可双消费 T1），本轮 N1 与之互补：**两个加载期一票否决点，各自的提交侧都缺对应守卫**。

**N2（frontier「只写不读」——第一轮 P0-1 的根因加深）。**

第一轮定位到 state.js:448 无条件 `ledger.frontier = block.refRange.lastId` 违反「only ever advances」。第二轮通读全文后确认更基本的事实：**`ledger.frontier` 在 state.js 内部只被写、从不被读**——commitFold 的校验段（state.js:425-446）没有任何一处拿候选范围与 frontier 比较。头注释（state.js:26-27）与内联注释（state.js:435-436）两处声称「strictly monotonic (behind or inside the existing frontier is rejected)」，代码里这个拒绝**并不存在**；单调性实际靠 overlap 检查隐式成立（已折叠块从头铺到 frontier，落进中段的范围必然与某块相交），而该隐式防线有两个洞：

- 洞一：整个 overlap 段包在 `if (posMap !== null)` 里（state.js:430）。无 posMap 的结构校验路径只有 duplicate-range 一道 id 级防线，frontier 之后的中段范围照单全收，随后 state.js:448 把 frontier 拉回过去。这就是第一轮推演的「raw 折叠停摆」的精确入口。
- 洞二：见 N3。

修复建议因此比第一轮更具体：单调性应当**显式**校验（候选 `lastId` 必须位于 frontier 引用消息之后），而不是依赖 overlap 的间接保证——因为 overlap 保证依赖 posMap 存在且所有旧块 ref 可定位，两个前提都不可靠。

**N3（overlap 检查对「ref 失踪的旧块」静默跳过）。**

state.js:441：`if (eFirst === undefined || eLast === undefined) continue; // stale block outside this capture`。这是有意的 fail-open，但推演其后果：若当前捕获里能定位候选范围（locateT1Range 已通过），而某个旧 T1 块的 ref 恰好不在捕获里，新块就可能**部分覆盖旧块的原始范围**而不被发觉。两块重叠的覆盖进入台账后，view 构建期才会撞上（双块争同一段原始消息），ladder 相邻性检查也可能因错位拒绝合法蒸馏。fail-open 的代价从「少折叠一次」升级为「覆盖图静默损坏」。更稳的做法：当台账存在任何 ref 不可定位的活跃 T1 块时，拒绝新 T1 提交（fail-closed 一次，换取覆盖图完整），或至少把跳过计数回传给调用方。

**N4（单消费、连续性、幂等的实现质量——本轮确认为高质量）。

`commitLadderFold`（state.js:308-392）的不变量实现值得逐条表扬：幂等重放（同 id + tier + consumes 逐位相等 → 返回 `duplicate: true` 的已提交块，state.js:322-329）；消费对象三查（存在/活跃/tier-1，state.js:334-337）；台账连续性用索引差一断言（state.js:344-346），重复 id 因 Map 去重天然破坏连续性；view 相邻性仅在持有 posMap 时做，且 tier-3 消费 T2（无 refRange）正确跳过而不是崩溃（state.js:356-366）。「stale capture: skip the check, structural holds」的分级取舍在注释里写明了理由。这一段是本文件工程质量最高的部分。

### 三、具体故障场景推演

**场景 A（N1 全链）**：某调用方（人工脚本或未来代码）构造 `{tier: 2, refRange: {firstId: "m1", lastId: "m9"}, consumes: [], summary: "...", count: 9}` 调 `normalizeBlock` → state.js:206 保留 tier 2，state.js:196 只拒 consumes 非空，返回的「T1 块」带着 tier 2 → `commitFold` 走 T1 路径提交成功 → persist → 重启 → 台账判废、`.corrupt` 留证、全部折叠历史清零。八步里没有任何一步报错给用户。

**场景 B（N2 停摆链，第一轮场景的代码级落实）**：advisory 路径以 `posMap = null` 提交中段范围 → state.js:430 跳过全部位置校验 → state.js:448 frontier 倒退到旧消息 → 后续 `computeFoldableRange`（trigger/index 侧）从倒退的 frontier 生成候选 → 每次 commitFold 都因与既有块重叠被拒（前提是有 posMap；若仍无 posMap 则会重复折叠同一段——duplicate-range 挡住完全相同的范围，但范围略有不同的重复折叠会双双入账）→ 停摆直到 epoch 变化使旧 ref 全部失定位。注意补充：**无 posMap 时同一原始段可被不同边界重复折叠**，这是第一轮没有展开的第二个后果。

**场景 C（N5 前向不兼容）**：未来 dsh-switchman 升级写出 v3 台账 → 用户回滚插件版本 → v3 文件被 `upgradeLedgerFile` 以 unknown format 拒绝 → reset + `.corrupt` 留证 → 下一次 `persist` 以 v2 覆盖同名路径。留证文件与活跃文件就此分叉，用户「回滚后历史还在」的预期落空。升级侧加一条「version > LEDGER_VERSION 时只读不写」可避免。

### 四、导出函数第二轮要点（差异视角，形状细节见第一轮第一节）

1. `LEDGER_VERSION = 2`：与 `upgradeLedgerFile` 的 1/2 分支、`normalizeStoredBlock` 的 v2 形状三处强耦合；升版需要同步改三处并新增迁移器，目前没有结构性的防漏机制。
2. `tierOf`：`"model"` 也映射为 1——第一轮未点名，这是 v1 四字符串（emergency/pressure/growth/model）之外的第五个入口，实为四个；`"model"` 出现在列表里说明 v1 曾有独立 model 折叠类，迁移时被并轨。
3. `isLadderBlock`：只看 tier ∈ {2,3}，不查 refRange === null——与 N1 同源的形状盲区（一个 tier 2 带 refRange 的块会让它答 true）。
4. `emptyLedger`：十字段形状，与 `hydrateLedger`（state.js:176-189）字段完全对齐（本轮逐字段核对无缺漏）；但 `hydrateLedger` 对 `frontier` 只验 typeof string，不验其指向的消息存在——坏 frontier 会安静存活。
5. `normalizeBlock`：N1 链的入口；`count` 缺失时回退 0 再判 `count <= 0` 拒绝（state.js:202-203），即 count 是 T1 的硬性必填，与 ladder 路径用 `consumes.length` 兜底（state.js:374）不同——两条路径对 count 的宽松度不一致，无注释说明。
6. `createStore`：返回 `{ ledgerOf, commitFold, recordFoldBaseline, adoptLedger, persist, stateDir }`。`ledgers` Map 进程生命周期内无淘汰——每会话一份完整 blocks 数组常驻，千块级会话约 MB 量级，可接受但应记录在案。`persist` 的 tmp 文件名是**固定**的 `${file}.tmp`（state.js:274）：双进程并发 persist 同一会话会互相踩 tmp，rename 发布半截文件，下次加载 JSON.parse 抛错 → reset。单进程假设下无害，代价为零的 `.${pid}.tmp` 就能消除；另无 fsync，掉电窗口内 rename 后内容可能未落盘——簿记数据按 fail-open 接受，但应在注释里显式声明这是接受的失败面。
7. `ledgerFoldedTokens`：遍历含 inactive T1 块在内的全部 refRange 块（state.js:488 只跳 ladder）——语义正确：inactive T1 的消息仍被折叠着（由 T2 摘要代管），token 计数应含它；T2/T3 自身 refRange 为 null 不计，不会双算。范围外的（stale）块跳过，故结果是「当前捕获内可见的折叠量」而非「台账历史折叠总量」，与函数名暗示略有出入。
8. `ladderCensusOf`：只出 t1/t2，tier 3 不入册——T3 是终端层、触发器只按 T2 普查决定 T3，设计自洽；但 ctx_trim_status 对 T3 的可见性盲区（第一轮第六节 #5）因此是**两层叠加**的：census 不给 + status 不查。
9. `adoptLedger`（store 方法）：一次性收养，但**不做 normalize 校验**（state.js:461-467 只查空台账与 sessionId 相符）——fork.js 传来的台账直通落盘，若含 N1 形状毒块，同样在下次加载时引爆整本判废。信任边界应设在「收养前过一遍 normalizeStoredBlock」。

### 五、与第一轮结论的交叉核对

- **P0-1（frontier 回退）**：确认并加深——读侧校验在代码里根本不存在（N2），修复必须含显式单调性检查，仅改 state.js:448 为条件赋值只堵了半个洞（无 posMap 路径仍可提交落后范围，只是 frontier 不再倒退，重叠防线依旧缺席）。
- **P2（sessionId 截断破坏单射）**：确认；本轮补充一个更角落的碰撞——空串/非字符串 sessionId 与字面 `"default"` 会话共享同一文件（state.js:70-74）。实践中 DSH 会话 id 为 UUID，128 截断与 default 碰撞均难触发，维持 P2。
- **P1（单消费无加载期校验）**：区分清楚——那是「consumed 块被二次消费」的不变量，本轮 N1 是「tier/refRange/consumes 组合」的矩阵洞，二者互不覆盖，修复时应一起加在加载/提交两端。
- **P2（.corrupt 留证可被覆盖）**：确认，且 N5 场景 C 给了它一个现实触发路径（版本回滚），优先级应视为 P2 偏上。
- **新降级说明**：第一轮提到的「posMap 判空不对称」（commitLadderFold 用 `!== null && !== undefined`，commitFold 只用 `!== null`，state.js:353 vs state.js:430）经推演为无害——默认参数已把 undefined 归一为 null，仅风格不一致。
- **新增问题汇总**：N1（P1，提交侧形状矩阵 + 加载期一票否决的组合数据丢失风险）、N3（P2，overlap 静默跳过）、N4（P2，固定 tmp 名 / 无 fsync）、N5（P2，版本回滚覆盖）、N6（P2，adoptLedger 信任直通）。

---

## 第二轮巡检 · 文件二：host/context-trim/view.js（486 行，纯函数视图构建器）

> 沿用第二轮方法：控制流与数据流、不变量逐条审查、场景推演、与第一轮交叉核对。view.js 是三遍覆盖的字节稳定视图引擎，本轮重点核对其确定性声明与 fail-open 分级的实际代码落点。

### 一、控制流与数据流（第二轮复核）

- **模块依赖方向**：state.js 反向导入 view.js 的 `estimateTokensOf`/`refPositions`（台账块大小估算与定位都要用），因此 view.js 把 `isLadderBlock` **内联**而不是从 state.js 导入——view.js:37-39 的注释明确写着「to keep the state.js ⇄ view.js import graph acyclic」。这解释了第一轮 P2「三份手写副本」的成因：不是疏忽，是环依赖约束下的次优解；正确修法仍是抽公共 util 模块，而非就近再抄一份。
- **buildView 数据流**（view.js:396-439）：`refPositions(messages)` 一次建全量索引 → T1 块逐个 `locateBlock(…, -1)` → 按 `firstIdx` 升序、`lastIdx` 降序排序（view.js:412）→ 单线性扫描拼接 out（接受块填间隙 + 摘要，拒绝块什么都不做）→ 末尾统一补尾（view.js:431）→ `applyLadderTier` 先 T2 后 T3（view.js:435-436，升序是承重设计：T3 的锚材料是 T2 pass 产出的中间摘要，view.js:432-433 注释明说）。
- **applyLadderTier 内部**（view.js:351-382）：参与者两类——活跃 tier-n 块 + 被活跃 tier-(n+1) 块直接消费的失活 tier-n 块（锚，view.js:360-363）；`summaryPositionsOf` 在**中间视图**上建摘要位置 → `locateLadderRun` 严格连续性校验 → **从高 start 向低 start 逐个 splice**（view.js:373），使先算好的位置在低位区不受高位拼接影响。`state.applied` 只对活跃块自增（view.js:379），锚不算。
- **注入链**：`injectView`（view.js:462-477）三级降级 in-place / swapped / none，外加 applied≤0 的 nothing-to-apply 快速路径；`replaceInPlace`（view.js:482-486）以 2048 分块 push 规避参数个数上限。

### 二、不变量逐条审查

**V1（字节稳定的实际落点——本轮逐项核验）。** 声明在头注释 view.js:6-9（「byte-identical view on every call…keeps provider prompt-cache hits alive」）。代码级支撑：`canonicalValue` 键排序 + VOLATILE_KEYS 剔除（view.js:78-99）；`refOf` 哈希截 12 hex、显式 id 须过 `usableId`（view.js:111-127）；`located` 排序键为全序且现代 V8 sort 稳定（view.js:412）；`createHash("sha256")` 跨进程稳定。**残余不稳定向量是显式 id 的信任假设**：host 若在重发时给同一消息换 id（重建式日志迁移等），ref 全体失配 → `ledgerIsStale` 触发 → 台账整代重置。设计上这是接受的信任（id 无消息走内容哈希兜底），但缺一道「同一逻辑消息跨重发 ref 不变」的金测——现有金测钉的是视图字节，不钉 ref 稳定性（测试目录不在八文件范围内，标注待验证）。

**V2（locateBlock 的无锚回退是恒真校验——防御性死路径）。** view.js:275 `anchored = Number.isInteger(block.count) && block.count > 0`；锚定路径用 count 解析重复内容消息的对位（view.js:280-286，注释点名「Duplicate-content messages share one content-addressed ref」——这正是 12 hex 截断哈希按内容寻址的必然结果，设计自洽）。但无锚路径（view.js:287-289 + view.js:293-300）：firstIdx 取 firstList 首个合格起点，lastIdx 取 lastList 中首个 ≥firstIdx 的索引，最后 view.js:303 `expected = span`、view.js:304 `span === expected` ——**自己跟自己比，恒真**。头注释（view.js:266-268）声称「the located span must equal the block's stored message count」在无锚分支上不成立。台账加载侧（normalizeStoredBlock state.js:109-110）保证 count 恒为正整数，故该分支对台账块是死代码；作为防御性宽松它把「严格」注释变成了「部分严格」。建议：无锚时直接返回 null（拒绝猜测），与 surface.js locateOnSurface 的严格性对齐。

**V3（buildView 的第四种状态——applied=0 但未 stale）。** `ledgerIsStale`（view.js:448-452）只认「t1Count>0 && applied===0 && unlocated===t1Count」。但 T1 块定位成功却被四个 skip 拒之门外的情形——重叠跳过（view.js:418）、protectedTail（view.js:419）、system 头（view.js:423，注释明确「Plain skip (not unlocated) so the ledgerIsStale epoch semantics stay untouched」）、segment 不对齐（view.js:424）——既不计 applied 也不计 unlocated，形成第四态：**台账健康、视图裸奔**。推演：账上一块覆盖 [0..50]、当前历史 55 条、protectedTail=10 → lastIdx 50 ≥ 45 → 跳过 → applied=0/unlocated=0 → 不 stale → 增长基线沿用旧 epoch——而折叠根本没生效。后续触发器仍按裸视图算压力，重复派发同一候选、被 commitFold duplicate-range 拒绝的循环（详见场景 B）。这是设计容忍态，但值得在 index.js 侧确认有没有日志可观测性（第二轮 index.js 章节回查）。

**V4（applied 的语义漂移）。** `applied` 在 ladder 阶段是「执行了替换的 pass 数」：活跃 T2 被活跃 T3 消费时，T2 pass 先 +1、其摘要随后被 T3 替换下线——最终线上摘要数 < applied。消费方只做零值判断（injectView view.js:463、ledgerIsStale view.js:451），语义漂移无实害；但 ctx_trim_status 若将来直接展示 applied 会有歧义。记录在案。

**V5（ladder 视图 pass 与 advisory 非平铺折叠的相互印证）。** `locateLadderRun` 要求消费的摘要位置**严格连续**（view.js:334 `at !== prev + 1` 即拒）。advisory 中段折叠产生的 T1 摘要在中间视图里不相邻 → run 定位失败 → 该 ladder 块本视图跳过（fail-open「never guessed」）。与 state.js 侧形成**两层一致防线**：有 posMap 时 commitLadderFold 的 view 相邻性检查直接拒绝提交（state.js:353-368 注释「advisory middle-range folds do not tile」）；无 posMap 时提交放行、视图 pass 再兜底跳过。两处口径完全一致，这是跨文件不变量执行得好的一处——同时反证 state.js 场景 B 的停摆链条在视图层有第二症状（ladder 永久无法蒸馏非平铺段）。

**V6（back-to-front 拼接与 bounds 复查）。** view.js:373 排序 + view.js:375-380 逆序 splice：位置在拼接前一次性算好，逆序应用保证低位索引不被高位拼接移动——注释（view.js:348-350）写明理由，正确。view.js:376 `run.lastIdx >= out.length` 是防御性复查（同一数组建的位置不可能越界，恒假分支），无害。

**V7（replaceInPlace 的半程失败残迹——理论缺陷）。** injectView 先试 in-place：若 target 是 frozen，`splice` 立即抛、无副作用；但若数组「可删不可增」（extreme exotic：non-extensible 且 length 可写），`splice(0, length)` 成功、分块 push 中途抛错 → target 被清空后残废，catch 落到 swapped——而残废的旧数组若已被 host 按引用捕获，损坏留存。现实中 DSH 边界只出现「可变」与「frozen」两态（view.js:455-461 注释），此为纯理论路径；修复成本为零（先构造完整替身数组再一次性 splice 进 target，或先 push 后截断）。记录为理论项，不设优先级。

**V8（性能剖面）。** `rangeIsSegmentAligned` 每次调用重建 `segmentBounds(messages)`（O(n)），而它在 buildView 的接受路径上每块调一次 → 最坏 O(块数 × n)。`refPositions` 对每条消息做一次 `refOf`——无 id 消息各做一次 canonicalize + sha256（O(消息字节)）。千条消息、百块台账的会话单次 buildView 在毫秒级，无实害；但 `refPositions` 的全量重算在 watch 层还有一份（第一轮 P2「refPositions 全量重哈希」），两处叠加值得记一笔。

### 三、具体故障场景推演

**场景 A（显式 id 不稳定 → 每 epoch 重置循环）**：host 重发时重写 id → 所有显式 id 块的 ref 失配 → T1 全体 unlocated → `ledgerIsStale` 真 → 调用方重锚 epoch（清基线）→ 台账若同时被重置则折叠历史全失、若保留则每轮 dispatch 重复失败判定。特征信号：`unlocated === t1Count` 恒真且 `foldsThisHour` 稀疏。观测抓手在 index.js（第二轮回查）。

**场景 B（第四态循环）**：折叠块覆盖段滑入 protectedTail（会话变短后常见）→ buildView 每 dispatch 跳过 → 触发器按裸视图持续报压力 → computeFoldableRange 产出同段候选 → commitFold duplicate-range 拒绝。无数据损坏，但每轮空转一次触发决策；与场景 A 的区别是「台账新、范围可定位」，日志特征是 repeated `duplicate-range` 拒绝。

**场景 C（epoch 重置的信息丢失语义）**：host 自身压缩替换历史 → T1 全失位 → epoch 重置连带台账清空（调用侧行为，index.js 待核）→ **T2/T3 摘要中的蒸馏信息随台账湮灭**。新历史（host 压缩产物）短于 ladder 已知内容时，被蒸馏掉的中层记忆不可恢复。view.js:445-447 注释只说「the caller re-anchors it exactly once per epoch」，没提这层信息论代价——设计上接受（fail-open 优先），但应在文档里显式写明。

### 四、导出函数第二轮要点（差异视角）

1. `TOKENS_PER_CHAR` / `TOKENS_PER_CJK_CHAR` / `CJK_CHAR_RE`（view.js:46-62）：CJK 权重 1.0 注释自带事故注脚（「NOT the 2026-11-04 incident root cause…4.8% CJK」）。范围覆盖核验：平假名/片假名（3040-30FF）落在 \u2E80-\u9FFF 内 ✓，半角片假名借道 \uFF00-\uFFEF ✓，Ext-B..F 到 \u{2FA1F} ✓，Ext-G 及以后（\u{30000}+）不计——稀有字按 ascii 权重低估，方向是「晚折叠」，与「安全方向」注释相反的一处小盲区。
2. `refOf(message, _index)`：`_index` 刻意不用（位置无关，view.js:122-123 注释）；显式 id 信任 + 内容哈希兜底的双族设计，`h` 前缀防混淆。
3. `refPositions`：值是升序索引数组（forEach 顺序保证）；重复内容 → 同 ref 多位置，由 count 锚定消歧（与 state.js `locateT1Range` 同构）。**注意 locate 逻辑现存两份近似副本**（state.js:286-302 vs view.js:269-305，差在 afterIdx 与无锚回退），叠加 `isLadderBlock` 三份、「refRange !== null」谓词四处（view.js:399、view.js:450、state.js:488、外加 surface 侧）——本文件的复制粘贴面比第一轮记录的更宽。
4. `messageTokens`：8 token 框架开销计入 ascii 池（view.js:146）；tool_calls 整体 JSON 后按 ascii 权重算（view.js:162-166）。**base64 图片块膨胀的精确定位是 view.js:156**：非 text 块走 `JSON.stringify(block)` 计数，100KB 图片 ≈ 133k base64 字符 ≈ 33k 估算 token，实际图片计费约 1-1.6k——**约 20-25 倍高估**，直接推高 measureNow 与触发提前量（第一轮 P2 的量化落点）。
5. `segmentBounds` / `rangeIsSegmentAligned`：工具对不拆散的实现核；后者 view.js:237 的 `start <= endIdx` 由 `end === endIdx` 蕴含，冗余但无害。三态形状覆盖（DSH native `{type:'tool-call'}` + OpenAI tool_calls + Anthropic tool_use；结果侧 role:'tool' + tool_result/tool-result）与头注释吻合。
6. `renderSummaryText` / `summaryMessageOf`：`[SWITCHMAN:TRIM] ` 前缀跨 tier 恒定（识别锚在 wire 文本不在 ledger，view.js:245-248）；合成 id `acp_summary_<block.id>` 是 ladder pass 的定位主键（view.js:253-256）——id 稳定性由 allocateBlockId 保证（state.js 第二轮已核）。
7. `buildView`：**protectedTail 缺省 0 = 无尾保护**（view.js:397 的 `> 0` 判断意味着调用方忘传时最后一条消息也可被折叠）——脚枪一枚，index.js 侧必须确认始终显式传值（第二轮 index.js 章节回查）。
8. `ledgerIsStale`：判据是**全或无**（全部 T1 失位才算 stale）；部分失位（host 局部改写）既不 stale 也不报错，靠 fail-open 逐块跳过——epoch 语义刻意保守，代价是局部改写后的「僵尸块」长期挂在台账上（unlocated 计数持续 >0 且 < t1Count，无老化机制）。
9. `injectView` / `replaceInPlace`：三级降级的返回串供日志；swapped 路径直接改 `options.messages` 引用——host 侧必须在该 dispatch 内重读 options 才能生效（装配契约，index.js 侧核）。

### 五、与第一轮结论的交叉核对

- **P2「isLadderBlock 三份副本」**：确认，并补上成因（view.js:37-39 环依赖注释）——修法指向共享 util，不再是无主因的卫生债。
- **P2「base64 图片块估算膨胀」**：确认并量化（≈20-25 倍高估，view.js:156）。
- **第一轮「三遍覆盖」结构描述**：确认无误；本轮补充第四态（V3）与 applied 语义漂移（V4）两个第一轮未及的语义细节。
- **第一轮「fail-open 最多退化为不折叠，绝不丢消息」**：在 V7 理论残迹之外全部成立；V7 不违反「不丢消息」（truncation 后走 swapped 仍带完整视图），仅污染旧数组引用。
- **新增问题汇总**：V1（显式 id 稳定性信任无金测覆盖，P2）、V2（无锚回退恒真校验 + 死 afterIdx 参数，P2）、V3（第四态无可观测性，P2 偏上）、V5 反向确认（加分项）、V7（理论项，不设级）、protectedTail 缺省脚枪（P1 候选，待 index.js 侧定性）。

### 六、本节小结

view.js 的确定性工程（排序全序 + 内容寻址 ref + 稳定 wire 文本）经逐项核验成立，fail-open 分级与 state.js 侧的相邻性防线互相印证，是八文件中注释密度与代码行为吻合度最高的一个。需要跟进的是三件事：无锚回退的恒真校验收敛为拒绝（V2）、第四态的可观测性（V3，与 index.js 的日志面一起看）、以及 protectedTail 缺省脚枪的调用方确认。ref 稳定性金测（V1）与 locate/谓词副本的合并（第四节的复制面清单）归入卫生批处理。

---

## 第二轮巡检 · 文件三：host/context-trim/trigger.js（216 行，分层触发决策）

> trigger.js 是纯决策逻辑（判定所需的时间与台账输入全部注入），本轮重点：判定次序的完备性、候选生成的架构含义、以及三处跨文件契约点（tier 字符串、frontier 语义、默认值清单）的逐一对账。

### 一、控制流与判定次序（第二轮复核）

- `evaluateTrigger` 的完整判定序：**外层守卫**（foldable 非空且 increment ≥ 1，trigger.js:138）→ **emergency**（usage ≥ 95%，仅受 90s 冷却约束，trigger.js:143-150）→ **cadence 闸**（hourly 未满 且 距上次折叠 ≥ 60s，trigger.js:151，只护 pressure/growth）→ **pressure**（usage ≥ 60%）→ **growth**（双闸：viewTokens 相对锚增长 > 22.5k 且可折叠增量 ≥ 50k，trigger.js:160-172）→ **ladder T3 → T2**（readiness 先行、mass 大者胜、平手取深层，trigger.js:187-196；interval 120s 与 hourly 闸在 readiness 之后查，trigger.js:194-195）→ 一串差异化 reason 的 none 返回（trigger.js:210-215）。
- `computeFoldableRange`（trigger.js:56-96）：四重起点约束依次取 max——frontier 位置 + 1（trigger.js:61-67，ref 多位置时取**最后一次出现**，trigger.js:66，保守方向正确）→ system 头跳过（trigger.js:74，注释引 assertSystemHeadRewrite 的宿主拒绝行为）→ 首条 user 消息所在段整体保护（task intent，trigger.js:79-87）→ 终点受 tailStart 截断（trigger.js:91 的 `break` 依赖段升序，正确）。范围由 segmentBounds 的段起止拼出，**对齐性由构造保证**——即使 frontier 因一次不合规提交落在段中间，产出的候选仍从下一个段边界开始。
- `bestLadderRun`（trigger.js:102-110）：count floor 过滤后取 mass 最大者；`>` 严格比较使平手保持数组先序，胜负由 index.js 的 ladderRunsOf 排序决定（确定性传递，index.js 章节回查）。
- 判定次序速查表（第二轮实测整理，供日志对照）：

| 层级 | 触发条件 | 受约束的闸 | 拒绝时的 reason |
| --- | --- | --- | --- |
| emergency | usage ≥ 95%（需 foldable 非空） | 仅 90s 冷却 | emergency-cooldown |
| pressure | usage ≥ 60%（需 foldable 非空） | hourly + 60s 间隔 | hourly-cap / below-thresholds 混合 |
| growth | 增长 > 22.5k 且增量 ≥ 50k | hourly + 60s 间隔 | 同上 |
| ladder-3/2 | readiness（count floor + mass gate） | 120s + hourly | ladder-min-interval / hourly-cap / below-thresholds |

### 二、架构与不变量审查

**T1（候选生成是 frontier 驱动而非覆盖驱动——P0-1 的架构定位）。** `computeFoldableRange` 对台账 block 列表**零依赖**：去重与衔接完全托付给 frontier 单指针（已折叠段的终点）。这解释了 frontier 回退为何是 P0 而非 P1——在当前架构里，frontier 是候选与既有覆盖之间**唯一**的衔接件；它一倒退，候选必然压过已折叠段，只能靠 commitFold 的 overlap 检查（有 posMap 时）兜底拒绝，无 posMap 时直接双折。覆盖驱动方案（候选 = 未覆盖区间补集）天然免疫回退，但要扫全台账。**结论：P0-1 的最小修复（frontier 单调赋值）是在现架构内的正解；若将来改动候选生成，建议连同覆盖驱动一起评估。** 同时补充第二症状：frontier ref 在当前捕获中失位时（trigger.js:65 `list === undefined`），startFrom 静默回退 0——候选从消息数组头部开始，同样压过全部既有折叠；与回退同构，靠 commit 侧 overlap 兜底。

**T2（emergency 与 foldable 的耦合——潜在 95% 死锁态）。** emergency 在外层守卫**之内**（trigger.js:138 要求 foldable 非空且 increment ≥ 1）。推演：会话达到 95% 但 foldable = null——全部段都已折叠（frontier 之后无段）或被 intent/tail 吃尽——此时 emergency/pressure/growth 三层全部不可达，返回 "nothing-foldable"（trigger.js:212）；ladder 是唯一出路但需要 T2/T3 存量，新会话为零。**高水位 + 无可折叠段 + 无 ladder 存量 = 触发层完全沉默**，会话只能等水位层（context-watch）的 handover 兜底。index.js 侧是否有应急机械折叠的旁路需回查；若无，这是一个真实的边界死角（触发层视角），建议 emergency 分支增加「foldable 为 null 但 usage ≥ emergency」时的显式 reason（如 window-saturated-idle）以保可观测。

**T3（tier 字符串的跨文件映射隐患）。** evaluateTrigger 对 raw 返回 tier 字符串 `"emergency"/"pressure"/"growth"`（trigger.js:148/157/171），对 ladder 返回 `"ladder-3"/"ladder-2"`（trigger.js:202）。state.js 的 `tierOf` 认识前四个 v1 字符串与数字 1/2/3，**不认识 "ladder-3"/"ladder-2"**（返回 null）。即调用方必须自行把 ladder 字符串映射为数字 tier 再构造候选——index.js 若直接透传，commitLadderFold 会以 invalid-ladder-tier 拒绝。这是三文件间的隐式契约，round-1 未记录；index.js 章节核实实际映射代码。

**T4（NaN 的静默 fail-open）。** trigger.js:144/155 直接 `input.viewTokens / windowTokens`，viewTokens 缺失时得 NaN，两处百分比比较恒 false——emergency/pressure 静默跳过，无 reason 区分「窗口未知」与「未达阈值」。窗口未知时 growth 闸仍可工作（不依赖 windowTokens），设计上有兜底；但可观测性上建议 windowTokens === null 时给出显式 reason。

**T5（度量口径的触发层视角）。** growth/pressure/emergency 全部以 `input.viewTokens` 为分子——即调用方注入的「出站视图 token 估算」。第一轮 P1「计量口径相反」（watch 层整体替换 vs index 层 max(view, wire)）在触发层的落点是：**trigger 不生产口径，只消费注入值**，口径分歧的责任完全在 index.js 的 thresholdsNow 调用处。index.js 章节对账。

### 三、场景推演

**场景 A（T2 死锁态的完整链条）**：长会话反复折叠 → 段全部折叠、frontier 贴近尾部 → foldable = null → 用户新增几条大消息推高 usage 至 96% → 新消息在 protected tail 内不可折叠 → 触发层三闸全静默 → 依赖 watch 层 handover 或用户手动 /clear。全程无告警 reason 区分于正常空闲。

**场景 B（frontier ref 失位的候选回流）**：host 端局部改写历史致 frontier 指向的消息 ref 变化 → trigger.js:65 回退 startFrom=0 → 候选覆盖 [0..tail) 全段 → commitFold 有 posMap：逐块 overlap 拒绝（每轮空转一次）；无 posMap：整段重复折叠成功、台账覆盖图损坏（对应 state.js 场景 B 的第二后果）。两分支都无显式告警。

### 四、导出函数第二轮要点

1. `FOLD_MIN_INTERVAL_MS=60_000` / `EMERGENCY_COOLDOWN_MS=90_000` / `LADDER_MIN_INTERVAL_MS=120_000`（trigger.js:38/41/47）：三闸的非对称是承重设计——emergency 免 hourly 与 fold-interval 只留冷却（trigger.js:151 的闸门位置是证据），ladder 的 120s 从**任意**折叠起算（防串行视图重建双倍尾部扰动，trigger.js:43-46 注释）。
2. `computeFoldableRange`：protectedTail 的 `> 0` 归零语义与 buildView 同款脚枪（trigger.js:58）——两处缺省都等于「无尾保护」，调用方（index.js）必须显式传；intent 保护只护**首条** user 消息（多任务会话的中途任务声明不受保护，设计接受的边界）。
3. `evaluateTrigger` 的 reason 字符串：emergency/pressure 携带百分比、growth 携带双值、ladder 携带 mass 与块数——可观测性设计良好；但 hourlyBlocked 在 cadence 闸内不返回（直接落到 trigger.js:214 的兜底），ladder 的 hourly-cap 有专.reason（trigger.js:195），raw 路径的 hourly 拒绝与「阈值未达」共用 below-thresholds——日志面小瑕疵。
4. trigger.js:213 `incrementTokens < 1` 是防御性死代码：`estimateTokensOf` 每条消息保底 1 token（view.js:170），非空段增量必 ≥ 1；foldable 非空则范围非空。保留无害。
5. 默认值三重清单（第一轮 P2 的精确定位补全）：emergency 95（trigger.js:142）、pressure 60（:153）、growth 22_500（:161）、increment 50_000（:162）、maxFoldsPerHour 6（:135）、ladderT3 6_000/2（:182/181）、ladderT2 8_000/3（:184/183）——与 config schema、index.js thresholdsNow 的三处副本逐项一致性在 config.js 章节终验。
6. 滚动小时窗口表达式 `now - ts < 3_600_000` 在 trigger.js:134、state.js:388、state.js:450 三处手写——第四份复制粘贴面。
7. 「no clock」文档漂移（第一轮已记）的公平判定：trigger.js:31-32 声明的是**决策逻辑**不取时钟（全注入），trigger.js:128 的 `Date.now()` 只是调用便利缺省——注释语义可辩护但易误读，建议改为「no clock *in the decision itself*」。
8. **阈值防御性缺省是双向的静默容错**：所有阈值读取都是 `Number.isFinite(x) && x > 0 ? x : 默认` 模式——配置层给了 0、负数或类型错误时，触发器不报错、不告警，直接改用出厂默认。对「配置缺失」这是合理兜底，对「配置写错」（如把百分比写成 0.6 而非 60，或 growthTokens 误填字符串）则是**错误配置被静默吞掉**，会话按默认阈值运行且无任何日志线索。配置合法性应在 config.js 解析层校验（那里有 schema），触发层不应承担第二重默默纠正。

### 五、与第一轮结论的交叉核对

- **P0-1**：本轮给出架构级定位（T1）——frontier 是候选衔接的唯一件，最小修复有效，覆盖驱动为远期选项。
- **P2「阈值默认值三处重复」**：确认并补全八项的精确行号清单（第四节 #5）。
- **第一轮「growth 是主闸、cache-friendly」**：核验通过——anchor 链（lastFoldLowTokens → lastFoldViewTokens → 0，trigger.js:166-168）保证高水位折叠后闸门仍armed，与 state.js recordFoldBaseline 的写入端闭环。
- **新增**：T2（emergency×foldable 耦合死锁态，P1 候选，待 index.js 定性）、T3（ladder tier 字符串映射隐式契约，P2，待 index.js 核实）、T4（NaN 静默，P2）、场景 B（frontier ref 失位回流，并入 P0-1 的第二入口）、场景 C（emergency 挤占 hourly 预算，P2）、阈值静默回退（P2，与 config 层校验职责划分一起修）。

**场景 C（emergency 风暴挤占 ladder 维护预算——两闸交互的隐藏代价）。** emergency 分支绕过 hourly 闸与 60s 间隔（trigger.js:151 的闸门只包住 pressure/growth），但它提交时同样向 `foldsThisHour` 推时间戳（state.js:450-451 对一切提交一视同仁）。推演：会话在 95% 附近震荡，每 90s 冷却一过就机械折叠一次——6 次 emergency 之后 hourly 计数打满，**pressure/growth/ladder 全部被 hourly-cap 拒绝直到窗口滑出**，而 emergency 自身照常开火。结果是机械折叠独占预算、侧模型蒸馏在震荡期 starvation。emergency 不受 hourly 约束本身正确（95% 时不容讨价还价），但其消耗对其他层级的挤出效应无任何注释提及；若要缓解，可让 hourly 统计排除 emergency 提交（计数与闸门对齐），或在 ladder 拒绝时给出 reason 区分被挤出与未就绪。

**场景 D（ladder readiness 与 cadence 闸的次序收益）。** trigger.js:187-196 先判 readiness 再查 120s/hourly，使「未就绪」与「就绪但被限流」在 reason 上可分（below-thresholds vs ladder-min-interval/hourly-cap）——对比 raw 路径的 hourly 拒绝混入 below-thresholds 兜底（trigger.js:214），同一文件内两种观测口径并存，日志消费者需要记住差别。属于第四节 #3 瑕疵的另一面。

### 六、本节小结

trigger.js 的判定矩阵在「注释声明 vs 代码实际」维度全部对得上（三闸非对称、readiness 先行、tie 取深层都有据可查），纯函数纪律执行到位。本轮把第一轮的 P0-1 上升为架构观察（frontier 是候选与覆盖的唯一衔接件），新增两个跨文件契约点待 index.js 定性：emergency×foldable 死锁态是否有装配层旁路（T2）、ladder tier 字符串到数字 tier 的映射落在何处（T3）。默认值与滚动窗口表达式的复制面清单已备齐，供 config.js 章节终验与卫生批处理合并执行。

---

## 第二轮巡检 · 文件四：host/context-trim/summarizer.js（237 行，摘要产出层）

> 三条产出路径（模型摘要 / ladder 蒸馏材料 / 机械摘要）在第一轮已建档，本轮聚焦失败模式的精确机理：零物料摘要的逐步落点、「head+tail」注释与实现的逐行对照、以及第一轮未及的三个新失败面。

### 一、三条产出路径与调用图（第二轮复核）

- `summarizeWithModel`（summarizer.js:191-237）：`llm.prepareCall({provider, model, maxTokens}, signal, (controls) => controls)` → `call.stream({...call.config, system, messages, signal})` 流式拼 text。失败面五类全部归 null：无 route（:193）、无 prepareCall（:194）、finish kind error/aborted（:225）、空输出（:229）、任何异常（:231-233，含 120s AbortController 超时 :199）。`onFail` 回调是唯一观测口，reason 字符串区分五类。
- `renderMaterial`（:57-106）与 `renderLadderMaterial`（:137-157）：同一 400k 字符封顶模式的两个实例，逐条累加、超限即断、尾部贴截断横幅（:104/:155）。确定性由 refOf 与块序保证。
- `mechanicalSummary`（:161-183）：每消息一行（ref + role + 首行 160 字符），首行取**第一个非空 text 块**（:171-176），空白折叠后截断（:178）。

### 二、失败模式逐条审查

**S1（零物料摘要的精确机理——第一轮 P1 的行级落实）。** `renderMaterial` 的预算检查在**入列之前**（summarizer.js:97-100）：单条消息 head+body 即超 400k 时，循环首迭代就 break，`parts` 为空，随后 :104 仅追加截断横幅——「material truncated after 0 chars; 1 messages dropped」。该横幅就是发给侧模型的**全部**用户消息；模型对「什么都不在」的输入产出一段泛泛而谈，`summarizeWithModel` 只拒空不拒泛（:229），折叠照常提交，**一条超限消息被永久替换为无信息量摘要**。同时确认第一轮记录的注释矛盾：summarizer.js:28-29 声称「keeps head+tail and marks the cut」，代码里**只有 head 保留逻辑，不存在任何 tail 保留代码**——横幅之后无第二个循环。修法两选：单条超限时对该消息单独 head/tail 截断（保住横幅承诺），或拒绝提交该折叠（fail-closed，宁可让 95% 应急层接手）。

**S2（length 截断的摘要静默入库——本轮新发现）。** 流循环对 finish kind 的处理只拒 `error`/`aborted`（:225）；kind 为 length（maxTokens 打满）或其他值时循环继续、文本照收。maxTokens 缺省 8192（:196）：一个贴着上限被拦腰截断的摘要**不带任何截断标记**直接返回并永久提交。对比 renderMaterial 对输入侧截断郑重贴横幅，输出侧截断却无痕——不对称。一行修补：finish kind 为 length 时在摘要尾部追加 `[output truncated at maxTokens]`。

**S3（mechanical 摘要的「supersede」承诺无法兑现）。** summarizer.js:181 向读者承诺「the next model-driven fold will supersede it」——但折叠是 append-only 的：机械块提交后 frontier 越过该段，后续模型折叠只覆盖 frontier 之后的**新**消息，永不回头重摘；唯一再触碰它的是 T2 ladder 蒸馏（commitLadderFold 对消费块的 kind 不设限，state.js:334-337 只查存在/活跃/tier-1）——而蒸馏是进一步压缩，不是细节恢复。机械折叠的信息损失（:181 自己承认「exact details are NOT preserved」）是**永久**的，注释的措辞会让维护者误以为有恢复路径。建议改为「losses are permanent; ladder may compress further but never restores」。

**S4（错误前积累的部分产出被整体丢弃——保守正确，代价是整轮重试）。** 流中途出错时已积累的 text 全部抛弃（:231-233 return null）：一个 90% 完成的摘要不参与任何降级。下一轮 idle 触发器重新开火时，renderMaterial 全量重算（含 refOf 重哈希）+ 侧模型全额重跑。保守取向正确（错误后的文本可能残缺），但调用方（index.js）的重试节流决定了代价上限——index.js 章节回查 inFlight 与 skip 预算的相互作用。

**S5（超时路径的双出口）。** 120s 到点 `controller.abort(new Error("trim summary deadline"))`（:199）后，出口取决于 `call.stream` 对 signal 的兑现方式：抛 AbortError → 走 catch（reason "error: trim summary deadline"）；以 finish kind "aborted" 收尾 → 走 :225（reason "stream-aborted"）。两条路径观测特征不同但结果一致，日志消费需知晓。signal 兑现本身是对 llm 服务契约的跨文件信任（:208-212 注释自认与 intent classifier 同构）。

### 三、场景推演

**场景 A（S1 全链）**：用户粘贴 500k 字符日志 → 段成长为唯一候选 → growth/pressure 触发 → renderMaterial 首迭代即超限 → 材料仅剩横幅 → 模型输出「这段对话无法总结…」类空话 → 提交 → 永久丢失。用户侧症状：长日志粘贴后上下文里只剩一句无内容摘要。**这是第一轮 P1 里对用户伤害最直接的条目，行级证据已齐。**

**场景 B（S2 全链）**：材料 350k 字符（合法入列）→ 模型按 KEEP 规则输出至 8192 token 上限被 length 截断 → 摘要在项目符号中间戛然而止 → 无标记提交 → 该折叠块此后被 T2/T3 反复蒸馏，截断处的半句话作为「事实」进入上层摘要。蒸馏提示词「Treat the input summaries as facts already settled」（:115）反而放大了截断噪声的固化。

### 四、导出函数第二轮要点

1. `SUMMARY_TIMEOUT_MS=120_000`（:26）/ `MAX_MATERIAL_CHARS=400_000`（:30）：材料以**字符**计、估算与触发以**token**计、输出以 **maxTokens** 计——同一管线三种度量单位，各自独立封顶。无 bug，但任何一处调整都要人工对齐另外两处的量级。
2. `SUMMARY_SYSTEM_PROMPT`（:34-52）/ `LADDER_SYSTEM_PROMPT`（:112-132）：KEEP/DROP 规则两份近全文手写副本（:37-45 vs :117-123 逐行同构），差异仅在开头角色句与 ref 锚要求。压缩规则演进时需双改，漏改即两层级规则漂移——建议以数组拼接组合出共享段。
3. `renderMaterial`：非 text 块走 `JSON.stringify` 计入材料（:73-78）——base64 图片在材料侧同样膨胀（与 view.js V11 在两个独立度量的双重叠加）；`[unserializable]` 兜底两处（:76/:85）。tool_calls 追加段（:88-94）使模型可见调用全文——KEEP 规则的「signatures」要求有材料基础。
4. `renderLadderMaterial`：单块超限在此**不可达**（T1 摘要 ≤ 8192 token ≈ 32k 字符，机械摘要每消息 160 字符 ×N，均远低于 400k）——S1 的零物料风险是 T1 专属。tier 归一（:142）对 tier 缺失块回退显示 1，仅影响材料标注不影响提交。
5. `mechanicalSummary`：160 字符上限是内联魔法数（:178，无命名常量）；tool_result 消息的首行常为 JSON 括号噪声，应急场景可接受。「Open objectives…NOT preserved」的免责声明诚实，唯 supersede 措辞失实（S3）。
6. `summarizeWithModel`：`(controls) => controls` 恒等回调无注释解释其契约（:204，仅说「same waterfall shape」）；`...call.config` 先展开、system/messages/signal 后覆盖（:213-220）键序正确；`source: {kind: "dsh-switchman-trim-summary"}` 请求侧溯源标签与日志事件无关，不触及 surface 的 sourceEventSeqs 校验。:207 有一处多余缩进（`let finishKind`），纯外观。
7. `renderMaterial` 不验证范围参数：`startIdx > endIdx` 或空数组时返回**空字符串**（循环零迭代、truncated 为 false、连横幅都没有），下游把空材料发给侧模型——大概率换回空输出被 :229 拒绝，浪费一次调用。当前装配层有 trigger 的 increment ≥ 1 前置（trigger.js:138）兜着，属防御缺口而非活洞；一行 `if (endIdx < startIdx) return ""` 语义不变，但调用方契约应写进 JSDoc。
8. 材料渲染的字符串经济：`text +=` 与 `parts.join("")` 的数量级在 400k 封顶下无性能问题；非 text 块逐个 `JSON.stringify`（:73-78）对图片块最贵，与 V11/S1 同源——若将来做材料瘦身，图片块的三处（估算、材料、序列化）要一起处理。
9. **依赖注入的解耦纪律**：`renderMaterial`/`mechanicalSummary` 的 `refOf` 全部由参数注入（:57/:161），summarizer.js 的 import 表只有 `randomUUID`——与 view/state 的环依赖问题（view.js:37-39）对照，本文件是三文件里唯一零内部依赖的，注入式设计是其可测性的直接来源。
10. `LADDER_SYSTEM_PROMPT` 对 T2/T3 **共用同一份**（tier 无感），层级区分只体现在 renderLadderMaterial 的块头标注（`(tier N, ~X tokens, N msgs)`）——模型拿到的层级信号很弱，蒸馏 T3（摘要的摘要）时无从调整粒度。低成本改进：材料头部或提示词加一句「you are distilling level-N summaries」。

### 五、与第一轮结论的交叉核对

- **P1「零物料摘要」**：确认并行级落实（S1），同时证实「keeps head+tail」注释与实现矛盾的第二半——tail 保留代码根本不存在。
- **P1「inFlight 副候选消耗 skip 预算」**：属于 index.js 侧，本轮 S4 补充了摘要层的重试成本背景（材料重算 + 全额模型调用）。
- **新增**：S2（length 截断静默入库，P2 偏上——直接损伤折叠质量且被蒸馏放大）、S3（supersede 措辞失实，P2 文档）、S5（超时双出口观测差异，P3 备注）。

**场景 C（侧模型路由死亡的 120s 空转环）。** route 配置指向的 provider 宕机：每次 idle 触发 pressure/growth → renderMaterial 全量渲染（大材料可达百毫秒级）→ `prepareCall` 或首 chunk 挂起至 120s 超时 → null → 整轮作废。60s 折叠间隔与 hourly 闸把重试频率限在每小时 6 次，但每次都是**全额 120s 的挂起等待**——若 index.js 在等待期间持有 inFlight 锁（其语义在 index.js 章节核对），会话的折叠通道在该分钟内完全不可用；唯一豁免是 emergency 机械路径（不经过 summarizeWithModel）。缓解方向：连接类失败（no-route、即抛异常）与超时失败应有不同的退避策略，前者不该付 120s。

**S6（onFail reason 的机器可读性）。** 五类 reason 中四类是稳定枚举（no-route / no-prepare-call / stream-error / stream-aborted），「empty-output finish=…」与「error: …」是复合串。若将来接 metrics（metrics.js 在八文件范围外，标注待验证），复合串需要再解析；建议枚举与细节分字段传递。另注：fail 回调仅在返回 null 的路径触发，成功路径无任何打点——成功率统计要靠调用方自行包一层。

**S7（摘要非确定性与视图字节稳定的边界）。** 两个系统提示词都不要求温度/种子控制，同材料两次调用可产出不同摘要——折叠是一次性事件（提交后 wire 文本由 `summaryMessageOf` 固化），因此不破坏「折叠之间字节稳定」的金测承诺；但重试路径（S4）意味着**同一材料**两次产出不同摘要且先败后成的那个入库——无一致性问题，仅为「摘要内容不可复现」的记录。CJK 会话按 :50/:130 的语言跟随规则产出中文摘要，`[SWITCHMAN:TRIM] ` 前缀恒为英文——识别锚与内容语言解耦，设计正确。

### 六、本节小结

summarizer.js 的失败面收敛纪律（五路归 null、永不抛出）与第一轮判断一致，本轮把其中最伤用户的一条（零物料摘要）钉到了行级并证实「head+tail」注释完全失实；新增的 length 截断静默入库（S2）建议与 S1 同批修复——两处都是「截断无痕」家族。supersede 措辞（S3）与 onFail 复合串（S6）归入文档与卫生批。三度量单位（字符/token/maxTokens）的量级对齐表建议写入 docs/ladder-fold.md 以防将来单独调整其一。

依赖面结论：本文件零内部 import（refOf 注入），是 context-trim 五件中解耦最彻底的一个，第一轮「同 waterfall 形状」的类比在本轮得到结构层面的印证（prepareCall + stream + source 标签三件套逐一对应）。遗留待 index.js 定性的挂起点两项：S4 的重试成本是否被 inFlight 锁放大、S1/S2 的修复落点在装配层的调用参数上还是本文件内部。

验证口径备注：本文件全部行号为静态阅读结论，S5 的双出口行为依赖 llm 服务对 signal 的兑现方式，属于跨包契约，动 CJK 估算或超时参数前建议先以 intent classifier 的现网日志交叉确认。

---

## 第二轮巡检 · 文件五：host/context-trim/surface.js（1090 行，表面替换通道）

> 第一轮已记录区间映射双策略与 crash 窗口三段式论证；本轮做四件事：把 T1 装运管线拆成可核对的步骤序列、逐条审查六个安全检查的覆盖与漏洞、复核 crash 窗口论证在「重复拒绝」场景下的边界、以及清点观测与卫生面。

### 一、控制流与装运管线（第二轮复核）

- **sweep 的 T1 主路径步骤序**：pending 过滤（surface.js:645-651，marker 排除 + tombstone 按 generation 重开）→ 三道前置闸（enabledNow :653 / surfaceCapable :658 / compaction lock :665）→ 活表面快照四件套（nodes/pairs/nodeMessages/liveGeneration :673-679）→ 逐块：存储捕获校验（validateStoredSeqs :852）→ 失败则活定位 + 端点等同 + 碰撞检查（:856-892）→ closeToolPairSpan 闭合（:912-929）→ system 头钳制（:941-954）→ 幂等带（:955-956）→ prune + replace 双追加（:980-988）→ 落 marker + 刷新快照（:994-1014）。**每次成功装运后全量刷新四件套**是本管线的承重纪律——被遮蔽的 seq 已离开 surface.nodes，后续块必须在装运后表面上解析。
- **ladder 分支**（:694-839）：consumes 缺失即 tombstone（:698-707）；consumed 未装运且自身未 tombstone → 等待（:708-727，依赖台账连续性保证 consumed 在本轮更早位置先处理）；consumed 的 replacement node 离开表面 → ladder-span-gone（:739-750）；跨度必须**恰好**等于 consumed replacement node 集（:751-756）且逐节点验证 acp_summary_ 前缀（:757-764）；防漂移头钳制（:779-788，注释自认 summary node 不可能为 node 0 但值得一比）。
- **captureFoldSeqs**（:567-605）的「不预闭合」注释（:588-594）是本文件第二好的推理段：装运时闭合会延伸存储区间、使其端点不再衍生 ref id、从而必然过不了 validateStoredSeqs 的端点同一性复检、最终 tombstone 成永久不可装运——注释把这条「看起来该做但做了就坏」的链完整写出，属于高价值设计记录。

### 二、安全检查矩阵逐条审查

安全检查速查表（第二轮实测整理）：

| 检查 | 位置 | 失败去向 | 方向 |
| --- | --- | --- | --- |
| 稠密覆盖 | validateStoredSeqs :397-403 | incomplete-seqs | fail-closed |
| 端点同一性 | validateStoredSeqs :404-426 | incomplete-seqs | fail-closed |
| 重定位端点等同 | :875-887 | incomplete-seqs | fail-closed |
| 碰撞检查 | overlapsReplacedRange :440-466 | incomplete-seqs | fail-closed（catch→true） |
| 工具对闭合 | closeToolPairSpan :912-929 | tool-pair-unclosed | fail-closed |
| system 头钳制 | :583-587 / :941-954 / :779-788 | 剥离或 system-head | 纵深三重 |

1. **稠密覆盖检查（validateStoredSeqs :397-403）在存储路径上蕴含碰撞检测**：另一块若已遮蔽本跨度中段，节点列表中段混入 replacement node → `span.length !== stored.length` 即 null → 走重定位路径 → 端点匹配失败（旧端点已离开 nodes）→ incomplete-seqs。存储路径无需 overlapsReplacedRange 即安全，是「稠密性」设计的隐性红利（代码未明言此推论）。
2. **重定位的三重等同条件**（头注释 :39-46 与实现 :875-892 一致）：端点仍是活节点 + 与定位跨度端点相等 + 无碰撞。locateOnSurface 取**首个** count 锚定命中（:368-371），内容寻址 ref 的「更早相似跨度」风险由此被端点等同条件封死——两处设计互为钥匙，核验一致。
3. **overlapsReplacedRange（:440-466）的 fail-closed**（catch 返回 true，:463-465）：安全检查方向正确；legacy 区间近似层（:458-460）对非单调跨度的过近似会误杀合法重定位——注释自认「the safe direction」，可接受。
4. **closeToolPairSpan 的 healing 假设有一处未言明的覆盖面前提**（:199）：`owner < 0` 被解释为「call 已被遮蔽/不存在」从而维持跨度（把孤儿 result 一起带走是治愈方向），但这隐含**调用形状识别覆盖 ⊇ 结果形状识别覆盖**——若某 result 形状被 toolResultIdsOf 认出（:122-135 三种）而其 call 形状不在 toolCallIdsOf 的三种内（:103-117），owner 同样 < 0，跨度带着一个 call 尚在表面的孤儿 result 装运，提供商序列化将拒绝整个请求。形状集当前对齐，此为防御盲区而非活洞；建议注释补上该前提。
5. **system 头的双重钳制**（capture 时 :583-587 + ship 时 :941-954）与 ladder 侧防御钳制（:779-788）：三处独立防线，跨进程持久化的旧捕获也受 ship 时钳制保护（:935-937 注释）——纵深合格。
6. **crash 窗口论证的跨代复核（对第一轮结论的补强与限定）**：三段式论证（孤儿 prune 无害 / 稠密校验必败 / 内存幂等带）在「单次 crash」语义下完全成立；但 append 抛错路径（:1021-1033）里 **prune 已持久化而 replacement 失败**——block 被锁进 append-rejected tombstone，generation 变化重开后**重新解析出同一跨度并再次追加 prune**。每次失败的 generation 周期留下一行未配对、未计价的孤儿 prune。定价论证使它们无害（log-only、不遮蔽任何东西——prune 是 log-only 类型，遮蔽只来自 replacement 的 surfaceOp），但「worst case one duplicated log-only prune row」（:978-979）是**按 crash 计**而非按会话生命周期计的界限；跨多次 generation 变化可累积。建议：append 失败的 catch 里检测「prune 已落」并改用独立 reason（如 prune-orphaned），或装运前查询是否已有同跨度孤儿行。

### 三、观测与卫生面

- **skip 家族的观测不对称（本轮新发现）**：incomplete-seqs / not-located 用 `dedupe=false`（:860/:863/:884/:890），重开后必留痕；tool-pair-unclosed 走默认 dedupe=true（:920），而其 extra（`block=<id>`）稳定不变——**generation 变化重开后的再次失败在 decisions.log 里完全不可见**（skipSeen.get(key) === extra 直接吞掉，:625）。同一个「generation 键控重开」机制，四类 reason 两种观测口径，日志消费者无从区分「静默的好」与「静默的坏」。修法：重开路径统一 dedupe=false，或 extra 拼上 generation。
- **generation 只来自 sessionHint**（:638-644）：`:650` 的 `generation !== null &&` 意味着无 hint 的 sweep **永不重开** tombstone——第一轮 P1 #6 的行级落实。附带发现：若调用方传入**过期的** hint（旧快照对象），tombstone 以过期 generation 写入（:699 等），正确 hint 的后续 sweep 判 `tomb.contentGeneration !== generation` 恒真 → 每轮重试直至 generation 对齐——重试风暴的边界取决于 hint 新鲜度，当前唯一调用方传活载荷对象，风险为潜在。
- **三个有界注册表**：lockCache 200（:540）、replacedKeys 500 + 1h TTL（:557/:561）、skipSeen 200（:626），全部 FIFO 驱逐——与第一轮记录一致，本轮逐一定位了行号。
- **默认开启的两连**（:480）：`readBool(config, "surfaceFold", true) && readBool(config, "trimEnabled", true)`——配置缺失时**最激进**的通道（向会话日志追加事件）默认激活。与「trimMode 不查」（第一轮 P0-2）在同一行：enabledNow 只看两面旗帜，mode="off" 的「measure only」承诺在此不生效。默认值取向是设计立场（fail-open 的极致），但应在 config 文档里显式声明「缺省即开启」。
- **"Trigger 1" 编号残留**（:1071）：注释编号暗示存在 Trigger 2，实际全文件只有 turn-stopping 一个监听器（:1074-1087），文件以 return 结束（:1089）——idle 触发由 index.js 外部调用 sweep 承担。编号是历史残留，误导读者去找不存在的第二个注册。
- **性能小账**：byId Map 在 ladder 分支的**每块循环内重建**（:696）——O(块数²)，块数十规模无实感；derivingPairsOf 每次装运后全量重跑（:818-819/:1011-1012），每次 O(nodes) 次 eventAt——idle 频率下可接受，均记录在案。

### 四、导出/闭包件第二轮要点

1. 返回签名 `{ sweep, captureFoldSeqs, enabledNow, supported }`（:1089）——头注释（:469）漏 enabledNow 的文档漂移（第一轮已记）本轮再次确认。
2. `sessionIdOfAgent`（:237-244）与 index.js `agentSessionIdOf` 孪生的成因注释（:234-236 环依赖）与 view.js isLadderBlock 的环依赖注释同构——本仓库环依赖的统一解法是就近内联，三处 isLadderBlock 副本 + 一处会话 id 提取副本均由此而来。
3. `replacementMessageOf`（:253-258）：纯 `{kind:'user'}` source 的 v4 校验器规避（:59-67 头注释完整记载了 compact-checkpoint 事故）；确定性（无时间戳）保障重放一致。
4. `messageOfEvent`（:265-281）/`eventsOf`（:286-302）：宿主 helper 存在性探测 + 内联投影回退的双轨制，空 content 派生 null 的规则与宿主对齐（:277）。
5. `supported()`（:1060-1069）的 freeze 事故注记（:1054-1059「135k tokens while decisions.log reported a 50k view」）是「recency 绝不作为折叠闸门」不变量的出处，本轮确认其与 lock 缓存（seq 键控）的实现闭环：supported 是 O(1) 且永不因「很久没装运」而变 false。

### 五、与第一轮结论的交叉核对

- **P0-2（trimMode 缺口）**：在 :480 确认第三处现场（surface sweep 只查两旗）。
- **P1 #6（generation hint）**：:638-650 行级确认，并补充过期 hint 的重试风暴边界（第三节）。
- **第一轮「crash 窗口三段式是全仓库最佳并发推理范本」**：维持评价，但补充按代累积孤儿 prune 的边界修正（第二节 #6）——范本仍有可补的一章。
- **第一轮「有界注册表 200/2000/500」**：本文件实测为 200/500/200；「2000」应属 index.js 或 watch 层，index.js 章节对账。
- **新增**：稠密检查蕴含碰撞检测的隐性红利（正面确认）、healing 覆盖面前提（P3）、观测不对称（P2 偏上——直接影响运维排障）、孤儿 prune 跨代累积（P3）、Trigger 1 编号残留（P3）、过期 hint 边界（P3）、byId 循环内重建（卫生）。

### 四′、场景推演（补充）

**场景 A（观测黑洞的完整链）**：某块的跨度起点落在一个 call 与其 result 之间且 call 已被宿主压缩遮蔽 → closeToolPairSpan 后向探索 owner<0 → 按 healing 维持原跨度 → 装运了一个「起点是孤儿 result」的范围 → 下次派发提供商序列化报 "tool result has no matching call" → 排障者查 decisions.log 只看到一次 tool-pair-unclosed 之前的旧记录……（注：此链需要 healing 误判 + 请求真正发出两步，属组合边角；但它展示了观测不对称为什么危险——tool-pair-unclosed 的重开静默让这类排障失去线索。）反向案例：incomplete-seqs 因 dedupe=false 每代必留痕，运维侧会误以为它比 tool-pair-unclosed 更频发——两类 reason 的日志频率不可直接比较。

**场景 B（ladder 等待链的两种终局——正面确认）**：ladder 块的 consumed 未装运时进入等待（:708-727）。终局一：consumed 在同一 sweep 更早位置装运成功（台账顺序保证）→ ladder 下一轮以新 nodes 重解 → 正常装运。终局二：consumed 被硬跳（如 tool-pair-unclosed）→ :710-722 检出其 tombstone → ladder 同步锁进 ladder-consumed-skipped 且**有日志**。两个终局都有出口且都可观测——这条链是 surface.js 处理得最周全的部分；唯一的缝隙是终局二的日志走 dedupe=true 通道（:721），consumed 的 tombstone 若被代际重开消除，ladder 的同步跳过记录不会再次出现。

### 五′、本节小结

surface.js 是八文件中安全检查密度最高的一个，本轮逐条核验后确认：六个安全检查（稠密校验、端点同一性、端点等同重定位、碰撞 fail-closed、工具对闭合、三重头钳制）方向全部正确、注释与实现一致率高。需要跟进的三件事按优先级：观测不对称统一（影响每一次线上排障，P2 偏上）、append-rejected 路径的孤儿 prune 跨代累积（P3，改 reason 或加检测）、healing 覆盖面前提补注释（P3）。第一轮给出的「最佳并发推理范本」评价在补上「按 crash 计」的界限修正后维持。

---

## 第二轮巡检 · 文件六：host/context-trim/index.js（1061 行，装配层）

> 装配层是前五节全部跨文件契约的会师点。本轮先裁定遗留契约（ladder tier 映射、registry 清单、protectedTail 脚枪、P0-2 全貌），再给出三个本轮新论证（副候选预算算术、P0-2 的完整现场清单、决策日志经济）。

### 一、遗留契约裁定（前五节挂起点的会师）

1. **ladder tier 字符串映射（trigger.js T3 挂起）——已解决**：runFoldCycle 在 commitFold 候选里显式映射 `tier: decision.tier === "ladder-3" ? 3 : 2`（index.js:633）。隐式契约有唯一兑现点且实现正确；建议未来把字符串常量提升为共享枚举以防两处漂移。
2. **「2000」有界注册表（surface.js 节挂起）——已解决**：inheritDecided / inheritFirstSeen / inheritWarned 三张 Map 各 2000 上限（index.js:347-358）。加上本文件的 captures/trimViewBySession/windowCache/lastEmergencyAtBySession/sideDispatchSkipsBySession/lastStreamCheckAt/epochResetDoneBySession/foldFailureBySession（全部 200，:500/:590/:486/:660/:559/:1010/:576/:285）与 surface 的 200/500/200——装配层共 **12 张有界注册表**，全部 FIFO 驱逐、无一持久化。数量本身值得一个注册表工厂（卫生批）。
3. **protectedTail 缺省脚枪（view.js V6 / trigger.js T2 挂起）——降级为潜在项**：thresholdsNow 缺省 protectedTail=6（index.js:404），且四个调用点（applyViewToOptions :513-515、runFoldCycle :614、ctx_trim_fold :943、ctx_trim_status :878）全部显式传值。view.js/trigger.js 的 `> 0` 归零语义只在未来新调用方漏传时引爆——维持记录，降为 P2 潜在。
4. **计量口径（第一轮 P1 #1）——trim 侧落实**：pressure/emergency 的分子是 `Math.max(capture.viewTokens, wireTokens)`（index.js:728-729），tally 缺失时退回纯视图。窗口取 `min(模型解析窗, cap)`（index.js:475，effectiveWindowTokens :204-210），cap 缺省**自动跟随 watch 层的 wmForceTokens**（index.js:448-453）——跨层键复用是双向耦合点：watch 调 force 档会隐式抬升 trim 的压力数学，改任一侧都要想另一侧。watch 侧口径下一节对账。

### 二、P0-2 的完整现场清单（第一轮结论的全貌化）

trimMode/trimEnabled 的语义缺口在装配层共四处现场，逐一确认：

- **streamListener 只查 enabledNow 不查 mode**（index.js:979、:990、:1006 的 fallback 折叠检查反而查了 mode）——`mode="off"` 时视图仍拼进每一次派发，「measure only (no banner, no folds)」的三承诺全部落空两项（banner 见下、folds 由 maybeFold :696 的 mode 闸挡住——只挡住一层）。
- **TRIM_PROTOCOL_TEXT 无条件注册**（index.js:774-775）：不看 enabled 也不看 mode，`trimEnabled=false` 时模型仍看到完整的 trim 协议头（包括 ctx_trim_fold 的使用说明）。
- **两个工具无条件注册且 execute 无闸**：ctx_trim_status（:867-901）显示 mode/enabled（:879，观测正确）但 ctx_trim_fold（:906-972）的 execute（:921-968）对 enabled 与 mode **零检查**——总开关关闭时模型仍可折叠并落台账。
- **surface sweep 只查 surfaceFold && trimEnabled**（surface.js:480，第一轮已记）。

综合判定：P0-2 不是单点遗漏而是「总开关语义在四个入口四种解释」的系统性缺口；修复应以「enabled 总闸 + mode 分闸」的单一谓词函数为起点，四处现场统一调用。

### 三、本轮新论证

**N-A（副候选预算算术——第一轮 P1 #4 的精确化）。** sideCandidate 的 inFlight 子句（index.js:554）把折叠周期自己的 summarizer 派发也判为副候选（材料派发命中同一个 llm/stream 监听器）。预算算术：SIDE_DISPATCH_SKIP_BUDGET=2（index.js:75），连续跳过计数只在接受主派发时清零（:564）。三次连续副派发即耗尽预算——第三次 summarizer 派发被**当作主历史接受**，capture/增长基线/trimViewBySession 全部被材料派发覆盖（正是 2026-11-04 事故的形状）。触发条件是三个连续折叠周期之间没有 intervening 主派发（idle 与 stream 双触发器紧密连发时可能）。修法与 :571-572 注释的自洽方向一致——那段注释已认定 inFlight 派发「not epoch evidence, just self-noise」，同一个论据应把 inFlight 子句从预算计数中豁免。

**N-B（决策日志的经济性）。** view-applied 行每次派发一条（:536）、decision/outcome 每次折叠两条（:743/:756）、side-dispatch 与 epoch 行偶发——2MB 轮转保留一代（index.js:310）意味着活跃会话数天一轮转。单文件 + 一代备份的保留策略对排障够用，但 decisions.log 与 decisions.log.1 都无压缩；长期运行的生产档建议加代数上限。

**N-C（llm/stream 的 global+prepend 挂载注释是第三份事故推理范本）。** index.js:1024-1029 记录了 cordis dispatch filter 静默丢弃非 global 监听器的事故（resumed session 走自己的子树），与 surface 的 crash 窗口论证、view 的字节稳定注释并列为本仓库的三处高价值失败记录。effect 化的卸载（:1038-1053）保证 reload 安全。

### 四、导出/闭包件第二轮要点

1. `recentTrimViewTokensOf`（index.js:91-106）的三重闸：TTL 10 分钟 + inject==="none" 拒绝 + lastNoneAt 黏性窗口（:100-101，混合会话实测注记「46 none + 14 swapped」）——watch 层的口径对账点，下一节验。
2. `maybeFold` 的门序（:693-717）：enabled/mode → inFlight → 失败退避 → 有 capture → **双通道注入闸**（:714，inject==="none" 且 surface 不可值时才放弃——2026-11-05 死锁教训的正面实现）。
3. 失败退避梯（:276-300）：60s 起 2^(n-1) 增长、15min 封顶、count 封 16；注释点出要害「失败不推进任何 cadence gate」——这是对 summarizer 节 S4（重试成本）的装配层答案：重试被退避梯节流，S4 的 120s 空转最多 15 分钟一次。
4. `ladderRunsOf`（:420-445）：游标式 maximal run 扫描，tier 切换/失活/T3 插入都正确断链（本轮逐分支核验）；mass 用 CJK 感知的 summaryTokensOf（:414）与视图估算同单位——单位一致性合格。
5. `ctx_trim_fold` 的 count 缺失回退（:934-941）确认为「猜测」家族，但下游有三道真闸兜底：protectedTail（:944）、segment 对齐（:945）、commitFold 带 positions（:957）。第一轮 P2 维持但补注：与 surface.js locateOnSurface 拒绝猜测的哲学差存在于**入口**而非**出口**——坏猜测最终会被三道闸拦下，代价是拒绝消息而非错误折叠。
6. `ctx_trim_status` 的逐消息列表（:893-895）确认无输出上限；T2/T3 蒸馏目标（ladderRunsOf 的 run/mass）未进入 status 输出——模型看不到「可以蒸馏什么」，advisory 蒸馏实际不可达（工具只有 raw 折叠），ladder 完全是引擎单方维护路径——与头注释「the session model may fold ranges itself」的范围表述一致但值得明说。
7. 应急冷却在周期**之前**盖章（:653-660）并附「拒绝也要冷却」的推理注释——与 maybeFold 的失败梯正交，两套节流无冲突。
8. 裸捕获先于 splice（:516-520 注释解释了 refs 必须对 raw 解析的原因）——装配次序的承重细节，第一轮未展开，本轮确认其正确性。

### 五、与第一轮结论的交叉核对（index 部分）

- **P0-2**：全貌化（第二节四处现场 + 系统性判定）。
- **P1 #4（inFlight 副候选）**：算术精确化（N-A），修法方向明确。
- **第一轮 P1 #2「post-execute cap 路径短路 next()」**：**不在本文件**——本文件的 tools/post-execute 监听器（:813-837）对不匹配调用走 `return next()` 快速路径、对匹配调用 await next() 后再做簿记，无短路；该条归属 context-watch.js，下一节核。
- **第一轮「待验证」清偿**：mergeIntentCandidates 仍属 intent.js（范围外维持待验证）；wmForceTokens 下取契约已验（第一节 #4）。

### 六、场景推演（补充）

**场景 A（副候选预算耗尽的完整链）**：会话触发 pressure 折叠 → 周期内 summarizer 派发命中监听器 → inFlight 子句判副候选 → 跳过 n=1 → 提交成功。60 秒内 stream 路径 fallback 再触发一次折叠 → 又一次材料派发 → 跳过 n=2。第三个周期（idle + stream 连发常见）的材料派发 skipCount=2 → 预算耗尽 → **被接受为主历史** → capture.messages 变成单条材料消息、trimViewBySession 写入材料尺寸、增长基线记录材料视图。下个真实主派发到来前，任何以 capture 为输入的逻辑（ctx_trim_fold、status、foldable 计算）都在处理材料而非历史——2026-11-04 基线污染事故的复刻路径，门在明处（:554）但预算把守形同虚设。

**场景 B（mode="off" 的实际行为walk）**：用户配置 trimMode="off"（意图：只测量）。实际发生：视图照常拼进派发（:979 只查 enabled）、协议头照常注册（:774）、ctx_trim_fold 照常可用（:921 无闸）、只有 maybeFold 与 stream fallback 的折叠决策被挡（:696/:1006）。三承诺（no banner / no folds / measure only）兑现一个半——而且「测量」本身因为视图在拼、模型在折叠而失真。用户对 "off" 的信任与实际行为之间的落差是 P0-2 判定为系统性缺口的直接证据。

### 七、本节小结

装配层的质量呈「双峰」：fold 事务主线（门序、双通道注入闸、失败退避、基线锚定）设计严密且注释一流；而配置语义（P0-2）与副候选预算（N-A）是两处「主线之外的入口忘了同一套纪律」的断层。本轮裁定了全部四项跨文件挂起（tier 映射、registry、protectedTail、wmForceTokens 契约），并把第一轮 P1 #2 的归属修正到 watch 层。下一节 context-watch.js 的对账点：measureNow 口径、post-execute 短路、以及 wmForceTokens 的产出端。

复核口径备注：本节行号基于当前 HEAD 的 index.js；:934-941 的 count 猜测与 :554 的 inFlight 子句是修复 P0-2 / P1 #4 时必须同步回归的两处测试点（各需一条「副派发三连」与「off 模式派发」的反向用例）。另注：本文件 :309 与 summarizer.js :207 各有一处缩进瑕疵，属同一批格式化残留，卫生批一并处理。

修复优先级建议：P0-2 与 N-A 应作为同一个 PR 的两半（同是「入口闸纪律」），单独修任一都会留下另一个同构入口。

---

## 第二轮巡检 · 文件七：host/context-watch.js（982 行，水位层）

### 一、导出函数与文件级职责

1. **`measureNow(ctx, agent)`**（context-watch.js:145-165，具名导出）：读一个 agent 会话的当前 token 用量。先走 `ctx.tokenMeter?.measure?.(agent.session).totalTokens` 得 `used`；随后执行**仪表二元性**（design §8）：取 `recentTrimViewTokensOf(sessionId)`（从 context-trim 反向导入，:56），非空则**整体替换**返回视图估算，否则回落 `used`。返回形状 `number | null`（meter 缺失/抛错 → null，fail-open）。这是水位层的唯一测量口，banner 与预算闸共用。
2. **`applyContextWatch(ctx, config)`**（:321-973，经 :975-982 的 export 块导出）：装配五个部分——A 水位渲染（head 静态协议 + tail 活行）、B 读预算双闸（post-execute 记账 / pre-execute 拒绝）、C 四步交接（borrow /compact）、D 三个 /ctx-* 命令、E ctx_handover 工具。
3. **`renderRootWatermark(level, status)` / `renderSubWatermark(level)`**（:200-222 / :227-235）：纯渲染，无副作用、无数字（模型可见性不变量的执行点）；force 行按 status.phase 分四态，冷却与工具提示按位拼装。
4. **`PAUSED_LINE` / `PROTOCOL_ROOT_TEXT` / `PROTOCOL_SUB_TEXT`**（:195-196 / :182-191）：三段字节稳定常量，head 协议（order 10500，:340-345）按 isRoot 二选一；暂停行冻结以避免快照churn（:193-196 注释）。

### 二、参数与返回值形状（关键签名）

- `levelOf(used: number, th: {soft, hard, force}) → "ok"|"soft"|"hard"|"force"`（:111-116），判定序 force 先行。
- `readThresholds(config) → {soft: 80000, hard: 120000, force: 150000}`（:136-142）——wmSoftTokens/wmHardTokens/wmForceTokens 的缺省即 trim 层 windowCapNow 的回落值（index.js:451），跨层缺省值两处手写一致（耦合点）。
- `renderWatermarkContext(ctx, config, state, agent) → string`（:239-269）：ok 层返回 `""`（快照零churn）；子代理分支用 wmSubagentCap/wmSubagentForceTokens 只覆盖 force 档（:252-254）；暂停会话返回冻结 PAUSED_LINE；活行携带 phase/cooldown/tool 状态。
- `resultTokens(result) → number`（:274-291）：content 文本块求和，无 content 则 `JSON.stringify(value).length`，兜底 String()；× 1/3.5。
- `accountRead(state, sessionId, tokens, now?) → entry`（:294-308）：15 分钟空闲窗重置（以**最后一次记账**为基准滚动，:296）；`turnUsed`（:311-315）过期读作 0。
- `runHandover(agent, sessionId, commandId, signal, source) → Promise<{kind: "success"|"error", text}>`（:612-789）；重试梯 delays = [5s,15s,30s,60s,120s,300s]（:641），attempts 上限即梯长；看门狗 20 分钟（:735-738）。
- `writeHandoverDoc(path, sessionId, backupId, used, live) → path|null`（:434-487）：文档含活子代理清单、liveness 复查 python 一行命令（:448）、目录/转录尾路径（:449-450）、待填五槽位（:473-477）。
- `armContinuation(agent, backupId, docFile, live, appeared) → Promise<void>`（:557-600）：followup + sessions.flush 唤醒；live/appeared 两句话术覆盖「列表内活着」与「压缩窗口期显形」两种情形（:564-578）。

### 三、边界条件与失败模式

1. **测量失败全链 fail-open**：measureNow null → renderWatermarkContext 返回 `""`（:245）→ 会话静止在 ok 层；预算闸同样放行（pre-execute :862 `used === null → next()`）。「测不到 = 不管制」是水位层的显式取向。
2. **isRoot 探测失败按 root 处理**（:130-132）：未知注册表 → 更丰富的 root banner 赢——注释写明这是有意取向。
3. **compact 后端不可达**：compactDefinition undefined → runHandover 立即 error（:617-621）；/ctx-handover 的报错文本明确指向 preset 未挂 compaction 的情形。
4. **inFlight 幂等闩**：重复触发返回 success 型提示而非错误（:615-616）；finally 双清理（clearHandover + inflight.delete，:785-788）。
5. **borrow /compact 的信号语义**：自动路径无真实 signal，恒携全新未中止的 AbortController.signal（:389-398，注释说明被借 handler 无条件触 throwIfAborted）。
6. **备份步骤已删除**：backupId 恒 null（:629），:625-628 注释记载 2026-11-05 事故——装机宿主缺 ctx.subagents.startContinuable，fork 每次必败，遂以 append-only 会话日志为备份。这是文件内第二处「删步骤留注释」的高价值记录。
7. **文档写入失败不阻塞压缩**：writeHandoverDoc 捕获一切返回 null（:483-486）；armContinuation 在 docFile 为 null 时指示 agent 自行建文档（:584）——降级链完整。
8. **重试与幂等**：settleAttempt 在失败且 attempts ≤ 梯长时按 delay 重试（:698-706）；agent/status 的 idle 事件与定时器双触发，`attempting` 闩折叠重入（:664）；`finished` 闩保证单次 resolve（:649-651）。
9. **看门狗 vs 慢压缩的竞态**：20 分钟看门狗 finish(false) 释放闩后，若被借 /compact 仍在跑并最终落盘，会话会被压缩但 **armContinuation 永不执行**——唤醒后只有压缩摘要、没有填文档指令（followup 丢失）。实测压缩 ~2 分钟，触发概率极低，但这是 runHandover 唯一的「半程交付」窗口。
10. **lastHandover 在启动时盖章**（:802）：runHandover 失败也吃满 10 分钟冷却——防紧密重试的保守取向，代价是失败后要等冷却才能自动再试（手动 /ctx-handover 不受此限）。

### 四、问题与可疑点（第二轮）

**W1（第一轮 P1 #2 的行级落实与定性）——post-execute cap 分支短路 next()。** 条件全中时（记账 ≥ ceiling、层 ≥ hard、wmDenyMode ≠ "deny"、result.content 是数组）直接 `return {kind:"accept", content:[...result.content, 警告块]}`（:834-844），**next() 不被调用**——管线中排在后面的 post-execute 处理器对该次调用全部跳过。两个次生问题：(a) 其他插件的收尾逻辑（计量、审计、渲染）静默失活；(b) 重建的 result 只保留 content 字段，原 result 上的 isError/value 等其他字段被丢弃——一条带 content 的失败结果会被改写成「成功 + 警告」。修法：先 `const downstream = await next()` 再向其 content 追加警告块后返回，语义与 fast-path 完全一致且不再截断管线。维持 P1。

**W2（第一轮 P1 #1 的最终裁定——从「问题」改判为「有护栏的二元性」）。** 本文件的组合规则是**替换**（:157 viewTokens 非空即 return），trim 层是 **max(view, wire)**（index.js:728-729）。两者方向相反但消费者不同：水位要反映模型实际看到的（折叠后变小），压力层要按最坏情况（视图漏计 system/context 段）。替换侧的护栏完备：recentTrimViewTokensOf 自带 10 分钟 TTL、inject==="none" 拒绝、lastNoneAt 黏性窗（index.js:96-102）。**结论：撤销第一轮的 P1 定性，降为 P2 文档项**——两条组合规则各自正确，但「为何相反」没有写在任何一处，下一个维护者极可能「修」错其中一条；应在 design §8 或两处函数头补一段对偶说明。

**W3（读预算的字符→token 系数与 trim 估算不一致）。** 本文件 1/3.5（:65），view.js 1/4 + CJK×1.0。对纯 ASCII 两者差 14%；对 CJK 文本，预算侧把每汉字记 0.286 token 而实际约 1 token——**读预算对中文内容低估约 3.5 倍**，预算耗尽点比设计意图晚数倍，硬档的「停止广读」对中文密集会话几乎不触发。方向是宽松（多放行），安全影响有限但与 wmReadBudgetTokens 的配置直觉偏差大；建议统一到 view.js 的 CJK 感知估算（两处已是同构计数循环）。

**W4（sessionIdOf 第三份手写副本）。** :119-122 与 index.js agentSessionIdOf（:124-131）、surface.js sessionIdOfAgent（:237-244）三胞胎——前两处有环依赖借口，本文件与 trim 之间**已经**存在导入边（:56 recentTrimViewTokensOf），第三份副本没有环依赖挡箭牌，可直接合并。卫生批。

**W5（看门狗半程交付）**：见第三节 #9，P3。

**W6（文档模板的占位符未替换）。** writeHandoverDoc 写入的路径含字面 `<DSH_HOME>`（:448/:450），靠被唤醒的 agent 自行解析——若 agent 不知 DSH_HOME 何在（新进程无环境上下文），liveness 复查一行命令不可直接执行。低成本修法：模板生成时以实际 home 路径代入。P3。

**W7（实测验证记录）。** 本轮巡检自身即触发过 cap 分支：某 turn 的警告行报 `used 70713/7200`——记账、ceiling 乘数（3000×2.4）、cap 模式（默认非 deny，警告追加后放行）全链工作正常；且该 turn 后续读文件仍被放行，验证了 cap 与 deny 两种 wmDenyMode 的分岔（:831/:865）。这是八文件巡检中唯一一条有**同会话实证**的路径。

### 五、与第一轮结论的交叉核对

- **P1 #1（计量口径相反）**：改判 W2——护栏完备、方向各自正确，P1 撤销，降 P2 文档项。这是第一轮清单里唯一被降级的条目。
- **P1 #2（post-execute 短路）**：维持 P1，行级落实（W1），归属从「装配层」修正到本文件 :834-844。
- **第一轮「无 hint 的 idle 清扫」「双定时复查」等 surface/index 侧挂起**：与本章交叉验证的 handover 唤醒链（armContinuation + recheck）闭环确认——四步交接的每一步都有对应代码位（:624/:671/:746/:777）。
- **第一轮 P0-2 关联**：水位层不受 trimMode 影响（独立层），但 wmForceTokens 同时是 trim 窗口 cap 的回落值——P0-2 修复时注意这个跨层键。
- **新增汇总**：W1（P1）、W2（P2 文档）、W3（P2，CJK 低估）、W4/W5/W6（P3）、W7（实证记录，非问题）。

### 六、装配内结构与补充要点

- **进程内状态五件套**（:323-329）：`paused: Set`、`inflight: Set`、`handoverTool: string|null`、`lastHandover: Map`（sessionId → epoch ms）、`readUsed: Map`（sessionId → {used, at}）——全部不持久化，进程重启即复位（头注释 :46 声明「the safe side」：重启恢复执法）。
- **文档路径的章语义**（:413-419）：stamp 在 runHandover 启动时冻结一次（docPath 只算一次，:638），同一次 run 的每次重试**覆写同一文件**——「refresh, not append」是压缩窗口内文档保持真实性的机制前提；post-wake 的两段增补（:511-523、:754-771）是显式例外，走 appendFileSync。会话短 id 取 `replace(/^session-/u,"").slice(0,8)`（:417）。
- **重查 knownIds 的组成**（:499）：`[backupId(null→""), ...wake时live清单]`——20s/75s 两探针只对**唤醒后**新显形者发增补；pre-compaction 已知者不重复播报。与 :751-753 的 appeared 差集是同一机制的两次应用（压缩窗口一次、唤醒后持续两次）。
- **三个命令的返回形状**：ctx-pause/ctx-resume 都返回 `{kind:"success"|"error", text}`，resume 对未暂停会话返回「was not paused」的中性成功（:905-911）；ctx-handover 直接透传 runHandover 的结果（:917-918），其 handler **不内联 await 语义由宿主决定**——与 ctx_handover 工具的 fast-return 形成对照。
- **ctx_handover 工具的 fast-return 设计**（:948-960）：execute 同步返回一段「END this turn now」指令文本，runHandover 脱钩运行——注释给出双重理由：await 会占住 agent 使 idle-only 的 /compact 永远等不到空闲；且返回文本明确要求模型收尾时告知用户「后台交接中」，防 GUI 在交接窗口显得假死。`exec.signal` 被刻意弃用（:951-952）——turn 级 AbortSignal 会杀掉必须活过本 turn 的压缩。
- **W8（新疑点→已坐实）：`firstPoolRoute` 是死代码。** :403-408 定义「读易变池字段的首个 {provider, model}」，本轮通读全文件未发现任何调用点；巡检中已 `grep -rn firstPoolRoute host/ index.js` 全仓核实——**仅定义处一处命中**，无任何调用。最可能成因：:625-628 注释所述 fork-snapshot 步骤（2026-11-05 删除）曾用它解析备份路由，删除时未清理。可直接删除（连同其唯一消费场景的注释假设）。
- **W9（观察）：accountRead 的空闲窗以「最后记账时刻」滚动**（:296/:305-306）——一个持续读文件的长 turn 永不重置，直到 agent/inbox/claimed 事件（:880-883）或 15 分钟静默。语义与「per-turn 预算」吻合，但依赖 claimed 事件在宿主侧可靠派发；若某宿主拓扑不派发（与 index.js:1001-1003 记录的 idle 事件丢失同款风险），预算会跨 turn 累积——cap 模式的警告会持续出现，deny 模式会误伤。与 trim 层的 lastStreamCheckAt 节流（60s）一样属于「对宿主事件可靠性的防御性冗余缺失」，P3 记录。

### 七、补充审查与交叉核对（续）

- **子代理 force 档覆盖的三态**（:252-254）：wmSubagentCap 关 → 用 root force；开且 wmSubagentForceTokens > 0 → 覆盖 force；开但值为 0 → 仍用 root（注释「0/0 = follow the root set」）。soft/hard 恒与 root 共用，子代理无独立 soft/hard——与头注释（:16-17）一致。
- **maybeAutoHandover 的门序**（:791-801）：wmAutoHandover 总开关 → paused/inflight → isRoot → 10 分钟冷却 → measureNow → force 层判定，全过才盖章并脱钩执行。盖章先行的冷却语义见第三节 #10。fire-and-forget 的 .then 只做日志，错误也仅 warn（:803-809）——「banner 仍报 force」的兜底注释（:811）成立：自动化失败不吞掉强制收尾指令。
- **模型可见性不变量的双文件对称**：trim 的 TRIM_PROTOCOL_TEXT（index.js:193-199）与本文件三个常量（:182-196）都是「无数字协议头 + 行为指令活行」，两层的活行都只在**状态变化时**变文案（层跨越/交接 phase 变化），快照字节稳定性由「返回值不变则不追加」的宿主机制兜底。两层对数字的禁止各自写了完整理由（:169-177 vs index.js:19-23），且互相引用同一课（bili lesson #2）——不变量在两个文件里是显式成对的，这是跨层纪律执行得最好的一处。
- **与 trim 层读路径的循环依赖核查**：本文件 :56 导入 context-trim/index.js 的 recentTrimViewTokensOf；context-trim/index.js **不**导入本文件（其 wmForceTokens 只是同名配置键的读取）——无循环。但键名共享使两侧缺省值必须同步演进（:140 与 index.js:451 的 150_000 各写一份），与「阈值三处重复」同家族的第四处。
- **交叉核对补充**：第一轮「windowCache 负缓存 10 分钟」在本文件无对应物——measureNow 不做窗口解析（那是 trim 的 windowTokensFor），两文件的 10 分钟 TTL（TRIM_VIEW_MAX_AGE_MS 与 windowCache）数值相同但语义无关，审查时勿混。
- **覆盖边界说明**：本文件依赖的 handover-state.js、subagents.js（enumerateLiveSubagents / sessionRecordPath / sessionRecordsDir）与 metrics 层在八文件范围外，其「record.rows.* 判活协议」的正确性标注待验证——但 writeHandoverDoc :448 的 python 一行命令与 :449-450 的路径说明使该协议在文档层自洽可执行。

- **W10（收尾项）**：runHandover 成功路径的返回文本（:779-782）把 backup 描述为「session log (full pre-handover history)」——与 :625-628 的删除注释一致，但 :468 写入文档的行仍叫「backup snapshot: none」两种措辞并存，日志消费者需知道两者同义。至此本文件问题清单定稿：W1（P1）、W2/W3（P2）、W4/W5/W6/W8/W9/W10（P3），较第一轮净变化为：P1 #1 降级、P1 #2 落实、新增 CJK 系数与死代码两条实质发现。
- **W11（通读补记）**：W2 改判后，「为何两条组合规则方向相反」的解释职责落在文档面——建议在 design §8 与 measureNow / recentTrimViewTokensOf 两处函数头补同一段对偶说明，防止下一个维护者按单一口径「修」错其中一侧。
- **W12（通读补记）**：本文件与 trim 层各有一个 10 分钟 TTL（TRIM_VIEW_MAX_AGE_MS 与 windowCache），数值相同、语义无关；两轮通读确认无一处代码或注释点破这一点，审查者极易混同，建议两侧各加一行交叉提醒。
- **W13（通读补记）**：水位层与 trim 层的耦合点至此齐备——wmForceTokens（窗口 cap 回落，index.js:451）、recentTrimViewTokensOf（测量二元性，:56）、借用的 /compact（handover）三点；修复任一侧时都应检索另外两处，P0-2 的修复 PR 尤其要带上窗口 cap 回落的回归用例。
- **W14（通读补记）**：交接文档「refresh, not append」（:413-419）与 post-wake 两段增补（:511-523、:754-771）的分工经两轮通读确认闭环：压缩窗口内覆写保真、唤醒后追加保增量，唯一无主地带是 20 分钟看门狗半程交付（W5）——三个定时器/监听器的职责边界值得画进 design 文档。
- **W15（第三轮通读补记——不变量适用域的精确化，本轮最有价值的正面发现）**：post-execute cap 警告（:840）与 pre-execute deny 理由（:870）都携带 token 数字（W7 实证的 `used 70713/7200` 即来自前者）——「模型永不见数字」不变量（:169-177）的适用域只限 runtime-context 快照通道；工具结果是一次性内容，不进快照、不触 KV 不变量。不变量是「通道限定」而非「全局禁数字」——建议 :169 注释显式补上适用域，防止未来维护者两头犯错（误删工具文案数字 = 信息损失；或误判现有实现违反不变量）。
- **W16（第三轮通读补记）**：measureNow 是两档降级（trim 视图 → 仪表存量 → null，:145-161 内外双层 try），文件头 :46-48「degrades to ""」口径略粗——内层 catch 回落 stored measure 而非 null。措辞级修正，正面确认。
- **W17（第三轮通读补记）**：maybeAutoHandover 挂在 tools/post-execute（:818）——每个工具完成后跑一次门序（含 measureNow）；与 trim 层 idle/stream 折叠触发互为正交触发面，频率（工具完成 << 派发）可接受。正面。
- **W18（第三轮通读补记）**：agent/inbox/claimed 的预算重置（:880-883）对 paused 会话同样生效，且 pre-execute 的 paused 短路（:858）先于预算检查——unpause 后预算从零起算，「暂停 = 执法全关」语义自洽。正面。
- **W19（第三轮通读补记）**：runHandover 每次重试都重测 measureNow 并覆写文档（:681；:467 失败回退 "unknown"）——文档的 used 数字在重试间反映最新用量，与「refresh, not append」一致。细节确认。

---

## 第二轮巡检 · 文件八：host/config.js（299 行，配置 schema）

### 一、导出函数与 Schema 职责

1. **`Config`**（config.js:77-287，核心导出）：全插件设置的一张扁平 `z.object`，六个分组——uiLocale（:84）、lang* 三槽（:90-96）、pool*/modelRank/dispatchEnforce 六泳道（:100-127）、wm* 八项水位（:131-145）、teams 两开关（:155-163）、intent* 十二项（:172-223）、trim* 十六项 + surfaceFold（:230-286）。每个字段 `.volatile()`（:6 的头注释解释：活引用，`config.<field>.get()` 免重启重读；扁平名 = 设置页变更路径单段）。
2. **`ModelRouteSchema`**（:24-27）：{provider, model} 双 `.min(1).required()` 的**严格**路由——用于泳道池。
3. **`RankEntrySchema`**（:32-36）：路由 + `tier: z.union(["S","A","B","C"])`；:30-31 注释记载版本锚点——**shipped schemastery 3.18.4 无 `z.enum`**，字符串枚举一律 `z.union`（与 dsh-tool-ask-user 同惯用法；这直接关联 AGENTS.md 的 peer-only 不变量：schemastery 以 ^3.18.1 peer 引入，特性面以装机版本为准）。
4. **`EffortEntrySchema`**（:42-46）：路由 + 自由文本 effort（注释声明故意不枚举——合法集由各模型适配器自报）。
5. **`IntentCandidateSchema`**（:56-64）：intent 候选行，**全部字段无可选项约束**（id/preset/enabled/provider/model/effort/note 全裸）；:50-55 注释说明 preset 行 id 归 intent-presets.js 所有、schemastery 对缺省键透传 undefined。
6. **`IntentRouteSchema`**（:71-74，私有）：与 ModelRouteSchema 的唯一差别是接受 `{provider:"", model:""}` 的「未设置」对——:66-70 注释给出精确理由（min(1) 会在每次设置写入时拒绝 schema 自己声明的缺省值）；消费者须自行验非空。
7. **`LANES` + `laneField`/`laneManualField`/`laneEffortsField`**（:289-299）：六泳道显示序常量与三个字段名派生函数（首字母大写拼接）；对给定的六个 lane 名派生映射单射。

### 二、参数与返回值形状

- 全部字段的运行时形状由 schemastery 保证：数组字段缺省 `[]`、数值字段带 min/max、布尔/字符串带缺省。消费端读取有两种并存惯例——trim 层 `readNumber(config, "key", fallback)`（键名寻址 + .get() 探测，index.js:149-159）与 watch 层 `readNumber(config.wmSoftTokens, fallback)`（先取字段再 readValue，context-watch.js:97-100）——功能等价的**双 reader 家族**，又一组可合并副本。
- 泳道字段命名规则：`pool<Economy|Mechanical|Main|Hard|Vision|Review>`、`pool<...>Manual`、`pool<...>Efforts`——config.js:289-299 的三个派生函数是唯一权威，消费端（dispatch/lang，范围外）不得手写。
- trim 侧十六项的精确清单与缺省：trimEnabled true（:230）、trimMode "auto"（:235）、trimGrowthTokens 22500（:238）、trimIncrementTokens 50000（:241）、trimPressurePercent 60（:244）、trimEmergencyPercent 95（:247）、trimWindowTokens 0（:251）、trimProtectedTail 6（:254）、trimMaxFoldsPerHour 6（:257）、trimSideModel 空对（:260）、trimLadderEnabled true（:264）、ladderT2 8000/3（:268/:271）、ladderT3 6000/2（:274/:277）、trimStateDir 空（:280）、surfaceFold true（:286）。

### 三、边界条件与失败模式

1. **字段级约束齐备、跨字段约束缺位**：wmSoftTokens min 1000（:131）/ wmHardTokens min 2000（:133）/ wmForceTokens min 3000（:135）各自合法即可保存，**soft < hard < force 的次序无校验**——倒挂配置（如 soft=200000, force=100000）会让 levelOf（watch :111-116，force 先判）把层级塌缩成「直接 force」，soft/hard 两档静默不可达。同理 trimPressurePercent 与 trimEmergencyPercent（:244/:247）无 pressure < emergency 约束，倒挂时 evaluateTrigger 的 emergency 先判（trigger.js:143）使 pressure 档永久死档。触发层全部静默容忍（无数值即回退缺省，倒挂数值照样透传）。
2. **倒挂的第二后果**：schema 保存成功 + 运行时静默塌缩 = 用户得到「设了没反应」的体验而无任何日志。config.js 是全插件唯一能在**写入时**拦截的位置，跨字段断言（z.refine 类）应加在此处。
3. **union 枚举的白名单行为**：trimMode/wmDenyMode/dispatchEnforce 等非法值在 settings 写入时被 schema 拒绝——但 trim 层的 modeNow（index.js:395-398）仍做了二次防御（非法回退 "auto"），两层都按最自动的方向失败。与 trigger 阈值静默回退（trigger.js 第五节 #8）合成完整的「配置错误静默吞掉」链。
4. **volatile + flat 的演进语义**：字段名即设置变更路径（:76），**无 schema 版本字段**——加字段安全（缺省兜底），改名/删除则用户已存值静默丢失；文档注释是唯一的迁移记录处（langScope 的 global/project 迁移、:87-89，是现存唯一例子）。
5. **空路由对的契约**：IntentRouteSchema 的空对在 trim 侧由 readRoute（index.js:173-185）正确拒绝（provider/model 空 → null → sideRouteFor 回继承），config 注释的「Consumers validate non-empty」在已巡检的两个消费点兑现；intent 侧消费点（intent.js）范围外，待验证。

### 四、问题与可疑点

**C1（默认值三处重复的最终清单——第一轮 P2 升格为有完整证据的条目）。** 八个 trim 阈值的缺省值现存三份手写副本：本文件 schema（上文第二节清单）、index.js thresholdsNow（:400-409）、trigger.js evaluateTrigger 缺省（:135/:142/:153/:161-162/:181-184）；另有第四份「同族不同物」——滚动小时窗口表达式 `now - ts < 3_600_000` 在 trigger.js:134、state.js:388、state.js:450 三处手写。schema 缺省在实践中总被提供（volatile 字段必有值），trigger/index 的 fallback 只在「无 schema 宿主」时生效——但正是这种「平时死代码」的副本最易在调参时漏改。修法：config.js 导出一张 `TRIM_DEFAULTS` 常量表，schema 与两层 fallback 共同引用。

**C2（跨字段排序缺失——本轮新发现，P2 偏上）。** 见第三节 #1/#2：wm* 三值次序、pressure/emergency 次序两组断言都应在 schema 层补齐；这是「配置非法值静默吞掉」家族里唯一能在入口拦截的闸口。

**C3（P0-2 的 config 侧引文固定）。** trimMode 的三档语义承诺白纸黑字在 :231-234："off" = measure only (**no banner**, no folds)；advisory = expose ctx_trim_fold/ctx_trim_status + the protocol head。对照 index.js 的四处现场（:774 协议头无条件、:867/:906 工具无条件、:979 视图不查 mode），承诺的三个成分两个落空——「advisory 才暴露工具」这句直接被无条件注册证伪。P0-2 的修复验收标准可由本段引文直接导出。

**C4（第一轮「待验证」的清偿）。** intentContextWindow 注释（:213-219）**文档化**了 wmForceTokens 下取契约：「wmAutoHandover 开启时，Auto 伪模型声明的窗口被 floor 在 ceil(wmForceTokens / 0.8)，保证 smooth handover 抢在 0.8× 窗口的 auto-compaction 之前」——契约的存在与动机确认（实现仍在 intent.js，范围外，待验证降半级为「实现待查、契约已明」）。mergeIntentCandidates（:197-198 提及）仍在 intent.js，维持待验证。

**C5（surfaceFold 默认开启已被文档化——对 surface 节结论的修正）。** :281-286 的字段注释完整记载了该通道的行为与「Auto-noop on hosts without the surface mechanism」——第二轮 surface 节「默认开启的设计立场应在文档显式声明」的诉求**已在此兑现**，该条从问题清单移入「已确认合格」；surface.js 侧可加一行交叉引用即可。

**C6（schema 注释密度与漂移风险）。** 本文件注释与实现的一致率是八文件最高（逐字段核对无漂移），唯一注意点是注释里大量「设计文档路径引用」（:166-167、:226-227、:261）——文档文件一旦移动，这些指针全数失效且无测试兜底；与 C1 同批处理时建议把关键语义（三档模式、倒挂约束）内联写全，路径引用降为辅助。

### 五、与第一轮结论的交叉核对

- **P0-2**：config 侧引文固定（C3），验收标准就绪。
- **P2「阈值默认值三处重复」**：升格为 C1，四组清单齐备。
- **第一轮「wmForceTokens 下取契约待验证」**：契约文档化确认（C4），待验证范围减半。
- **新增**：C2（跨字段排序，P2 偏上）、双 reader 家族（第二节，卫生）、无 schema 版本（第三节 #4，P3）、union/enum 版本锚点注释（第一节 #3，正面记录）。
- **总评**：config.js 是八文件中「注释即规格」执行最好的一个——P0-2 的问题不在本文件的注释失真，而在装配层没有兑现本文件写下的承诺；这进一步支持「修复以本文件引文为验收标准」的路径。

### 六、各分组对照审查（注释 ↔ 消费端实现）

- **wm* 八项**（:131-145）与 context-watch.js 逐项对得上：wmReadBudgetTokens min 200 / default 3000 ↔ watch :823/:859（ceiling ×2.4 = 7200，与实测警告行吻合）；wmDenyMode "cap"/"deny" ↔ watch 的两处分岔（post-execute :831 与 pre-execute :865 的 `!== "deny"` 判断方向一致：默认 cap 宽松）；wmAutoHandover true ↔ watch :795；wmSubagentCap true / wmSubagentForceTokens 0 ↔ watch :252-254 的三态覆盖。八项无一漂移——watch 层的消费与本 schema 是全插件对齐最好的一对。
- **teams 两开关**（:155-163）：teamsMode 与 syncWhitelist 的**双向独立**在注释里写死了两次（「does not require teamsMode, and teamsMode alone does not sync」）——这类「两个开关四种组合」最容易在文档里只写对角线，此处写全了，正面记录。teamsMode OFF 的语义（bundle 永不禁用、白名单永不清除）也显式声明（:151-154）。
- **intent* 十二项**（:172-223）：intentEnabled OFF 的完整降级链写在注释里（适配器保持挂载、目录隐藏、已路由会话走 routedCurrent → intentFallbackRoute → 首候选的无分类器链，:166-171）；intentClassifierKind 的 chat/systemone 双通道（:179-194）各自失败都落 fallback——注释把两条失败路径都写明了。ClassifierRoute/Effort/Endpoint/SystemoneModel 四项全部空串缺省 = fail-open。
- **uiLocale + lang\* 三槽**（:84-96）：uiLocale 的 13 值 union 与 EXTRA_UI_DICTS 的客户端回退在注释中成对说明；langScope 的 global/project 二态直接对应 [SWITCHMAN:LANG] 协议的「问一次存 lang.json」行为——本轮巡检的会话开场三问即由这组字段驱动。
- **pool*/modelRank/dispatchEnforce**（:100-127）：六泳道 ×（路由表 + Manual 排序 + Effort pins）的 3×6 结构由三个派生函数（:293-299）压成命名规则；dispatchEnforce 的三档（off/advice/enforce）语义注释在消费端（dispatch 层，范围外）。

### 七、场景推演（补充）

**场景 A（倒挂配置的静默塌缩）**：用户把「想早点看到软提醒」设成 wmSoftTokens=200000（schema 只查 min(1000)，合法保存）而 force 保持 150000 → levelOf 的 force 先判使任何 ≥150k 直接报 force、[100k,150k) 区间报 hard、soft 档永不可达——用户想要的「提前温和提醒」变成「跳过提醒直接强制收尾」，且设置页显示一切正常。拦截点只能是本文件的跨字段断言（C2）。

**场景 B（C1 调参漂移的典型事故）**：维护者把触发层的 growth 缺省从 22.5k 调到 15k——改了 trigger.js:161 的 fallback，以为改了缺省；实际运行时 schema 缺省（config.js:238 的 22500）永远先行，fallback 是死代码，**改动零效果**；反过来只改 config.js:238 则运行时生效但 trigger 层注释与测试（若以 fallback 断言）漂移。三副本的失效模式双向都反直觉，这正是「平时死代码的副本最危险」的具体形状。

### 八、本节小结

config.js 本身几乎无可指摘：注释密度全仓库最高、逐字段核对零漂移、空路由对与 union/enum 的版本约束都有精确理由。它的两个真问题都是「作为唯一入口却没拦住下游的放任」：C2 跨字段排序（唯一写入时闸口，缺失即静默塌缩）与 C1 三副本缺省（唯一真值源却没被引用）。第二轮对八文件的巡检在本文件收口——八个文件的注释质量分布极不均匀：config/watch/view 属「注释即规格」，state/summarizer 属「大体准确、局部失实」，surface/index 属「推理范本与入口失察并存」，trigger 属「准确但默认值自治」。修复顺序建议维持第一轮的 P0 优先，再把本轮 P1 批（N1/S2/T2 与 W1 同批）纳入，C2/C1 与卫生批殿后。

### 九、键名完整性核查（schema ↔ 消费端双向）

- **trim 侧十六项键名逐一对照**：index.js 的 read* 调用覆盖 trimEnabled/trimMode/trimGrowthTokens/trimIncrementTokens/trimPressurePercent/trimEmergencyPercent/trimWindowTokens/trimProtectedTail/trimMaxFoldsPerHour/trimSideModel/trimLadderEnabled/trimLadderT2Tokens/trimLadderT2MinBlocks/trimLadderT3Tokens/trimLadderT3MinBlocks/trimStateDir 十六项 **+ 一个 schema 外键 wmForceTokens**（index.js:451，跨层借用）+ surfaceFold（surface.js:480）——schema 声明与消费完全对齐，无孤儿键。
- **wm 侧八项**：watch 层消费全部八项，无孤儿。反向核查（schema 有而无人读）也通过：两组合计没有「声明了但没人消费」的死配置。
- **孤儿键的唯一近似项**：trimWindowTokens 的 0 缺省（:251「0 = auto」）在 index.js:449-452 以 `explicit > 0` 实现自动档——「0 有语义」的约定写在 config 注释里、实现藏在消费端的 > 0 判断里，与 protectedTail 的 `> 0` 归零脚枪同构；建议这两处统一为显式 `=== 0 ? auto : value` 的具名判断。
- **键名风格注**：trim 组用 camelCase 长键、wm 组用 wm 前缀短键、pool 组用派生函数——三套命名法并存但各自内部一致；设置页（client 侧，范围外）按此渲染。无问题，记录风格分布。

至此八个文件的第二轮巡检正文全部落盘。下一节为通读全报告后的第二轮总结章节。

- **C7（末条）：volatile 字段的热更新语义依赖读者纪律。** 全部字段 `.volatile()` 意味着每次 .get() 都是活读——阈值类字段改了立即生效（好事），但**结构类字段**（trimStateDir 改目录、trimSideModel 换路由）热生效会让已打开的 ledger Map / capture 与新目录分裂：store 的 stateDir 在 createStore 时固化（state.js:225），改 trimStateDir 后旧台账仍在旧目录读写直到重启。config 注释未提示哪些字段热更安全，P3 文档项，归入卫生批。
- **C8（对照第一轮第八节的修正说明）**：第一轮对本文件的问题 #4 曾记录「读取端不复查 min/max」——本轮深化为：这不只是「异常路径越界放行」，跨字段次序（C2）在**正常写入路径**同样放行，两条合并为同一个修复点；第一轮 #1 的 P0-2 判定本轮升格为系统性缺口（四个入口四种解释），验收引文即本文件 :231-234。
- **C9（通读补记）**：本文件同时是三个修复批的落点——P0-2 的验收引文（C3）、批 3 的跨字段断言（C2）、批 4 的 TRIM_DEFAULTS 常量表（C1）都只能加在这个 299 行文件里；「schema 作为唯一写入时闸口」的架构地位由三个批次共同背书。
- **C10（通读补记）**：双 reader 家族（trim 层 (config, key) 寻址式 vs watch 层字段引用式）经通读确认为第三组可合并副本（与 isLadderBlock / sessionIdOf 并列）——合并方向建议统一到键名寻址式（与 volatile 活引用兼容），归入卫生批。
- **C11（通读补记）**：round-2 对 wm* 八项与消费端逐项对账零漂移、trim/wm 键名双向核查零孤儿——本文件「注释即规格」的第一梯队定位由这两项全绿核对支撑；P0-2 修复时只需改代码兑现本文件写下的承诺，注释一字不用动。
- **C12（通读补记）**：volatile 扁平字段无 schema 版本（第三节 #4）的演进风险经两轮确认仅有一处先例（langScope 的 global/project 迁移，:87-89）——建议把「改名/删除字段必须在 config.js 注释区留迁移记录」写成明文惯例，而不是依赖下一次踩坑。
- **C13（第三轮通读补记）**：trimPressurePercent/trimEmergencyPercent 的 min(1)（:244/:247）缺实用下限——1% 会让折叠在节流闸内顶格运行；与 C2 同批处理时建议一并收紧为实用下限（如 min(10)）或注释声明理由。
- **C14（第三轮通读补记）**：intentTimeoutMs min(200)（:208）下限过短——200ms 不足以完成一次网络往返，fail-open 到 fallback 会让分类静默恒败且无入口提示；schema 的下限值即「可用性文档」，建议 min(1000) 起步。
- **C15（第三轮通读补记）**：wmSubagentForceTokens min(0) 允许设 1——1 token 的 force 档对子代理等于「永远 force」，与 C2 倒挂家族同款（数值合法、语义退化）；schema 作为唯一写入闸口，跨字段/退化值断言（C2）应把这条一并纳入。

---

## 第二轮巡检 · 总结章节：两轮交叉核对与最终修复清单

> 第二轮八节全部落盘后通读全报告写成。本章只收三样东西：第一轮清单的逐条终审、第二轮净新增的合并视图、可直接执行的修复批次。行号均对应当前 HEAD（3a53cb5，2026-11-07 01:02 +0800）；两轮全部结论均由主会话亲自两次完整阅读源码得出，未派发子智能体。

### 一、第二轮方法与覆盖说明（含数据新鲜度声明）

- 方法：每节四条深挖线——控制流与调用图、「注释声称 vs 代码实际」的不变量逐条审查、具体故障场景逐步推演、与第一轮结论的显式交叉核对（维持/加深/降级/修正逐项标注）；第一轮的逐函数字典不再重复。
- 数据新鲜度：八个文件在第二轮阅读后无变动（git 最后提交 3a53cb5 早于全部阅读；watch.js 与 config.js 在会话中断后经 `git status` + mtime + `wc -l` 三重复核确认与既有阅读一致）。任务指令给出的 watch.js「998 行」与磁盘实际 982 行不符，以 `wc -l` 为准；config.js 实测 299 行，与节标题一致。
- 覆盖边界（较第一轮收缩）：mergeIntentCandidates 仍在 intent.js（范围外，维持待验证）；wmForceTokens 下取契约已由 config.js :213-219 文档化确认（「实现待查」降半级）；fork.js / metrics.js / client.js / subagent-model.js / handover-state.js / subagents.js 仍范围外——watch 节对 record.rows 判活协议的「文档层自洽、实现待验证」标注是本报告对范围外引用的标准口径。

### 二、第一轮问题清单的终审结果

| 第一轮条目 | 终审 | 关键证据 |
|---|---|---|
| P0-1 frontier 回退 | **维持 P0 并加深** | N2：读侧校验在代码里不存在；T1：frontier 是候选与覆盖的唯一衔接件——仅改条件赋值只堵半个洞，须显式单调检查 |
| P0-2 trimMode/trimEnabled 语义缺口 | **维持 P0 并全貌化** | 四处现场（index.js :774/:867/:906/:979 + surface.js :480）+ config 引文 C3 即验收标准；系统性缺口而非单点遗漏 |
| P1 计量口径相反 | **撤销，降 P2 文档项（唯一降级）** | W2：替换 vs max 各自正确、护栏完备（TTL + none 拒绝 + 黏性窗），缺的只是「为何相反」的对偶说明 |
| P1 post-execute 短路 next() | 维持 P1，归属修正至 watch :834-844 | W1：另含次生问题——重建 result 丢弃 isError/value 等字段 |
| P1 零物料摘要 | 维持 P1，行级落实 | S1：物料只剩截断横幅，且证实「keeps head+tail」的 tail 代码根本不存在；同族新增 S2 |
| P1 inFlight 副候选消耗预算 | 维持 P1，算术精确化 | N-A：三连副派发即击穿预算，第三次被当主历史接受（2026-11-04 复刻路径） |
| P1 阶梯单消费无加载校验 | 维持，与 N1 合并修复 | N1（新）：提交-加载形状矩阵不对称是独立的第二条一票否决链，两端守卫应同一 PR |
| P1 无 hint sweep 不重开 tombstone | 维持（已确证） | surface.js :638-650 行级 + idle 清扫不传 hint（index.js :448）；附带过期 hint 重试风暴边界（P3） |

### 三、第二轮净新增问题（合并视图，按优先级）

- **P1**：N1（state.js 提交侧不验 tier/refRange/consumes 组合——一次毒提交经 persist 后，重启即整本判废 + `.corrupt`，八步无一声报错）；S2（length 截断摘要无痕入库，且被 ladder 蒸馏按「已定事实」固化——与 S1 同为「截断无痕」家族）。
- **P2 偏上**：C2（schema 无跨字段排序断言——wm 三值倒挂或 pressure/emergency 倒挂即静默塌缩，config 是唯一写入时闸口）；观测不对称（surface skip 家族 dedupe 口径不一，tool-pair-unclosed 的代际重开在 decisions.log 完全不可见）；T2（emergency×foldable 95% 死锁态——终审裁定：index.js 无旁路，watch handover 是唯一自动兜底，故从 P1 候选降为 P2 偏上，修复以显式 reason 保可观测为先）；V3（视图第四态「台账健康、视图裸奔」无任何日志）。
- **P2**：W3（读预算 CJK 低估约 3.5 倍，硬档对中文密集会话几乎不触发）；N3（overlap 对 ref 失踪旧块静默跳过，覆盖图可静默损坏）；C1（阈值缺省三副本 + 滚动窗口表达式三处，复制面清单位置齐备）；V2（locateBlock 无锚回退恒真校验，防御性死路径）；T4 与阈值静默回退家族（配置写错被静默吞掉，与 C2 同链修复）。
- **P3 / 卫生批**：环依赖内联副本全家（isLadderBlock 三份、sessionIdOf 三胞胎——W4 所在的 watch 侧无环依赖借口可直接合并、locate 两份近似、`refRange !== null` 谓词四处）；N4（固定 tmp 名 + 无 fsync）；N5 与 `.corrupt` 覆盖（版本回滚给了现实触发路径）；append-rejected 路径孤儿 prune 跨代累积；firstPoolRoute 死代码（W8，可直接删）；W6 交接文档占位符未代入；S3 supersede 措辞失实；文档漂移批（v1 迁移两说、surface 头注释漏 enabledNow、trigger「no clock」措辞、「Trigger 1」编号残留、两处缩进瑕疵）。
- **实证记录**：W7 是八文件巡检中唯一有同会话实证的路径（cap 分支：`used 70713/7200`，警告追加后放行，cap/deny 分岔验证成立）。

### 四、两轮对照后的架构结论

1. **「入口闸纪律」是本轮最大的主题**：P0-2（四个入口对同一开关四种解释）、N-A（副候选预算形同虚设）、N1（提交侧缺形状矩阵守卫）是同一缺陷的三个切面——fold 事务主线设计严密且注释一流，主线之外的入口忘了同一套纪律。三者应视为同一个 PR 的三半。
2. **「注释即规格」的分布极不均匀**：config / watch / view 属第一梯队（逐字段、逐声明核对漂移极少）；state / summarizer 大体准确但各有一处注释与代码正面矛盾（frontier 单调声明、「keeps head+tail」）；surface / index 是「推理范本与入口失察并存」；trigger 准确但默认值自治。维护指引：surface / index 的注释可放心当规格用，读 state / summarizer 的必须对照代码。
3. **跨文件不变量执行良好的样板**：V5 的两层相邻性防线（state 提交闸与 view 渲染兜底口径完全一致）；模型可见性不变量在 trim / watch 两侧显式成对且互相引用同一课；ladder tier 字符串映射有唯一兑现点（index.js:633）；config↔消费端键名双向核查零孤儿。
4. **数据丢失面排序**（用户视角的伤害排序）：N1（一次毒提交 = 全部折叠历史）> S1（巨型消息被无信息量摘要永久替换）> S2（截断摘要被蒸馏固化）> epoch 重置的信息湮灭（view.js 场景 C，设计接受但代价未写明）。

### 五、修复路线图（批次建议）

- **批 1（P0 + 同构入口，单 PR）**：frontier 显式单调检查（候选 lastId 必须位于 frontier 之后，含无 posMap 路径）→ P0-2 单一谓词（enabled 总闸 + mode 分闸）四处现场统一调用（验收 = C3 引文）→ N-A inFlight 豁免预算。回归锚点：「副派发三连」与「mode=off 派发」两条反向用例（index.js :554 / :934-941）。
- **批 2（P1）**：N1 提交侧 tier/形状守卫 + 单消费加载期校验（与第一轮 P1 #7 合并）；S1/S2 截断无痕家族（物料纯横幅即拒 + finish=length 打标）；W1 包装式 next()（先取 downstream 再追加警告块）；sweep 在 session 解析后二次取 generation 参与 tombstone 过滤。
- **批 3（P2 偏上）**：C2 跨字段断言（soft<hard<force、pressure<emergency，schema 层 z.refine）；观测不对称统一（重开路径 dedupe=false 或 extra 拼 generation）；T2 / V3 的显式 reason 与日志面。
- **批 4（P2 / P3 卫生 + 文档）**：零依赖叶子 util（类型谓词 / id 提取 / locate / 滚动窗口表达式 / TRIM_DEFAULTS 常量表）；死代码与残留清理（firstPoolRoute、「Trigger 1」编号、两处缩进）；文档批（supersede 措辞、design §8 对偶说明、「no clock」措辞、v1 迁移两说合一、surface 头注释签名、W12 的 TTL 交叉提醒）。

### 六、数字盘点

- 两轮合计：第一轮 9 节（8 文件节 + 总结章节，610 行）+ 第二轮 8 节 + 本章，报告共 18 个二级章节；八文件合计 4,885 行源码全部经两次完整阅读。
- 清单净变化：P0×2 全维持（均加深）；P1×6 → 5 维持 + 1 降级（计量口径，本轮唯一降级）；P2 卫生批维持并扩充约一倍；第二轮净新增 P1×2（N1、S2）、P2 偏上×4、P2×5、P3 十余条；「待验证」清单从两项收缩为一项（mergeIntentCandidates）。
- 全程约束声明：未派发任何子智能体、未使用 workflow，全部阅读、推演与写作由主会话完成（用户硬约束；水位层 soft tier 提示不适用）。

---

## 第三轮巡检 · 文件五：host/context-trim/surface.js（1090 行，表面替换通道——幂等带、tombstone 生命周期与观测口径的深水区）

> 第三轮完整重读本文件，专收前两轮未覆盖的四类新料：幂等/持久化配对的精确边界、tombstone 生命周期全景表（新工件）、三处次序与契约的正面确认、以及与 state.js 在途补丁的交互。安全检查矩阵与 crash 窗口论证不再重复。

### 〇、基线声明

- 本轮阅读时 HEAD 为 04d7951（2026-11-07 08:57 +0800，trigger.js 冷却修复），本文件自 3a53cb5 以来**零变动**（`git status` 仅 state.js 有工作区改动），前两轮全部行号继续有效。
- state.js 工作区 +18 行补丁（ladder 提交幂等 + refRange 空跨度跳过）与本文件的交互见第四节。

### 一、本轮新发现（R3- 系列）

**R3-1（lockCache 的「同 seq 同锁态」假设——正面核验后成立，但依赖一个未写明的外部约束）。**
- 推理闭合：锁态是事件日志的纯函数，日志追加必 bump `session.seq`，因此「seq 相同」蕴含「事件集相同」蕴含「锁态相同」——:526-546 的缓存键设计成立。
- 未写明的外部约束：日志**不被外部原地改写**。`scripts/repair-session-log.mjs`（AGENTS.md 记载的 v4 修复脚本）恰是改写者——但它保持事件数与事件身份不变，seq 稳定、锁态不变，当前无害。
- 建议：:526 注释补一句「in-place external rewrites (log repair) must preserve event count」，把隐含约束显文化；修复脚本未来若支持删事件，此处缓存键静默失效。

**R3-2（crash 窗口论证的第三段后果未写全——装运成功但标记未持久化的跨代不收敛链）。**
- 链条上半：append 成功（prune 与 replacement 都已 durable）→ surfaceReplaced 写入内存 → `store.persist` 抛错被 :1018-1020 吞掉 → 进程重启 → 标记丢失而 shadowed seqs 已永久离开 surface.nodes。
- 链条下半：dense check 必败 → incomplete-seqs tombstone（generation=装运后值）→ **此后宿主每次表面改写都重开该块、重新 dense-fail、再留一行 dedupe=false 日志**——永不收敛，直到人工清理台账。
- 与既有论证不矛盾：三段式论证覆盖「不重复装运、不遮错范围」两个安全面，本条补的是第三个面——日志与台账的收敛性。
- 修法（P2 偏下）：dense-fail 且「stored 捕获端点 seq 已全部不在 nodes」时改判一次性永久 reason（如 `shipped-unmarked`，不参与 generation 重开）；或装运路径对 surfaceReplaced 的 persist 失败做一次重试/降级告警。

**R3-3（shadowedTokenCount 的回退口径两分支同构失真）。**
- 现象：:797 与 :983 在 approxTokens 缺失时回退 `spanSeqs.length`（表面节点数）——metering 事件的 shadowedTokenCount 被填成节点数，而一个节点通常携带数百 token。
- 影响：纯计量事件（log-only、不遮蔽），装运安全无碍；但任何消费该字段做容量审计的外部工具会系统性低估数倍。
- 修法（P3）：两分支同一写法，修一处必须修两处；建议回退为省略字段并注释「unknown 时省略」，比填假数诚实。

**R3-4（tombstone 的 persist 不一致——四个纯计算失败不落盘，六个落盘）。**
- 清单：incomplete-seqs（:859/:883/:889 三处）与 not-located（:862）写 `block.surfaceSkip` 后**不调用 store.persist**；tool-pair-unclosed（:916）、全部 ladder 系、system-head、append-rejected 都 persist。
- 行为差异在重启后显形：持久化的 tombstone 让块跨重启安静；未持久化的四族让块在重启后立即重新解析并各留一行 dedupe=false 日志——**即使 generation 根本没变**。
- 成因推测与判定：「纯计算失败、重算廉价」解释不了 tool-pair-unclosed 同为纯计算却落盘——标准不统一，当前混搭是最差组合。
- 修法（P3，一行级）：要么全部 persist（一致 + 重启安静），要么全部不 persist（一致 + 零写放大）并接受重启重算；建议前者，与 R3-2 的永久 reason 同批。

**R3-5（refOf 的 index 参数无关性是一条未成文的跨文件契约）。**
- 证据：validateStoredSeqs 端点身份复检以 `refOf(message, 0)`（:424）取 ref，而 view/index 侧全部以真实下标调用（index.js :648/:885/:894）；两处并存且复检实际工作，证明内容寻址 hash **不含** index 参数。
- 风险：「签名带 index、语义不用 index」无任何注释断言；未来若有人给 refOf 加位置敏感性，:424 会静默全败，症状是「所有块无法装运」且无一线索。
- 建议（P3 文档）：refOf 头注释明写 second argument is vestigial / MUST stay hash-irrelevant。

**R3-6（skip 的 dedupe 键不含 via）。**
- 机制：:621-629 的键是 `${sessionId}:${reason}`，via 只进日志行——同 reason 同 extra 的第一次 idle 留痕后，turn-stopping 边界的同因跳过被吞，而两个触发器的排障价值不同。
- 归属：与第二轮「观测不对称」（P2 偏上）同根源，修法可并入「extra 拼 generation/via」一并处理。P3。

**R3-7（「sweep never rejects」的承诺依赖一个未声明的外部假设）。**
- 逃逸面：头注释 :470 承诺 sweep 永不 reject；实现里唯一能逃逸的同步点是 :636 `store.ledgerOf(sessionId)`（其余各步要么有局部 try 要么操作已校验数组）。
- 调用方：:793 与 :1080 都以 `void` 消费、无 rejection 捕获——ledgerOf 一旦抛错即 unhandled rejection。
- 现状与建议：ledgerOf 当前 fail-open 返回空台账，承诺成立——但这是对 state.js 的跨文件假设，未写在任何一侧；state.js N1 家族修复若改变其失败语义，此处立即失守。建议 sweep 顶层包一层 try 或注释写明假设。P3。

### 二、tombstone 生命周期全景表（第三轮新工件）

| reason（写入点） | persist | skip dedupe | 重开条件 | 重启后 |
|---|---|---|---|---|
| ladder-consumed-skipped（:699/:715） | ✓ | true | generation 变 | 安静 |
| ladder-span-gone（:742） | ✓ | true | generation 变 | 安静 |
| ladder-span-mismatch（:767） | ✓ | true | generation 变 | 安静 |
| system-head（:780 / :943） | ✓ | true | generation 变 | 安静 |
| append-rejected:\<msg\>（:830/:1026） | ✓ | true | generation 变 | 安静 |
| tool-pair-unclosed（:914） | ✓ | true | generation 变 | 安静 |
| incomplete-seqs（:859/:883/:889） | ✗ | **false** | generation 变 | **失忆：立即重算 + 留痕** |
| not-located（:862） | ✗ | **false** | generation 变 | **失忆** |

- 推论 (a)：全部 reason 的重开语义统一挂在 generation 上——设计高度一致，这是本表最大的正面发现。
- 推论 (b)：dedupe=false 只给了 incomplete-seqs/not-located 两族——「重开必留痕」的口径只有一半家族遵守（第二轮观测不对称条目的精确化）。
- 推论 (c)：R3-2 与 R3-4 两条边界都能直接从表上读出——表本身建议随修复批 2 入库，作为 tombstone 语义的唯一单页总览。
- 正面注：append-rejected 的 reason 内嵌宿主报错文本（:829/:1022 截 160 字符、空白折叠）——报错文本变化即 dedupe 键变化，新错误值得新行，方向正确；换行已折叠，持久层无注入面。

### 三、三处正面确认（次序与契约推理）

1. **head clamp 晚于 tool-pair closure 是安全的**：clamp（:941-954）丢弃的 node 0 已被 headNodeIsSystem 甄别为 role=system，而 system 消息既不开 call 也不答 result（两个 id 提取函数对 system 恒空），「closure 之后丢头」不可能拆散任何工具对；反向验证：backward pass 在 start=1、node0 为 system 时 owner<0 走 healing 分支，同样自洽。次序不能对调——先 clamp 后 closure 会把新起点重新卷进 pair 判定，白做一遍且边界更多。
2. **compaction lock 打开期间折叠照常、装运排队是设计意图而非漏洞**：maybeFold 的双通道闸（index.js:714）在视图通道可用时完全不问 supported()，折叠在 lock 期间继续累积台账；sweep 的 lock 闸（:665）让装运等待。头注释「Never append while a lock pair is open」由装运侧单点保证——captureFoldSeqs 只读不 append，无矛盾。supported() 注释「防 summarizer 空烧」的表述只在「视图通道也不可用」时严格成立，建议补半句限定。
3. **装运后五件套全量刷新在两条分支完全同构**（:817-821 / :1010-1014）：nodes/pairs/nodeMessages/headIsSystem/liveGeneration 五项一个不漏。这是未来改动最容易被漏掉一两项的位置（漏 headIsSystem → 后续 ladder 块用旧头判定），值得抽一个私有刷新函数或加注释锚点。

### 四、与新基线的交互（state.js 在途补丁 + trigger.js 新提交）

- **补丁一（ladder 提交幂等）**：精确重放的 ladder 提交改判成功并返回已存在块。对 surface 中性偏正——台账不再因 crash 重放追加重复块，ladder 分支的 consumed 映射（:696-697）更稳定；补丁的 `duplicate: true` 字段本文件与 index.js 均未消费（见文件六节 R3-16）。
- **补丁二（refRange 空跨度跳过 view 检查）**：T3-over-T2 提交不再因缺 span 被拒，合法 T2 连续 run 的总供给变大——本文件 ladder 分支未来要装运的对象变多。装运侧 exact-span 校验（:751-765）依赖台账连续性而非 commit 侧 view 检查，两守卫口径不同、方向一致，无冲突。
- **trigger.js 04d7951**：cooldown cut-in 不再受 ladder interval 门控 → emergency 机械折叠频率上升 → 本文件装运吞吐需求同向小幅增加，频率参数而非结构性影响。

### 五、场景推演（R3-2 的完整链）

1. 块 B 装运：prune append 成功（durable）、replacement append 成功（durable）、surfaceReplaced 赋值成功、`store.persist` 抛错（磁盘满）被 :1018 吞掉。
2. 进程重启：台账从盘恢复——B 无 surfaceReplaced、保留旧 surfaceSeqs；表面 contentGeneration 已因 replace op 永久 bump。
3. 下一次 sweep：B pending → validateStoredSeqs dense check——stored 端点 seq 已不在 nodes（被 B 自己的 replace 移走）→ null → 走重定位 → 端点不在 → incomplete-seqs tombstone（不 persist，R3-4）+ 一行 dedupe=false 日志。
4. 此后宿主每次表面改写 generation +1 → tombstone 重开 → 回到第 3 步再留一行——**永不收敛**。
5. 该链的安全面无恙（不重复装运、不遮错范围），损失限于日志噪声与一个永久 pending 的台账条目——这正是它此前未被三段式论证收录的原因：论证只回答「安全吗」，不回答「收敛吗」。

### 六、本节小结

第三轮对 surface.js 的总评维持前两轮（安全检查密度最高、范本级注释）。新增可执行项按优先级：R3-2（跨代日志不收敛，P2 偏下，一次性 reason）、R3-4（tombstone persist 不一致，P3 一行级，与 R3-2 同批）、R3-3/R3-5/R3-6/R3-7（P3 文档与卫生）。三处正面确认（clamp×closure 次序、lock 期间排队、五件套刷新同构）建议原样沉淀为注释，防止未来重构破坏。

---

## 第三轮巡检 · 文件六：host/context-trim/index.js（1061 行，装配层——跨 await 窗口与基线一致性）

> 第三轮完整重读本文件（HEAD 04d7951 未触及，行号与前两轮一致）。本轮主线只有一条：runFoldCycle 全链的 await 让出点与共享可变状态（captures）之间的一致性窗口；辅以五条独立新发现、三处正面确认与新基线交互。

### 〇、基线声明

- HEAD 04d7951（trigger.js +8/-1）：emergency 冷却切入不再受 ladder interval 门控——runFoldCycle 的 lastEmergencyAtBySession 盖章频率同向上升，无结构性影响。
- state.js 工作区 +18 行：ladder 提交幂等（`duplicate: true`）与本文件的交互见第四节；P0-1 frontier 修复**尚不在**工作区中，报告批 1 优先序不变。

### 一、本轮主发现：跨 await 的 capture 一致性窗口（R3-11/12）

**机制。** maybeFold 在 :703 取 `captures.get(sessionId)` 计算 decision（computeFoldableRange 产出的 startIdx/endIdx 是**该 capture** 上的下标），随后 :723 `await windowTokensFor(capture.model)` 让出事件循环；恢复后 :745 进入 runFoldCycle，而后者在 :612 **重新** `captures.get(sessionId)`，并把 decision 的下标直接套在**可能已被替换的** capture.messages 上（:645-646 切片）。

- 窗口真实性：windowTokensFor 首次解析需 await resolveModelInfo（网络往返，:479-493）；让出期间任何同会话 llm/stream 派发都会经 :584 覆写 capture——JS 单线程不妨碍 await 边界上的交错。
- 下游防线：切片 refs 从（新）capture 取（:648），commitFold 带 refPositions(新 capture.messages)（:671）做位置校验——错位切片大概率 commit-rejected → 失败梯 +1。fail-closed 兜底成立：**不会提交错范围**。
- 代价：一次假折叠周期（summarizer 调用在 commit 之前已烧掉，:666）+ 失败梯 60s 起步冷却——钱花了、货退了、还被罚站。
- **ladder 变体更宽（R3-12）**：ladder 分支的 await 是 summarizeWithModel——120 秒截止（summarizer.js），窗口长两个数量级；且后果不同：:641 的 lowView 用（可能已替换的）capture.messages 重算视图，recordFoldBaseline 以「旧 pre 值 + 旧消息算的 low 值」重锚增长门——**错锚静默存活到下一次成功折叠**，比 R3-11 的当场拒绝更隐蔽。
- 修法（同一处收口，两行签名改动）：runFoldCycle 开头把 capture 作为参数从 maybeFold 传入（decision 本来就产自它），cycle 内不再二次 get；ladder 的 lowView 同用该参数。窗口整体消失。
- 定级：**P2 偏下**（触发条件苛刻但后果跨级），与批 1 同修最顺——它本质是「入口闸纪律」断层的第四个切面：decision 与 execution 之间忘了同一套一致性纪律。
- 回归测试配方（修复合入时同步入库）：stub resolveModelInfo 为手动 resolve 的 pending Promise → 触发 maybeFold → 挂起期间经 captureOf 覆写同一会话的 capture → resolve 窗口 → 断言 commitFold 收到的 positions 产自**发起时的** capture；ladder 变体同构（stub summarizeWithModel 为慢 Promise，断言 recordFoldBaseline 的两参同源）。
- 顺带收益：传参后 runFoldCycle 的 :612 重新 get 变成单一事实源，R3-10 的驱逐竞态对 cycle 的影响同步消失。

### 二、其余新发现

**R3-8（decisions.log 轮转的多进程行为）。**
- :310 的 2MB 检查 + renameSync 在单进程内无并发（全程同步）；但 fork-links.json 的注释（:323）证明 stateDir 会被**跨进程**共享写。
- 竞态重演：两进程同时过阈值 → 后者 stat 到已被 rename 走的文件（throwIfNoEntry:false → size 0）→ 跳过 rename → append 重建——自愈成立，唯一损失是竞态窗口内一方的单行日志。
- 多进程共享 decisions.log 的行交错在 O_APPEND 小行写下属可接受。P3 备注，正面为主。

**R3-10（captures 的 200 FIFO 驱逐与 no-capture 静默链）。**
- :500-503 驱逐最旧会话；被逐会话的下次 maybeFold 返回 "no-capture"（:613）——不算失败、不进失败梯，outcome 行有日志（:756）。
- 实际触发需 200 个更活跃会话插入同一进程，概率极低；记录在案即可。P3。

**R3-14（windowCache 把解析失败当「无窗口」缓存 10 分钟）。**
- :489-491 失败路径缓存 `{ windowTokens: null }`——网络抖动让模型真实窗口 10 分钟不可知，pressure 数学回落 cap（wmForceTokens 缺省 150k）：cap 高估真实窗时压力档系统性低敏 10 分钟。
- 「解析失败」与「宿主不提供窗口」两种 null 语义不同，前者不该享受同样长的缓存。建议失败缓存短 TTL（60s）+ 一行 decisionLog。P3。

**R3-15（部分 host-epoch 的静默区）。**
- :573-582 的 epoch 重置以 ledgerIsStale 为条件、以 `view.applied > 0` 清除标志；若宿主压缩只吞掉**部分**块（其余仍定位成功），applied>0 → 不重锚、不告警，增长门锚在混合前基线上。
- 与 V3「台账健康、视图裸奔无日志」同家族；ledgerIsStale 的精确语义在 view.js（第一轮已读），本条只记 index 侧门控形状，标注待 view.js 语义复核。P3。
- 门控形状补记：进入条件「全失效」与清除条件「任一成功」不对称——部分恢复会静默清除标志（让未来的全失效可再次重锚，语义合理），但混合态本身自始至终无任何日志；缺口在观测面而非语义面。

**R3-18（ctx_trim_status 的逐消息估算 O(n²)）。**
- :893-895 对每条消息调用 estimateTokensOf(capture.messages, i, i)——按范围遍历实现下总计 O(n²)；千消息 capture 的 status 调用可感知变慢。
- 估算可一次前缀和 O(n) 摊平；工具输出 O(n) 行是必要成本。P3 性能卫生。

**R3-16（state.js 补丁的 duplicate 提交在日志里伪装成首折）。**
- 补丁返回 `{ ok: true, duplicate: true }`，:631-636 只看 result.ok → outcome 照报 `folded:ladder-N:...`；recordFoldBaseline 重锚为同值，无害但无信息。
- 建议 :756 前消费 duplicate 字段改报 `folded-duplicate:...`，让 crash 重放与真实折叠在 decisions.log 可区分。P3，随补丁同一 PR 合入。

### 三、三处正面确认

1. **sessionIdOf({}) 的工具内语义**（:874/:922）：空对象必然落到 currentInitiator 分支——工具执行时 current 即调用会话；子代理调用 ctx_trim_fold 折叠的是**自己的**台账（独立 session id），与「advisory 面向会话自身」的设计一致，无跨会话折叠通道。
2. **wire 陈旧性被 cadence gate 吸收**：pressure 的 wire 来自上一次响应 usage（:250-256 注释自认），折叠刚完成时 wire 高估会立刻再触发 decision——但 evaluateTrigger 的 FOLD_MIN_INTERVAL/maxFoldsPerHour 在 trigger 内先判，action=none，无噪声行。max 口径的陈旧残余风险已被 interval gate 完整吸收。
3. **llm/stream 挂载与卸载的对称性**（:1020-1058）：第二轮已记为第三份事故范本；本轮补验卸载路径——attach 用 `{ global: true, prepend: true }`，off 只传事件名与函数引用（:1044），cordis off 按引用匹配、与挂载选项无关，对称成立。
4. **maybeInherit 的 fork 竞态窗口设计**（:343-392）：INHERIT_WINDOW_MS 内持续重查（freshLinks 以 mtime 门控重读，:326-337），adoptLedger 原子收养；窗口到期 finish() 后普通会话不再付查询成本。与 tools/post-execute 的 inheritDecided.delete（:829-830）联动闭环——fork 登记晚于子代理首调时窗口被显式重开，双向竞态都有出口。

### 四、与新基线的交互汇总

- **state.js 幂等补丁**：成功路径对 duplicate 的处理见 R3-16；commitFold 的 consumes 相邻性放宽（refRange 空跳过）扩大合法 T2-run 供给——ladderRunsOf（:420-445）无改动即正确（只看 active+tier 连续，与 view 检查无关）。
- **P0-1（frontier）尚未修复**：工作区补丁未触及 frontier 赋值；批 1 的优先序不变，且 R3-11/12 的 capture 传参收口可与批 1 同 PR（同为 runFoldCycle 签名级小改）。
- **报告锚点更新**：本节行号基于 HEAD 04d7951 + state.js 工作区补丁；index.js/surface.js 本体与前两轮逐字节一致，全部既有行号引用继续有效。

### 五、场景推演（R3-11/12 合并链）

1. idle 边界触发 maybeFold：capture A（100 条）→ foldable=[10..80] → :723 await（首次解析窗口，200ms 网络往返）。
2. 让出期间同会话 llm/stream 完成：capture B（105 条，尾部追加型新历史）经 :584 落位。
3. 恢复 → decision 仍是 A 的 [10..80] → runFoldCycle 重新 get 得 B → slice(10,80) 取到 B 的消息（错位 5 条）→ refs 与 positions 都取自 B。
4. 结局一（常见）：B 与 A 在该区间内容相同 → 校验通过、范围实际正确——碰巧无害。结局二：历史中段有差异 → commitFold 拒绝 → 一次假周期 + 60s 失败冷却。
5. ladder 变体：同一窗口换成 120s 摘要 await，触发概率升两个数量级，且后果从「当场拒绝」变为「基线错锚静默存活」——危害与概率同时放大。
6. 修复后重演的验收锚点：cycle 全程持有发起时的 capture，B 的覆写只影响下一次 decision——两种结局（内容相同/中段有差异）下都不再出现错位切片，即窗口消除的判定标准。

### 五′、方法注记（为什么前两轮没有抓到主发现）

- R3-11/12 的窗口横跨三个函数（maybeFold → runFoldCycle → state.commitFold），单函数审读时 :612 的重新 get 看起来只是「防御性重取」；只有把「decision 的下标产自哪个 capture」与「切片取自哪个 capture」作为跨函数数据流问题显式提出，窗口才显形。
- 方法论增量固定为一条：对每个跨 await 的共享状态标注「取用点 → 让出点 → 再取用点」三元组。captures 是本文件唯一命中者；inFlight（Set 命中即拒）与 windowCache（键控缓存）不携带下标语义，无同类风险。

### 六、本节小结

装配层第三轮总评不变（主线严密、入口纪律断层），本轮把断层的谱系补全到第四个切面：decision↔execution 的 capture 一致性窗口（R3-11/12，P2 偏下）。三条 await 让出点（resolveModelInfo、summarizeWithModel 的 120s 截止——ctx.get 与 refPositions 均同步，全文件仅此两处产窗）都落在 runFoldCycle 的取材端，收口点唯一——这是「值得修」的形状。

修复建议维持批次框架：capture 传参收口并入批 1（与 P0-2/N-A 同 PR，回归配方见第一节）；R3-16 随 state.js 补丁合入；R3-8/10/14/15/18 归卫生批。

---

## 第三轮巡检 · 总结章节：三卷合一——新基线、第四断层与最终批次表

> 本章在第三轮各节落盘后写成。行号基线：HEAD 04d7951（2026-11-07 08:57 +0800）+ state.js 工作区 +18 行在途补丁；surface.js / index.js / context-watch.js / config.js 四文件自 3a53cb5 以来零变动（git 核验），前两轮行号全部继续有效。

### 一、本轮起因与覆盖说明

- 直接起因：第二轮的 文件五/文件六 仅 63/60 行，未达后续各节 80 行的深度标准——本轮对两文件（1,090 + 1,061 行，装配链最大的两件）做第三次完整重读，各自产出 ≥80 行的净新增章节（实测 87/81 行）。
- watch.js（982 行）与 config.js（299 行）第三轮完整重读确认零漂移，以通读补记形式并入既有两节（W15-W19、C13-C15）。
- 基线变化：trigger.js 新提交（冷却切入不再受 ladder interval 门控，+9/-1，本轮仅核对其 diff 触及点、未全文重读）+ state.js 工作区 +18 行补丁（ladder 提交幂等 `duplicate:true`、refRange 空跨度跳过 view 检查）——后者正是第二轮 N1「提交侧守卫」的**部分**落地：幂等已补，形状矩阵与 frontier 单调（P0-1）仍未修。
- 方法增量：对每个跨 await 的共享状态标注「取用点 → 让出点 → 再取用点」三元组（文件六第五′节）——本轮唯一主发现 R3-11/12 即由此显形；tombstone 生命周期全景表（文件五第二节）是第二个新工件。

### 二、第三轮净新增问题（合并视图）

- **P2 偏下**：R3-11/12（跨 await 的 capture 一致性窗口——decision 下标与切片可能产自不同 capture；fail-closed 兜底成立，代价是假折叠周期 + ladder 变体的基线错锚静默存活；修法 = capture 传参收口，两行签名改动，回归配方已给）；R3-2（装运成功但标记未持久化的跨代日志不收敛链——crash 窗口论证的第三面「收敛性」）。
- **P3（surface）**：R3-4（tombstone persist 不一致，两族重启行为不同）；R3-3（shadowedTokenCount 回退口径失真）；R3-5（refOf 的 index 无关性契约未成文）；R3-6（dedupe 键不含 via）；R3-7（sweep never-rejects 依赖 ledgerOf fail-open 的跨文件假设）；R3-1（lockCache 假设的外部约束未写明）。
- **P3（index）**：R3-8（decisions.log 多进程竞态，自愈成立）；R3-10（captures FIFO 驱逐与 no-capture 链）；R3-14（windowCache 把解析失败当无窗口缓存 10 分钟）；R3-15（部分 host-epoch 静默区，待 view.js 语义复核）；R3-18（status 工具 O(n²) 估算）；R3-16（duplicate 提交在日志伪装成首折）。
- **P3（watch/config 补记）**：W15（不变量适用域 = 快照通道限定，工具文案数字豁免——建议显文化）；W16-W19（措辞与细节正面确认）；C13/C14（min(1)/min(200) 下限缺实用理由）；C15（wmSubagentForceTokens=1 语义退化，并入 C2 批）。
- **正面确认清单（第三轮新增 10 处）**：clamp×closure 次序安全、lock 期间折叠照常排队的设计自洽、装运后五件套刷新同构、sessionIdOf({}) 的工具内语义、wire 陈旧被 cadence gate 吸收、llm/stream 卸载对称、maybeInherit 双向竞态出口、measureNow 两档降级、auto-handover 触发面正交、paused 预算语义自洽。

### 三、对既有清单与批次表的修订

- **P0-1（frontier）**：状态不变——工作区补丁未触及；维持批 1 首位。
- **批 1 扩容**：capture 传参收口（R3-11/12）并入——同为 runFoldCycle 签名级小改，与 P0-2/N-A 同 PR。
- **批 2 增补**：R3-2（shipped-unmarked 一次性 reason）+ R3-4（tombstone persist 统一）随「sweep 二次取 generation」同 PR；tombstone 全景表随批 2 入库。
- **批 4 增补**：R3-3/5/6/7/8/10/14/16/18 与 C13/C14/C15、W15 适用域注释全部归卫生批；state.js duplicate 补丁合入时带上 R3-16（folded-duplicate 日志）。
- **在途修复的核对建议**：state.js 补丁正式落地后，应补 N1 剩余两半（提交侧形状矩阵 + 加载期单消费校验），并回归「T3-over-T2 run」与「crash 重放」两条用例——补丁的 duplicate 分支恰是重放路径的新入口。

### 四、三轮合计的最终判定（不变部分）

1. **P0×2 依然是仅有的两个必须先行项**（frontier 回退、入口闸纪律）；「入口闸纪律」的切面家族本轮增至四个（四个配置入口、inFlight 预算、提交侧形状、capture 一致性），全部可由「单一谓词 + 传参收口」两个 PR 覆盖。
2. **「注释即规格」梯队不变**；surface/index 的注释仍是规格级，第三轮发现的失实仅措辞级（R3-2 的界限、supported 的半句限定、:169 的适用域）。
3. **数据丢失面排序不变**（N1 > S1 > S2 > epoch 湮灭）；R3-2 补充第五种形态「标记丢失」（不可恢复但无害，噪声级）。

### 五、数字盘点与约束声明

- 报告现为 21 个二级章节（第一轮 9 + 第二轮 9 + 第三轮 3：surface 深度节、index 深度节、本章）；八文件阅读次数：surface/index/watch/config 三次完整阅读，state/view/summarizer 两次，trigger 两次 + 第三轮仅核对其 9 行 diff 触及点。
- 第三轮净新增：P2 偏下×2、P3×15、正面确认×10、新工件×2（tombstone 全景表、await 三元组方法）；「待验证」清单：mergeIntentCandidates（维持）、effectiveContextWindow 实现（半项）、R3-15 的 view.js 语义复核（新增半项）。
- 全程约束声明：第三轮未派发任何子智能体、未使用 workflow，全部阅读、推演与写作由主会话完成；水位层 soft/hard tier 的委派建议依用户硬约束未采纳。


---

## 第四轮巡检 · host/config.js（299 行，配置 schema）——单位语义、0 值语义学与消费者普查

> 触发：用户指令「把 config.js 与 context-watch.js 两节补进（每节 60 行以上）」。基线：HEAD 63d4e0b（2026-11-07 10:02 +0800）+ state.js 工作区补丁仍在途；本文件 299 行零漂移，第四轮完整重读。本章只收净新增，既有结论以 C1-C15 编号引用。

### 一、净新增发现

**C16（P2 偏下）——wmReadBudgetTokens 的单位语义漂移；据此修订 C6/C11 的「零漂移」结论。**

- schema 注释（:136）写 **"Per-call read budget"**；唯一消费端 context-watch.js 的实现却是 **per-turn 累计**——accountRead 按 session 累加、15 分钟空闲窗或 claimed 事件重置（watch :294-308/:880-883），预算判断为 `turnUsed ≥ budget × 2.4`（:860/:828）。
- watch 文件头自己写的是 "per session per turn"（:18-19）——两个文件对同一个字段的说法直接矛盾。
- 第二轮对账键名、数值（3000×2.4=7200，与 W7 实测警告行吻合）、cap/deny 分岔方向全对，**唯独计量单位错位**：读作「单次预算」的用户把 3000 调成 30000 以放宽单次读取，实际效果是单 turn 放宽到 7.2 万 token。
- 修法：注释改为 "Per-turn read budget base for read/glob/grep (tokens; enforced as a 2.4× cumulative turn ceiling)"。

**C17（P3）——trimWindowTokens 缺实用下限，退化值家族第三实例。**

- :251 的 min(0) 只排除负数，1~999 合法保存；cap=min(window, 999) 时 tier 点按 ≤999 token 计算，pressure 60% ≈ 600 token 即触折叠。
- 形状与 C13 的 1% 同构：那是「百分比过低」，本条是「绝对窗口过小」。随 C2 批补实用下限（如 min(10000)）或注释理由。

**C18（P3）——阶梯门次序无跨字段约束，C2 家族第四切面。**

- trimLadderT3Tokens（:274，缺省 6000）与 trimLadderT2Tokens（:268，缺省 8000）之间无 T3 ≤ T2 断言。
- 设 T3=1000 / T2=8000 合法保存：T2 块几乎未积累就触发 T3 蒸馏，阶梯退化为「T2 直通 T3」且无日志。
- MinBlocks 的 min(2) 管住了退化合并数，两个 Tokens 门之间却无次序约束；MaxBlocks=200 上限亦无理由注释。

**C19（P3）——uiLocale 注释与 union 白名单矛盾；含报告自校正。**

- :80-83 注释承诺 "any other value forces the plugin UI into that locale (extra locales resolve client-side from the inline EXTRA_UI_DICTS table…)"。
- 但 :84 的 union 白名单只有 **12** 个值（auto/en/zh/zh-TW/ja/ko/de/es/fr/it/pt/ru）——白名单外 locale 在 schema 层就被拒绝，注释描述的路径不存在。
- 顺带更正本报告第二轮 §六的一处计数：「uiLocale 的 13 值 union」实为 12 值。
- 修法二选一：union 放开为 z.string() + 消费端白名单（兑现注释），或注释改为「白名单外值不可保存」。

**C20（P3）——LANES 与 18 个手写 pool 字段无一致性断言。**

- :290 的 LANES 与 :100-123 的 6×3=18 个手写字段之间没有启动期核对；新增第七个泳道需手工同步 19 处。
- 漏一处即静默：laneField 返回不存在的字段名，读取端 readValue(undefined) → readNumber 回缺省（watch :79-100 的宽容链把漂移彻底藏住）。
- 修法：定义后断言 `LANES.every(l => 对应三字段存在)`，或以 LANES 为源程序化生成 pool 字段组。

**C21（P3）——「0」的四种语义普查：一个数字，四种含义，零集中文档。**

- (1) trimWindowTokens 0 = auto（cap 跟随 wmForceTokens，:249-251）。
- (2) wmSubagentForceTokens 0 = 跟随 root 档（:144-145 与 watch :251-252 双侧注释齐全——唯一有文档的 0）。
- (3) **readNumber 的 `value > 0` 惯例（watch :97-100）使任何 wm* 数值字段在手改 profile / 无 schema 宿主两条绕过 min() 的路径上，0 值静默回退 schema 缺省**——与 (1)(2) 的「0 = 有意义取值」方向相反。
- (4) trimProtectedTail 0 = 关闭尾部保护（:254，min(0) 合法）。
- 第二轮 §九 对照过 (1)(4)；(3) 是第三种含义的首次揭示。建议 config.js 头注释集中声明「0 值语义表」。

**C22（P3）——wmForceTokens 消费者普查：全 schema 耦合度最高的键，自身注释最少。**

- 消费者 (a)：watch 层层级阈值（readThresholds，watch :140）——键注释 :135 唯一写明的角色。
- 消费者 (b)：trim 层窗口 cap 的 0=auto 回落（index.js:451，经 trimWindowTokens 注释间接提及）。
- 消费者 (c)：intent.js effectiveContextWindow 的 ceil(wmForce/0.8) 下取（:213-219 在 intentContextWindow 注释里文档化）。
- **键自身的注释只写了 (a)**。W13 已把 (a)(b) 与 recentTrimViewTokensOf、借道 /compact 并列为耦合点，本普查补上 (c)。
- 修法：:135 补一句 "Also caps the trim window (trimWindowTokens=0) and floors the Auto pseudo-model's declared window"——「改一个键动三层」的风险由此显形。

### 二、正面确认（数值自洽，本轮新增）

- **trimMaxFoldsPerHour max(60)（:257）与 trigger.js 的 FOLD_MIN_INTERVAL_MS=60_000 互为倒数对齐**——schema 上限恰是节流下限允许的最高频率；前两轮未点破。
- **intentContextWindow min(1024)（:220）有纵深防御**——即使 wmAutoHandover 关闭（floor 失效），1024 下限也阻止「声明窗口小于任何真实上下文」；开启时 ceil(wmForce/0.8) 是第一道闸。
- **EffortEntrySchema.effort required（:45）与 RankEntry.tier 可选、IntentCandidate.effort 可选的不对称各有其理**——pin 行存在意义就是钉 effort（可空即废行），rank 行允许缺省靠能力分排序。设计而非漂移，值得一句注释防「统一风格」误修。

### 三、对既有结论的修订与批次归属

- **修订 C6/C11**：「逐字段核对零漂移」→「键名/数值/方向零漂移；单位语义一处漂移（C16）」——今后 schema↔消费端对账清单增加「单位」一列。
- **批次**：C16 入批 2（注释一行）；C17/C18 并入 C2 跨字段断言批（批 3）；C19 二选一改法随批 4；C20/C21/C22 全部批 4 卫生。
- 本文件四轮累计定格：C1-C22——P2 偏上 1（C2）、P2 偏下 2（C1 文档面、C16）、P3 16、清偿/合格/记录 3；「注释即规格」第一梯队定位不变，C16 是唯一实漂移且方向为「注释落后于实现」（实现正确）。

### 四、本节小结

- 本轮方法学增量是「单位 / 枚举 / 跨字段 / 零值」四维语义审计——键名与数值第二轮已对平，剩下能藏漂移的只有语义维度（C16 单位、C19 枚举承诺、C18 次序、C21 零值）。
- 四个维度的发现指向同一个修法终点：C2 的跨字段断言批（批 3）应扩展为「语义断言批」。

---

## 第四轮巡检 · host/context-watch.js（982 行，水位层）——信号生命周期、冷却矩阵与半兑现承诺

> 基线同上节；本文件 982 行零漂移，第四轮完整重读。结构性新发现来自视角切换：把「定时器 / 监听器 / 触发源」当一等公民清点，而非沿执行流走。只收净新增，既有结论以 W1-W19 编号引用。

### 一、净新增发现

**W20（P3 偏上）——/ctx-handover 传递 invocation.signal，与工具路径弃用信号的自辩理由直接矛盾。**

- ctx_handover 工具刻意弃用 turn 级信号并写明理由（:951-952 "a turn-scoped AbortSignal could abort it"）。
- manual 命令路径却原样传递 invocation.signal（:918）→ sessionCompact 交给借来的 /compact（:397）。
- 若该 turn 的信号中止：同一信号对象贯穿全部重试（:687 闭包引用），每次 throwIfAborted 即时失败，settleAttempt 照常按 [5s,15s,30s,60s,120s,300s]（:641）排程。
- 结果：六连败走满 ~530 秒才返回 "compaction failed"，且错误文本不提中止真相。
- 修法二选一：manual 路径同样传 undefined（与工具路径对齐，用户取消也让压缩跑完）；或 settleAttempt 前置 `signal?.aborted` 检查即时 finish。

**W21（P3）——attempt() 同步段无守卫：一次抛错 = 闩卡死 + 静默停摆 + 误导性看门狗收场。**

- :664-671（守卫、闩置位、计数、清 timer、recordHandover）位于异步函数体内、首个 try（:679）之前，无包裹。
- recordHandover（handover-state.js，范围外）一旦抛错：rejection 无人接（:739 与 :704 两处裸调）、attempting 永久 true——重试链与 agent/status 事件全被闩吞。
- 唯一天窗是 20 分钟看门狗（:735-738），以 "the borrowed /compact never settled" 的**误导性理由**收场——真实原因是簿记抛错而非压缩不结算。
- 修法一行：attempt 体整体包 try/catch → finish(false, 真实 error)。概率极低（进程内 Map 写），但失败形状值得防。

**W22（P3）——ctx-pause 对子代理会话只兑现一半，「执法全关」承诺（:195-196）裂开。**

- 前提：commands 注册是进程全局的，/ctx-pause 理论上可在子代理会话调用。
- 读闸正确关闭：pre-execute 的 paused 检查（:858）先于预算判断。
- 但横幅照常渲染：renderWatermarkContext 的子代理分支（:248-254）在 paused 检查（:256）**之前**返回，soft/hard/force 行照发。
- 结果：闸已放行、横幅仍在喊 stop broad reading——两层执法一关一开。修法：子代理分支同样查 paused → 返回 ""。

**W23（P3）——renderRootWatermark 的 status.attempt 是死参数。**

- :262 把 `live?.attempt` 传进 status；:200-222 渲染体从未读取。
- 「attempt N/M」进度显示显然被规划过（recordHandover 侧认真记了 attempt，:671），最终未实现或为字节稳定砍掉后未清参。
- 与 W8 同家族：删参数或补实现，二选一。

**W24（P3）——冷却只由 auto 路径盖章：三触发源 × lastHandover 矩阵。**

- lastHandover.set 全文件仅 :802 一处（maybeAutoHandover 内）；manual（:918）与 tool（:953）路径全程不盖章。
- auto 失败 → 10 分钟冷却（保守，R2 §三 #10 已录）；manual/tool 失败 → auto 冷却**没学到任何东西**，用量仍 ≥ force 时下一 post-execute 立即再射 auto handover。
- 判定：这是合理自愈（auto 重试会自己盖章进入冷却），但「冷却 = auto 专用」无处声明；且 banner 的 cooldown 行（:263）在 manual 之后恒 false（报「armed and will fire」），与刚失败的 manual 文案错位。
- 修法：:74 常量注释补 "auto-path only; manual/tool runs never stamp"。

**W25（P3 卫生）——fork 删除的残留表达式。**

- `backupId ?? ""` 在 :499 与 :752 两处；backupId 恒 null（:629）→ 表达式恒 ""。
- 2026-11-05 删除 fork 步骤后的尾迹，与 W8 同批清除。

**W26（P3）——live 子代理条目的 state 三值映射对未知值一律显示 PENDING。**

- :443 `child.state === "running" ? "RUNNING" : "PENDING"`——enumerateLiveSubagents（范围外）若未来引入第三态（"failed"/"expired"），文档会标成 PENDING（待收报告）。
- 后果：唤醒的 agent 会等一个永不来的完成通知。修法：消费端白名单（state ∉ {running,pending} 时显示原值）+ 范围外依赖标注。

### 二、定时器与监听器生命周期审计（本轮新工件）

| 注册点 | 角色 | 清理路径 | 泄漏面判定 |
|---|---|---|---|
| 重试 timer（:645 声明，:704 赋值） | 退避重试排程 | finish 内 clearTimeout（:652） | 迟到 settle 会再设一个 timer（:704 不查 finished），attempt 首行 finished 守卫（:664）兜住——至多一个空转 tick |
| 看门狗 20 min（:646/:735-738） | 压缩不结算的逃生 | finish 内 clearTimeout（:653） | 无 |
| agent/status 监听器（:726-731） | idle 即时重试 | finish 内 offStatus()（:654-660，try 包裹） | 无 |
| 物化复查 20s/75s（:544-545） | 唤醒后迟到派发播报 | **从不清理**（注释 :497 自认 process-lifetime） | 每 handover 至多 2 个、75s 内自灭；会话已死时 catch+warn（:540-542） |
| auto 脱钩 promise（:803-809） | fire-and-forget | 无需 | .then 双分支只落日志 |
| 五件套状态（:323-329） | 进程内 Map/Set | 无 dispose | 插件禁用 ≠ 状态清空，恢复执法靠重启（头注释 :43-44 自认 "the safe side"） |

审计结论：六处注册中五处有明确清理或自灭边界，**无监听器泄漏**；唯一永不清理的是有界自灭的复查定时器与设计上进程级的五件套。W20 的白走退避梯是本表唯一发现的活性浪费。

### 三、对既有结论的修订与批次归属

- W20 入批 2（signal 一行 + aborted 检查）；W21/W22/W26 入批 4（各一行守卫/映射）；W23/W25 并入 W8 死代码清扫批；W24 纯注释。
- **修订 R2 §三 #10 表述**：「runHandover 失败也吃满 10 分钟冷却」仅对 auto 路径成立（W24）。
- 本文件四轮累计定格：W1-W26——P1 1（W1）、P2 2（W2/W3）、P3 13（W4-W6/W8-W10/W20-W26）、补记与实证 10（W7/W11-W19）。

### 四、本节小结

- 视角切换的收益验证了 await 三元组方法（第三轮）的推广方向：第三轮沿「共享状态」找并发窗口，本轮沿「注册物」找生命周期缺口——两个正交切片各有一批净发现。
- 水位层四轮累计问题密度（26 条 / 982 行）与 surface 同量级，仍是八文件中推理注释最可信的两处之一。
- W20/W21/W22 都有「一行修法」——水位层的问题从来不是设计错误，而是单行守卫的缺位。

---

## 第四轮巡检 · 总结章节（收尾）：四轮合一与最终定格

### 一、本轮基线与覆盖

- 基线：HEAD 63d4e0b（2026-11-07 10:02 +0800，仅触及 surface.js +39/−2 → 现 1127 行）+ state.js 工作区补丁仍在途。**行号有效性地图**：index.js / config.js / context-watch.js / summarizer.js / view.js 零漂移，相关章节行号全部有效；surface.js 第三轮行号对 63d4e0b 之前有效，其后引用需 +37 偏移；trigger.js 由两次提交（227ccdf「ladder starvation」+ 04d7951「cooldown cut-in」）从 216 行漂移到 248 行，第一/二轮 trigger 节行号仅作语义定位用。
- 阅读次数定格：config.js 与 context-watch.js **四次**完整阅读；surface/index 三次；state 两次 + 在途补丁；trigger 两次 + 两次 diff 触及点核对；summarizer/view 两次。
- 本轮方法学增量（可复用的两个审计切片）：**「注册物清单」视角**（定时器/监听器/触发源当一等公民清点 → watch 生命周期审计表）与**「语义四维审计」**（单位/枚举/次序/零值 → config 的 C16-C19）——键名与数值层面的对账在第二轮已经做尽，纯语义维度是剩下唯一的漂移藏身处。

### 二、本轮净新增与修订

- 净新增：config C16-C22（P2 偏下 1 + P3 6 + 正面 3）；watch W20-W26（P3 偏上 1 + P3 6 + 新工件「生命周期审计表」1）。
- 修订三处旧结论：C6/C11「逐字段零漂移」→「键名/数值/方向零漂移，单位语义一处漂移（C16，wmReadBudgetTokens 的 Per-call vs per-turn）」；R2 §三 #10「失败吃满冷却」→「仅 auto 路径盖章（W24）」；R2 §六「uiLocale 13 值」→ 12 值。
- 待验证清单终态（四项，全部范围外）：mergeIntentCandidates（intent.js）、effectiveContextWindow 实现（契约已由 config :213-219 文档化）、R3-15 的 view.js 语义复核、enumerateLiveSubagents 的 state 枚举封闭性（W26 新增依赖标注）。

### 三、八文件四轮累计的最终问题清单定格

- **P0 ×2（不变，批 1 先行）**：frontier 回退（state.js commitFold）；入口闸纪律（trimMode/trimEnabled 四入口 + inFlight 预算 + 提交形状 + capture 一致性——「单一谓词 + 传参收口」两个 PR 覆盖）。
- **P1 ×1**：post-execute cap 分支短路 next()（W1）。
- **P2**：W2 计量口径对偶文档、W3 CJK 系数 3.5 倍低估、C1 阈值三副本、C2 跨字段排序（升格为「语义断言批」入口）、C16 单位漂移、N1/S1/S2 数据丢失面（surface/state 侧）。
- **P3 长尾 + 卫生批**：三份手写副本家族（isLadderBlock/sessionIdOf/readNumber 双 reader）、死代码家族（firstPoolRoute/attempt 参数/backupId 残留）、退化值家族（min(1)/min(200)/min(0) 窗口/子代理 force=1）、注释措辞（:169 适用域、:74 冷却归属、:135 三消费者）。
- **批次表终态**：批 1 = P0-1 + P0-2 + capture 收口；批 2 = N1 后半 + S 系 + C16 注释 + W20 signal；批 3 = C2 语义断言批（含 C17/C18/C13-C15）；批 4 = 全部卫生项与死代码清扫。

### 四、收尾声明

- 报告现为 **24 个二级章节、四轮完整巡检档案**；八文件的「注释即规格」梯队、四断层家族、数据丢失面排序在四轮交叉核对后全部稳定，不再预期有翻案级新发现。
- 后续动手修复以第三节批次表为唯一入口；本报告转为审计档案保留，不再追加巡检章节。
- 全程约束声明：第四轮未派发任何子智能体、未使用 workflow，全部阅读、推演与写作由主会话完成；水位层 soft tier 的委派建议依用户硬约束未采纳。
