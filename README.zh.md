# dsh-switchman

[English](./README.md) | **简体中文** | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **switchman 家族**，同一作者、同一套调度理念：[opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 原版）· [zcode-switchman](https://github.com/mrzturn/zcode-switchman)（ZCode 移植）· **dsh-switchman**（本仓库，DeepSeek Harness 版）。

![dsh-switchman — 上下文水位驱动扳道岔，把任务丢进对的车道](docs/assets/hero.svg)

> 上下文装上水表，任务自己找车道。

## 为什么需要它

用 DSH 干活久了有两件烦心事：一是会话越聊越重，上下文被历史撑到几十万 token，模型开始忘事、变慢、变贵，手动 /compact 又丢细节；二是主力模型什么都自己干，查个文件、跑个测试、对个数据都是它在啃，大半活其实该交给便宜模型。

dsh-switchman 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。装上之后，主模型从「亲自干活」变成调度员：量水位、选车道、派任务、盯验收。它不是新模型，是一套挂在 DSH 上的调度规程加一个配置界面，一共做八件事：

**1. 上下文水位：长会话不撑爆。** 每轮实时统计会话 token，三条水位线逐级加码：80k（soft，可调）提醒「该委派了」；120k（hard）收紧单次读取预算、引导收尾；150k（force）自动交接——写交接文档（追加式会话日志本身就是完整备份）、压缩上下文、唤醒续跑，任务不断线。交接那一刻还在跑的后台子智能体也不会丢：id、任务、报告路径都写进交接文档，续跑的会话知道去哪收报告，不会重复派活。每个子智能体自带独立硬顶，到顶写完 HANDOFF 摘要退场。自动干预不合手时可临时接管：`/ctx-pause` 停掉全部水位动作（测量照跑、尾部水位行转成 paused，只是不动手），`/ctx-resume` 随时恢复——重启 DSH 后干预也会自动回来，是临时放手，不是永久关闭；`/ctx-handover` 不等水位到顶，主动发起同一次交接：写交接文档、压缩上下文、唤醒续跑（会话先被引导到空闲边界，结果可能要等几分钟）。

**2. 六个派发池：什么活配什么模型。** 轻量池（批量小活）、机械池（模板化改写）、主力池（日常编码）、高难池（高难推理与大规模重构）、多模态池（看图）、复审池（独立验证）。设置页里勾候选、排优先级、标 S/A/B/C 档，还能给每条路线单独钉思考强度——档位下拉来自该模型真实支持的级别，不是通用三档。主模型每轮提示词里都带着一张 `[SWITCHMAN:POOLS]` 推荐表，照表派活。执行模式三态：关闭 / 建议 / 强制（强制 = 池外模型直接拒绝）。

**3. Agent Teams 模式：从单干到带团队。** 默认关闭，装完就是轻量的 subagent 派发。设置页两个独立开关：

- **智能体团队模式**——打开后注入团队规程（默认委派 + 分级验证 + 共享任务板纪律），并自动启用 DSH 的 Agent Teams：主模型可以拉常驻队友（`spawn_teammate`）、往共享任务板派活（`team_task_*`）、和队友互发消息。什么时候建团队有明确纪律：可并行的独立子任务、量大且自包含、主上下文水位已高、需要角色分离；一次性的单点调查仍走 subagent。再关掉开关，团队条款零残留，也不会撤走正在运行的会话里的团队工具。
- **同步子智能体模型白名单**——DSH 有张「允许 Agent 为子智能体选择模型」的授权白名单：池里选了但没授权的路线，点名派发会被拒（团队模式下会标 ⚠）。打开这个开关，六个池的并集整体写入那张白名单——switchman 做唯一事实源，不用两边重复配置。白名单按「新建会话」快照生效，同步只对之后新开的会话起作用。

会话头部有直观反馈：⚡「自主团队」徽标、◇ 当前会话实际模型；自动交接进行时出现「交接进行中 · 写入交接文档 / 压缩上下文 / 唤醒续接」的实时提示。

**4. 语言偏好：问一次，记一辈子。** 回复、代码注释、文档三种语言各一个下拉，作用域可选全局或按项目（`.switchman/lang.json`）。不设也行——首次用到时用你 DSH 界面的语言问一次，记住后每个会话自动遵守。

**5. 界面语言：插件自己也说你的话。** 设置页顶部的「界面」区里一个「界面语言」下拉（设置键 `uiLocale`）：自动（默认，跟随 DeepSeek Harness 应用语言），或手动选任一内置界面语言——选项一律显示语言原名、不作翻译。它只切换本插件自己的界面（徽标、首页面板、设置页），不动 DSH 应用语言：选中即实时预览、无需重启，保存后记住、下次启动自动恢复，任何失败都回退到应用语言；词典全部内联在插件包里，无需下载。

**6. 分级验证：改完必查。** 超过 20 行的改动交 tester 验证；超过 300 行、或动了核心 / 安全 / 数据一致性逻辑，再交一个 reviewer 独立复审。复审模型锚定「写出这份 diff 的智能体」所用的模型来选，尽量避开；池里实在避不开时，会在结论里声明 DOWNGRADED。你说一句「不要用团队」，它立刻退回单干。

**7. `/vision`：纯文本模型也能处理图。** 主力模型读不了图时，DSH 会在入口直接拒掉带图消息。贴上图、输入 `/vision 这张图错在哪`，图片会被交给多模态池的模型去读，结论回到当前会话。输入框上方会提前提示「当前模型不支持读图」；直接发图被拒时，自动改写成 `/vision` 重发一次，不用手动重来；多模态池没配时命令会拒绝并给出配置指引。

**8. 意图识别自动选模型：消息进来，模型自动落位。** 设置页新增【意图识别】分组：主开关（默认关闭，开启需配置分类器并至少一个候选）、分类器小模型路由（provider + model + 可选 effort，TypeSafe Jev 类决策模型与通用对话模型都支持，输出宽容解析）、分类器类型三选（auto / decision / chat）、独立候选模型列表（每个候选 provider + model + 可选 effort + 一句能力描述）、缓存窗口秒数（默认 300，对齐厂商 prompt cache 约 5 分钟）、切换置信度阈值（默认 80）、分类超时（默认 60000ms）、历史消息条数（默认 6）与字符预算（默认 2400）、可选兜底模型。模型选择器出现「Auto · Switchman」分组下的「Auto」入口（客户端渲染为本地化的「自动（意图识别）」）；选中后每条用户消息先由分类器判定最合适的候选，同一轮锁定决策：置信度不足或仍在缓存窗口内时优先沿用当前模型（缓存续用），置信度足够高或当前模型不在候选里才切换；切换在调用层静默完成，不往会话里插「模型已切换」。输入框上方有状态 chip（自动路由时显示当前路由模型与上次决策置信度），候选与阈值随时回设置页查看。

只有一个模型也值得装——水位控制和分级验证与模型数量无关，单模型长会话同样受益。

## 捆绑技能

- **db-query**——MySQL / Redis 只读核验：跑 SQL 对数、查缓存键 / TTL、跨库一致性检查，拒绝一切写入。首次使用需初始化（见下）。
- **git-commit-message**——生成规范的 commit 文案，只出文本，从不替你 git。
- **requirement-docs**——需求分析 / PRD / 设计文档的统一规范，产出归档到 `docs/requirements-and-design/`。

## 快速上手

1. **安装**——任意会话里让 agent 执行，或在 Web 插件管理页：

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   或从本地检出安装（link 方式；更新后需 `remove_bundle` + `install_bundle` 重装）：

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   或在终端用 `dsh` 命令——按运行方式选对应的 profile：

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # 桌面应用
   ```

2. **重启 DSH**——完全退出应用再打开（刷新页面不算），客户端模块表才能识别本 bundle。

3. **配置**——设置 → dsh-switchman，或首页侧边栏的「Switchman 调度中心」。配置就一页，长这样，从上往下过一遍就配完了：

   ![dsh-switchman 配置页全貌：界面语言、语言偏好、六个派发池、能力排序与执行模式、团队开关、上下文水位与命令](docs/assets/conf-interface.png)

   - **界面**——插件自己的界面语言。图中「自动」即跟随 DSH 应用语言；选具体语言则当场整页切换，保存后记住，随时切回「自动」。
   - **语言**——智能体产出物的语言。作用域图中为「全局（本 profile）」（也可按项目，各自读 `.switchman/lang.json`）；回复 / 代码注释 / 文档三个下拉图中都定在简体中文，每项下方有「当前：…」状态行。全不设也行，首次用到问一次、记住即用。
   - **派发池**——六张卡片两行三列：上排轻量、机械、主力，下排高难、多模态、复审。卡片按供应商分组勾候选模型；勾上「手动序」变成编号优先列表，用 ↑ ↓ × 调顺序；每条路线可钉思考强度（默认「跟随泳道」）。顶部汇总行实时更新，图中即「已配置 4/6 池 · 排名 2 项 · 模式 建议」。
   - **能力排序 + 执行模式**——六池选中模型的并集按能力排序、最强在前（图中 glm-5.3 锚 S 档、glm-5.3-flash 锚 A 档），可调序、可删减；执行模式建议 / 强制（强制 = 池外模型直接拒绝）。
   - **智能体团队**——团队模式与白名单同步两个开关，默认全关；图中为开启状态，开关下方有同步状态行。
   - **上下文水位**——三档阈值（图中 80000 / 120000 / 150000）、单次读取预算（3000）、硬档行为（限流放行 / 拦截）、自动交接开关、子智能体独立上限，都在这区。底部一行命令：`/ctx-pause` 暂停干预 · `/ctx-resume` 恢复 · `/ctx-handover` 立即交接（它会把会话引导到空闲边界再压缩，结果可能要等几分钟）。
   - **意图识别**——主开关、分类器小模型路由、分类器类型（auto / decision / chat）、独立候选列表（每项附一句能力描述）、缓存窗口 / 置信度阈值 / 分类超时 / 历史消息预算、可选兜底模型。开启后模型选择器出现「自动（意图识别）」入口，输入框上方显示当前路由模型与置信度 chip。

4. **验证**——会话头部出现 ⚡「自主团队」徽标（旁边 ◇ 显示当前会话模型）；或者直接问模型「你系统提示词最后一段标题是什么」，答案应提到 dsh-switchman 规程。

**db-query 首次使用初始化**（脚本依赖装在技能目录内，不污染项目）：

```bash
bash <安装目录>/skills/db-query/scripts/setup.sh
```

**分类器选型建议**：若要本地部署决策模型，推荐用 Ollama 运行 `tev1:4b-mxfp8`：分类器类型选「决策端点（systemone）」，端点填 `http://127.0.0.1:11434/v1/systemone`，模型名填 `tev1:4b-mxfp8`。若走 LLM 目录的 chat 分类器，推荐云端小模型，或不带思考（推理）能力的本地小模型——关闭思考可同时压低延迟与分类超时失败率。

## 默认配置

以下为新安装后的全部默认值（权威来源：`host/config.js` 的 zod schema）。

**界面与语言**：`uiLocale` = `auto`（跟随 DSH 应用语言）；`langScope` = `global`；`langConversation/Comments/Docs` = 空（首次对话问一次后记住；注释与文档语言跟随对话语言）。

**派发池**：六条泳道（economy/mechanical/main/hard/vision/review）候选均为空（= 用系统默认模型，不干预）；手动排序与 effort 钉选均为关/空；`dispatchEnforce` = `advice`（建议不强制）。

**上下文水位**：soft `80000` / hard `120000` / force `150000` tokens；单次读取预算 `3000`；超预算行为 `cap`（截断加警告）；`wmAutoHandover` = 开（force 档自动写交接文档+压缩）；子会话硬顶 = 开（共享 150k）。

**Agent Teams**：`teamsMode` = 关；`syncWhitelist` = 关（两者相互独立）。

**意图识别**（默认不可用，需配置分类器 + 至少一个候选 + 打开主开关）：`intentEnabled` = 关（关闭时 Auto 入口隐藏，已选 Auto 的会话走兜底链）；分类器路由未设置；分类器类型 `chat`；候选列表空（预置分类需填模型才参与路由）；缓存窗口 `300` 秒 / 切换置信度 `80` / 分类超时 `60000` ms；历史 `6` 条 / `2400` 字符；`intentContextWindow` = `200000`。

**上下文裁剪**：`trimEnabled` = 开；`trimMode` = `auto`（全自动）；增长闸门 `22500` token + 增量 `50000` token；压力 `60%` / 紧急 `95%`；保护尾部 `6` 条；折叠节奏上限每小时 `6` 次；side model 未设置（继承会话模型）——详见下文「自动上下文裁剪」一节。

**开箱要点**：① 意图识别开箱不可用是有意设计，三步开启（分类器、候选、开关）；② Auto 有效窗口开箱即为 200000——护栏保证 0.8×窗口 ≥ force 档（150000），核心压缩线（160000）永远在平滑交接线（150000）之后；③ 开箱最有感的是水位三件套：80k 提醒委派 / 120k 收敛读取 / 150k 自动交接（写文档+压缩），无需任何设置。

## 自动上下文裁剪

长会话也能保持便宜：已被消化掉的对话区间会被折叠成紧凑的确定性摘要——全自动完成，且不破坏服务商提示词缓存。在空闲边界上，裁剪引擎（`host/context-trim/`）挑出值得折叠的区间，由 side model 写出摘要（仅在紧急压力下才改走无 side model 调用的机械折叠），并把 fold 提交进该会话的折叠状态。此后每个出站请求都从该状态重建——摘要块顶替被折叠的区间，活动尾部原样保留。存储的会话从不被改写，也绝不在流式过程中动手。

自动化层级（`trimMode`）：

- **`off`**——只测量：用量与缓存命中采样照常运行；无横幅、无折叠。
- **`advisory`**——会话模型自己折叠：向其暴露 `ctx_trim_fold` 与 `ctx_trim_status` 工具和协议头。
- **`auto`**（默认）——以上全部，外加空闲边界上的自动折叠，分三档：增长闸门（自上次折叠后的低谷起算的增长 ≥ `trimGrowthTokens`——该锚点保证高位折叠后闸门依然有效——且连续可压缩增量 ≥ `trimIncrementTokens`）、压力档（上下文窗口的 `trimPressurePercent`）、紧急档（`trimEmergencyPercent`——带独立冷却的机械折叠）。

所有键位于 设置 → dsh-switchman；默认值出自 `host/config.js`：

| 键 | 默认值 | 含义 |
| --- | --- | --- |
| `trimEnabled` | `true` | 总开关。关闭后折叠与度量全部停用（监听器退化为纯透传）。 |
| `trimMode` | `auto` | `off` 只测量 / `advisory` 模型自折 / `auto` 系统自动折。 |
| `trimGrowthTokens` | `22500` | 增长闸门：出站 view 自上次 fold 以来增长到该值即触发折叠。 |
| `trimIncrementTokens` | `50000` | 闸门搭档：连续可压缩增量也须达到该规模。 |
| `trimPressurePercent` | `60` | 压力档：view 用量达到上下文窗口该百分比即折叠。 |
| `trimEmergencyPercent` | `95` | 紧急档：到该百分比强制机械折叠（无 side model 调用）。 |
| `trimWindowTokens` | `0` | 窗口上限：压力与紧急档按 min(模型窗口, 上限) 计算。`0` = 跟随 `wmForceTokens`。 |
| `trimProtectedTail` | `6` | 最后 N 条消息永不折叠。 |
| `trimMaxFoldsPerHour` | `6` | 每滚动小时 side model 折叠的节奏上限（紧急档豁免）。 |
| `trimSideModel` | 未设置 | 写摘要的 side model 路由。留空 = 继承会话当前模型。 |
| `trimStateDir` | 未设置 | 折叠状态目录覆盖。留空 = `<dshHome>/.dsh-switchman/state/trim/`。 |
| `surfaceFold` | `true` | 把已提交的 fold 送上会话表面（shadow-price 计量事件 + `surfaceOp` replace 事件对）。关闭则保持仅拼接的 view。 |

**触发路径。** 档位检查在空闲边界上运行；在空闲状态事件不可达的宿主上，兜底改为在每次模型流式完成后也检查一次（每个会话节流为每 60 秒至多评估一次）。每个决策——fold 与 no-op 皆然——都会作为一行 JSON 追加进裁剪状态目录（见 `trimStateDir`）下的 `decisions.log`，为 fold 留下离线审计轨迹。


**宿主压缩纪元。** fold 引用锚定在消息 id 与内容哈希上，因此宿主自身的压缩一旦替换了重发历史，整本账就会同时老化：所有块都无法定位，view 静默回退为原始历史（fail-open——决策日志会记录 `view-applied applied=0`），插件在下一次请求时把增长基线重锚到压缩后的视图。宿主压缩因此是兜底的裁剪层，插件 fold 负责单个宿主纪元内的细粒度工作。 部分派发改用完全冻结的请求数组或选项对象（当前的 agent loop 会深冻结装配好的请求）；对这类派发，`injectView` 会在决策日志里报告结果：`nothing-to-apply`（没有定位到 fold 块——原始历史本身就是 view）、`in-place`/`swapped`（fold view 已随请求发出）或 `none`（fold 存在但冻结的派发带不动它——线上发送原始历史）。**Surface replace 是可用时的发送路径**（`surfaceFold`，默认开启）：在串行的 `agent/turn-stopping` 边界外加一次空闲清扫，插件追加宿主风格的 shadow-price 计量事件和一条携带 `surfaceOp {op:'replace', startSeq, endSeq}` 的 `user/message` 替换事件，`sourceEventSeqs` 覆盖被遮蔽的每个表面节点——与宿主自身压缩用的是同一机制——已提交的 fold 由此从源头直达线上，冻结派发也不例外。当某会话近期派发都记录 `none` 时，插件把 view 当作仅供计量：水位改用服务商上报的计数（force 档与自动交接照常工作），fold 循环暂停、不再空烧 summarizer 调用，裁剪横幅以 `wire=raw`（folds not shipping; watermark reads the tally）标记该行；没有 surface 机制的宿主（或开关关闭时）保持的正是这套旧行为。
**fold 如何保住缓存命中。** 每次 fold 都要为前缀重付一次；目标是摊销成本，不是满分命中率。引擎守住缓存契约：fold 只追加——frontier 只前进，冻结区永不再改；view 由（历史, 折叠状态）确定性重建，因此两次 fold 之间序列化前缀字节不变，服务商缓存持续命中；fold 边界绝不把 assistant 的 tool-call 与其 tool 结果拆开；最后 `trimProtectedTail` 条消息豁免；一切皆 fail-open——内部出错退化为透传，绝不产生坏请求。

**压缩仲裁。** 两个自动裁剪器抢同一份历史会互相重复摘要、互相摧毁 frontier，因此 `cordis.patch.yml` 给宿主的 `dsh-compaction-basic` 行设了 `auto: false`：context-trim 成为唯一语义裁剪器。手动 `/compact` 照常可用，force 档交接（借用的正是这条手动路径）不受影响。溢出恢复改由裁剪承担：超窗的那次尝试失败一次，随后紧急档折好 view，下一次尝试就能装下。

**fork 继承。** 被 fork 的会话（子代理 fork）按 copy-on-fork 继承父会话的折叠状态——但仅当父状态存在且子会话历史确实能解析到父 frontier；否则子会话从干净状态起步。每个子会话只继承一次，跨重启幂等。

**水位读的是 view。** 水位横幅报的是出站 view 的 token 数（折叠后模型真正看到的部分），不再是存储侧计数，重度折叠的会话因此不会再把水位钉死在 hard 档。

## 工作原理

- Host 半（`index.js` + `host/`）注入字节恒定的系统提示词段（语言 / 泳道 / 水位协议 / 团队），实时水位行改走尾部 runtime-context 快照通道（只追加、不改写提示词头部，供应商提示词缓存不受影响）、读预算与 enforce 双闸、四个斜杠命令（ctx 三件套 + `/vision`）。设置保存后下一轮提示词装配即生效，无需重启。
- Client 半（`client.js`）渲染设置页、会话头部的 ⚡ 徽标与 ◇ 模型标识、交接进行中的动态提示；配置快照经 Host 路由家族读写。
- 首页侧边栏的「Switchman 调度中心」入口，单击即以中央面板打开同一配置页；原设置入口保留。
- `cordis.patch.yml` 完整保留出厂预设的插件列表，只在 persona suffix 上做扩展；Agent Teams 工具本体来自出厂 bundle，开启团队模式时自动启用。

## 维护注意

- DSH 升级后若出厂预设插件列表有变，从新的 `presets/*.patch.yml` 重新同步 `cordis.patch.yml`（保留 doctrine suffix 与压缩仲裁——`compaction-basic` 行上的 `auto: false`），然后重装。
- 协议行（`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`）刻意保持英文且字节稳定——不要本地化。
- `npm pack --dry-run` 应保持审计过的 50 文件 / ~205 kB 形态（`docs/` 截图不进包）。
- **零运行时依赖——硬性不变量。** 宿主侧包（`@deepseek-ai/schemastery`、cordis 等）只允许声明为 `peerDependencies`，由运行中的 DSH 用它自己的副本满足。普通 `dependencies` 会被物理安装进 profile 工作区（`<profile>/node_modules/…`），从而对同处 profile 的其他插件遮蔽宿主副本——1.7.0 把 schemastery 声明为普通依赖时，正是这个机制让 dshmarket 插件市场崩溃（一个进程里出现两份 schemastery，市场产生的 schema 与宿主不再同类）。`scripts/validate.mjs` 会在 `dependencies` 再次出现时直接失败；因此安装、升级、卸载 dsh-switchman 都不会再影响 dshmarket 或任何其他社区包在运行时解析到的模块。

## License

MIT
