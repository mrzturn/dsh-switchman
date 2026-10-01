# dsh-switchman

[English](./README.md) | 简体中文

> 一个 bundle，四个预设，全部自带自主团队——外加语言偏好、派发池与模型排序、上下文水位控制，面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

## 这是什么

**dsh-switchman** 为 DSH 四个出厂预设（`standard` / `ptc` / `minimal` / `cordis`）注入：

1. **自主智能体团队规程**——替换出厂的保守团队策略（「仅当用户明确要求才建 teammate」）：Lead 对每个任务按四个触发条件（可并行子任务、自包含大子任务、主上下文水位高、角色分离）自主判断与调度；用户说「不要用团队」时即时让位。
2. **语言偏好**——每轮系统提示词携带 `[SWITCHMAN:LANG]` 协议行，锁定回复、代码注释、文档语言。未配置的项目会收到一次温和询问（`ask_user_question`），答案自动捕获并持久化；捆绑技能跟随同一偏好。
3. **派发池与模型排序**——在 Switchman 设置页为六条认知泳道（economy / mechanical / main / hard / vision / review）配置候选模型，并按最强优先排序。`[SWITCHMAN:POOLS]` 推荐表指导每次委派；可选 `enforce` 模式拒绝池外的 `subagent` 模型指定。内置 179 模型能力快照用于预排序。
4. **上下文水位控制**——`[SWITCHMAN:WATERMARK]` 横幅按 soft/hard/force 三级阈值跟踪实时上下文：soft 建议委派、hard 收紧每轮读预算并引导收尾、force 经 DSH 压缩服务自动备份交接。每个子智能体有独立硬顶与 HANDOFF 收尾块。`/ctx-pause`、`/ctx-resume`、`/ctx-handover` 提供手动控制。

捆绑三个技能：`db-query`（MySQL/Redis 只读核验）、`git-commit-message`、`requirement-docs`。

## 安装

在任意会话让 agent 执行，或在 Web 插件管理页：

```
plugin_manager: install_bundle  target=dsh-switchman
```

或从本地检出安装（link 方式；更新内容后需 `remove_bundle` + `install_bundle` 重装）：

```
plugin_manager: install_bundle  target=/path/to/dsh-switchman
```

**db-query 首次使用需初始化**（脚本依赖装在技能目录内，不污染项目）：

```bash
bash <安装目录>/skills/db-query/scripts/setup.sh
```

任何安装或更新后，请**完全退出并重开 DSH**（不是刷新页面），客户端模块表才能识别本 bundle。

## Switchman 设置页

设置 → **dsh-switchman**（独立分节，中英双语）：

- **语言偏好**——对话 / 注释 / 文档三个语言，附 UI 语言推断的建议值。
- **派发池**——每池候选勾选（来自实时模型目录，含已保存但暂不可用的路由）、排序编辑器（数组序即优先级，可锚定 S/A/B/C 档）、enforce 三态（`off` / `advice` / `enforce`）、设置进度行。
- **上下文水位**——soft/hard/force 阈值（严格递增）、单次读预算、`cap`/`deny` 拦截方式、自动交接开关、子智能体独立上限。

## 工作原理

- Host 半（`index.js` + `host/`）贡献三个动态系统提示词段（order 10300/10400/10500，位于 persona suffix 之后）、读预算与 enforce 的 `tools/pre|post-execute` 双闸、答案自动捕获、三个斜杠命令。全部设置为活引用（volatile）——改动下一次提示词装配即生效，无需重启。
- Client 半（`client.js`）渲染预设 chip 旁的 ⚡ 徽标与设置页，走官方 settings-form 服务（revision 栅栏保存）。
- `cordis.patch.yml` 的预设 override 逐字段复刻出厂插件列表，仅扩展 persona suffix（YAML 锚点四处共享）。Agent Teams 工具本体仍来自出厂 `@deepseek-ai/dsh-experimental-agent-team-profile`。

## 验证

- 任意会话头部预设 chip 旁出现 ⚡ 徽标。
- 问模型「你系统提示词最后一段标题是什么」——应提到 dsh-switchman 规程。
- `[SWITCHMAN:...]` 行的实际效果：语言答案被记住、池推荐影响委派选模、长会话出现水位档位。
- `node scripts/validate.mjs`——patch 一致性、市场面、技能、locale 元数据。

## 维护注意

- **DSH 升级后**若出厂预设插件列表有变，从新的 `presets/*.patch.yml` 重新同步 `cordis.patch.yml`（保留 doctrine suffix），然后重装。
- 模型面协议行（`[SWITCHMAN:LANG|POOLS|WATERMARK]`）刻意保持英文且字节稳定——不要本地化。
- `npm pack --dry-run` 应保持审计过的 32 文件 / ~97 kB 形态（技能 `node_modules` 永不发布）。

## License

MIT
