# dsh-switchman

[English](./README.md) | **简体中文** | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **switchman 家族**，同一作者、同一套调度理念：[opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 原版）· [zcode-switchman](https://github.com/mrzturn/zcode-switchman)（ZCode 移植）· **dsh-switchman**（本仓库，DeepSeek Harness 版）。

![dsh-switchman — 上下文水位驱动扳道岔，把任务丢进对的泳道](docs/assets/hero.svg)

> 上下文装上水表，任务自己找车道。

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件。装上之后，主模型从「什么都自己干」变成调度员：量水位、选泳道、派任务、盯验收。它做五件事：

**1. 上下文水位控制。** 每轮实时计量会话 token。soft 档（默认 50k）建议委派，hard 档（90k）收紧每轮读取预算并引导收尾，force 档（130k）自动备份会话并移交压缩。长会话跑一整天，上下文也不会被自己的历史撑爆。派出去的每个子智能体带独立硬顶，超了就写完 HANDOFF 摘要退场。交接时，仍在运行的后台子智能体会被快照记录——id、描述、报告收集路径——写进交接文档与续跑指令，压缩后的会话因此收集它们的报告，而不是重复派发。

**2. 六泳道派发。** economy / mechanical / main / hard / vision / review 六条认知泳道：设置页里勾选候选模型、按最强优先排序（可锚 S/A/B/C 档），每条路线还能单独钉死思考强度——下拉档位直接来自该模型真实支持的列表，不是通用的三档。`[SWITCHMAN:POOLS]` 推荐表随提示词下发给主模型照着派活；`enforce` 模式下池外模型直接拒绝。会话的 DSH 设置未授权显式子智能体选择的路线，会在推荐表和设置页同时标 ⚠，并指引你到 DSH 设置（Subagents → model selection）里授权——否则子智能体退回隐式派发。评审独立性锚定在代码**作者**（产出这份 diff 的智能体）的模型上，而非主会话的模型。

**3. 语言偏好。** 回复、代码注释、文档三种语言各一个下拉。未设置时首次使用问一次、永久记住，之后每个会话自动遵守。

**4. 默认委派规程。** 替换 DSH 出厂的保守团队策略（「仅当用户明确要求才建团队」）：小事亲做（读 <200 行、改 <50 行），大活默认委派；改完必验——超过 20 行交 tester，超过 300 行或动了核心逻辑交一个模型不同于代码作者的 reviewer（池里实在给不出时声明 DOWNGRADED）。你说「不要用团队」，它立刻让位。

**5. 图像解锁（`/vision`）。** 纯文本会话模型读不了图——DSH 会在宿主侧闸门拒绝带图发送。Switchman 注册了全局 `/vision` 命令，放行被这道闸拦下的输入框图片，把每张图解析成宿主文件路径后以文本形式重新发出，模型因此可以把读图委派给视觉池模型或 MCP 图像工具：贴上图，再输入 `/vision <问题>` 即可。模型为纯文本时，输入框上方会出现提示 chip（提示用 `/vision`，或先配置视觉池）；普通带图发送被拒时，会自动把草稿改写成 `/vision <原文>` 并重发一次——图片直达视觉池，无需手动重打。视觉池为空时，命令会拒绝执行并给出配置指引。


只有一个模型？也值得装——水位控制和默认委派与多模型无关，单模型长会话同样受益。

## 捆绑技能

- **db-query** — MySQL / Redis 只读核验：跑 SQL 对数、查缓存键 / TTL、跨库一致性检查，拒绝一切写入。首次使用需初始化（见下）。
- **git-commit-message** — 生成规范的 commit 文案，只出文本，从不替你 git。
- **requirement-docs** — 需求分析 / PRD / 设计文档的统一规范，产出归档到 `docs/requirements-and-design/`。

## 快速上手

1. **安装**——任意会话里让 agent 执行，或在 Web 插件管理页：

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   或从本地检出安装（link 方式；更新后需 `remove_bundle` + `install_bundle` 重装）：

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   或在终端用 `dsh` 命令安装——按运行方式选择对应的 profile：

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # 桌面应用
   ```

2. **重启 DSH**——完全退出应用再打开（刷新页面不算），客户端模块表才能识别本 bundle。

3. **打开设置页**——设置 → dsh-switchman。第一屏是语言偏好：先选作用域——全局（本 profile）或按项目（各项目 `.switchman/lang.json`）——再用三个下拉分别设定回复 / 注释 / 文档，每项下方有「当前：…」状态行；不设置也没关系，首次使用会问一次并记住（提问语言跟随 DSH 界面语言）。

   ![设置页与语言偏好](docs/assets/conf-demo1.png)

4. **配六个池**——每张池卡片按供应商分组勾选候选模型；勾上「手动序」后卡片变成编号优先序列表，用 ↑ ↓ × 调顺序。每条选中路线旁的思考强度下拉默认「跟随泳道」，也可以钉死成该模型真实支持的档位（Low / High / Max…）。顶部汇总行实时反映进度：「已配置 6/6 池 · 排名 3 项 · 模式 建议」。已选中但 DSH 设置未授权显式子智能体选择的路线会带 ⚠ 徽标和提示——同样请到 DSH 设置（Subagents → model selection）里授权，否则显式点名这些路线的子智能体会被拒绝并退回隐式派发。

   ![派发池配置](docs/assets/conf-demo2.png)

5. **能力排序与水位**——排序表序号即能力序（最强在前），可锚 S/A/B/C 档；执行模式三态：`off` / 建议 / 强制（强制 = 池外模型直接拒绝）。下方水位区按 token 用量分级收紧行为：三档阈值、单次读取预算、硬档行为（限流放行 / 拦截）、自动交接开关、子智能体独立上限。底部一行斜杠命令：`/ctx-pause` 暂停干预 · `/ctx-resume` 恢复 · `/ctx-handover` 立即备份交接（它会把会话引导到空闲边界并等待压缩重试窗口，结果可能要等几分钟）。

   ![能力排序与上下文水位](docs/assets/conf-demo3.png)

6. **验证**——任意会话头部预设 chip 旁出现 ⚡ 徽标；问模型「你系统提示词最后一段标题是什么」，应提到 dsh-switchman 规程。

**db-query 首次使用初始化**（脚本依赖装在技能目录内，不污染项目）：

```bash
bash <安装目录>/skills/db-query/scripts/setup.sh
```

## 工作原理

- Host 半（`index.js` + `host/`）注入三个动态系统提示词段、读预算与 enforce 双闸、答案自动捕获、四个斜杠命令（ctx 三件套之外，`/vision` 把被拒的贴图解析成宿主文件路径，交给视觉池读取）。全部设置为 volatile 字段，保存后下一轮提示词装配即生效，无需重启。
- Client 半（`client.js`）渲染预设 chip 旁的 ⚡ 徽标与设置页，走官方 settings-form 服务。
- 首页侧边栏新增「Switchman 调度中心」入口，位于技能中心一行旁，单击即以中央面板打开同一设置页（语言偏好、派发池与排序、水位）；原设置段与会话头 ⚡ 徽标保留。
- `cordis.patch.yml` 逐字段复刻出厂预设插件列表，仅扩展 persona suffix；Agent Teams 工具本体仍来自出厂 `@deepseek-ai/dsh-experimental-agent-team-profile`。

## 维护注意

- DSH 升级后若出厂预设插件列表有变，从新的 `presets/*.patch.yml` 重新同步 `cordis.patch.yml`（保留 doctrine suffix），然后重装。
- 协议行（`[SWITCHMAN:LANG|POOLS|WATERMARK]`）刻意保持英文且字节稳定——不要本地化。
- `npm pack --dry-run` 应保持审计过的 43 文件 / ~138 kB 形态（`docs/` 截图不进包）。

## License

MIT
