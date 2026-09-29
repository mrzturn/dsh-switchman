# dsh-switchman

> 一个 bundle，四个模式，全部自带团队。装上 dsh-switchman，DeepSeek Harness 的四个出厂预设（`standard` / `ptc` / `minimal` / `cordis`）就都具备**自主决策是否激活智能体团队（Agent Teams）**的能力——不用再单独安装任何 team 预设。

## 这是什么

DeepSeek Harness 出厂自带的 Agent Teams 工具集（`spawn_teammate` / `team_task_*` / `send_message` / `wait_agent` 等）遵循一条保守策略：**只有用户明确要求时才创建 teammate**。

dsh-switchman 覆盖（override）四个出厂预设的声明，在每个预设的 persona suffix 中注入「自主智能体团队调度规程」：

- 每个任务先做**团队适配判断**（可并行子任务、自包含大子任务、上下文水位、角色分离四个触发条件）；
- 判定适合即由 Lead **自主组建与调度**，无需用户逐次授权；
- teammate prompt 自包含、写作域隔离（`write_scopes` 不重叠）、共享任务板维护依赖、只收结论与引用；
- 边界清晰：用户说「不要用团队」时即时让位；工具目录里没有团队工具时静默回退单人模式；teammate 不越权组建团队。

四个预设的能力差异保持出厂原样：`standard` 全家桶、`ptc` 的编码呈现流、`minimal` 的持久 shell、`cordis` 的组合开发工具——只是每个都默认带上了 team 模式。

## 可见徽标

内置预设的选择器文案由出厂 i18n 硬编码（`presetDisplayText` 对 built-in 预设忽略声明里的 `name`/`description`），所以预选择器里看不到变化是**正常现象**，不代表未生效。为此本插件自带一个客户端徽标：会话头部、紧挨预设名称 chip 的位置会显示「⚡ 自主团队」（英文界面显示 ⚡ Team autonomy，悬停有说明）——这就是「已生效」的一眼标识。

> **客户端模块的发现依赖 `package.json` exports 里的 `"./package.json": "./package.json"`，且这一行不能删。** Host 的 `dsh-client-modules` 扫描用 `resolve('<包名>/package.json')` 探测客户端声明，exports 未暴露该子路径时探测抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`、被静默吞掉，徽标模块就永远进不了页面启动图（服务器 `/plugins` 路由返回 404，控制台无任何报错）。官方 decoration 模板没写这一行，属于模板坑；三个在用的第三方 UI 插件全都显式暴露了它。此外该扫描的「不是客户端包」负判定**缓存到 Host 进程重启**，所以修这类问题后必须完全退出 DSH Desktop（Cmd+Q）再重开，仅刷新页面无效。

## 工作原理

- persona suffix 渲染为系统提示词**最后一段**（`DEPLOYMENT_PERSONA_SUFFIX`，order 10200），晚于团队工具插件自带的保守 `TEAM_POLICY` 段（order 600），因此本规程是会话中实际生效的团队策略。
- Agent Teams 工具本身来自 Host 层出厂 bundle **`@deepseek-ai/dsh-experimental-agent-team-profile`**，它必须保持启用（默认已启用）。本 bundle 只注入规程；若自行挂载团队插件会导致工具双重注册冲突。
- 预设的 `plugins` 列表逐字段复刻自 `@deepseek-ai/dsh-web-app` 的 `presets/*.patch.yml`（dsh 0.1.7-rc.2），仅替换 persona suffix——四个预设通过 YAML 锚点共享同一条规程，改一处即四处生效。

## 安装 / 升级

在任意会话里让 agent 执行，或在 Web UI 的插件管理中安装本仓库目录：

```
plugin_manager: install_bundle  target=/path/to/dsh-switchman
```

安装以 `link:` 方式链接本仓库（请勿移动或删除本仓库目录）。**更新仓库内容后需重装**：对已安装的同路径 bundle 直接 `install_bundle` 会报 `ambiguous-install`，正确顺序是先 `remove_bundle target=dsh-switchman` 再 `install_bundle`。改完 `client.js` 后刷新页面即可加载新模块；但若改了 `package.json` 的 `dsh.client`/`exports`，客户端模块表的判定缓存要 **Host 完全重启**（退出 DSH Desktop 再打开）才刷新。

## 验证

- **最快**：看会话头部预设 chip 旁是否出现「⚡ 自主团队」徽标（模块内容更新后刷新页面即可；刚装好/刚改过 `package.json` 则需先完全重启 DSH Desktop）。
- 行为级：新开会话问模型「你系统提示词的最后一段标题是什么」，正确答案以 `# dsh-switchman 自主智能体团队调度规程` 开头。
- 组合级：

```
node "/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  --profile web --dump-config | grep -c "dsh-switchman 自主智能体团队调度规程"
# 期望输出：4（standard / ptc / minimal / cordis 各一条）
```

## 卸载

```
plugin_manager: remove_bundle  target=dsh-switchman
```

四个预设立即恢复出厂定义。

## 维护注意

- **DSH 升级后**：若新版改动了出厂预设的插件列表，请从新的 `presets/*.patch.yml` 重新同步本仓库 `cordis.patch.yml` 中对应的 `plugins` 列表（保留 persona suffix 注入），然后重装。可用 `node scripts/validate.mjs` 校验与出厂预设的一致性。
- **Web 预设编辑器**：从编辑器保存的修改落在 profile patch 层，优先级高于本 bundle，但会整体替换 `config.plugins`——保存时请保留 doctrine suffix，否则该预设的 team 模式即失效。
- `plugin_manager set_plugin` 对这四个预设行会报告 `overridden`（被本 bundle 覆盖），属预期行为。

## 目录结构

```
├── package.json        # bundle 清单（patch + web 客户端模块声明）
├── cordis.patch.yml    # 四个出厂预设的 override + 共享 doctrine 锚点 + UI 插件行
├── index.js            # Host 半插件（空实现，仅占位）
├── client.js           # Client 半插件：会话头部的「⚡ 自主团队」徽标
└── scripts/validate.mjs# 校验：YAML 语法 + 与出厂预设逐字段一致性
```

## License

MIT
