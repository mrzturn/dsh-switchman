# AGENT.md — dsh-switchman 项目说明

本仓库是 **dsh-switchman**：一个 DSH（DeepSeek Harness）插件。Host 半（`index.js` + `host/*.js`）注入调度规程、语言偏好、派发泳道与水位控制；Client 半（`client.js`）渲染设置页与会话头部徽标；四个出厂预设的补丁在 `cordis.patch.yml`。

## DSH 源码参考（长期有效）

- DSH 源码位于 `/Users/mrzturn/Documents/code/my/GitHub/deepseek-harness`（官方仓库的直接 clone，跟踪上游，可随时本地查阅）。
- **长期授权**：需要时可直接在该目录 `git pull --ff-only`（必要时先 `git fetch`）同步远端最新源码供查阅，无需再向用户逐次确认。
- 源码版本看该仓库 `package.json`；本地安装的 DSH app 版本用
  `/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/DeepSeek Harness.app/Contents/Info.plist"` 查看。
  两者可能不一致：官方 main 通常比装机版本新，对照时注意 API 差异。
- 安装包是 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（打包档案，非目录）。
  里面各插件的 README/文档字符串可用 `strings -a app.asar | grep <关键词>` 检索，作为「装机版本实际行为」的对照源。
- 会话工作目录与 DSH 实现源码路径是两个独立值，不要混用；DSH 自身 checkout 说明以会话系统提示词为准。

## 开发与验证注意

- 预设补丁（cordis.patch.yml）逐字段复刻出厂插件列表：DSH 升级改动了出厂预设后需要重新同步这些列表再重装 bundle。
- 在 Web 预设编辑器保存过改动的 profile，其 patch 层会整体替换 `config.plugins`，可能丢掉本插件注入的 persona suffix。
- plugin_manager 的改动影响整个 profile 的所有会话，且需要 danger-full-access。
- 运行前提：`index.js` 的 inject 硬依赖 `pluginManager` / `sessionQuery`（desktop/web profile 组合都提供；无 profileContext 的 headless 组合缺 pluginManager，届时本 bundle 不 apply）。HMR 事务内 setImmediate 逃不出 AsyncLocalStorage——teams 编排被「nested」拒绝时会挂起重试标志，由下一次干净上下文的 GET 请求（config / vision-state）触发重试。
- 质量规程见 `cordis.patch.yml` 规程第三节：改动 >20 行交 tester 验证；>300 行或核心/安全/数据一致性逻辑交独立 reviewer。

## 零运行时依赖不变量（dshmarket 冲突事故，2026-10）

- **本包永远不得声明普通 `dependencies`。** 宿主平面包（`@deepseek-ai/schemastery`、cordis、dsh-*）一律 `peerDependencies`，运行时由 DSH 自带副本满足（app-boot 的 profile 解析：profile 内 importer 的本地 node_modules 命中优先于宿主解析表 → 普通依赖会被装进 `<profile>/node_modules/@deepseek-ai/` 并对**所有** profile 驻留包遮蔽宿主副本）。
- 1.7.0 曾把 schemastery 声明为普通依赖（lock 里连带 `@deepseek-ai/cosmokit`、`@standard-schema/spec`），安装后 dshmarket 的 schema 改由第二份 schemastery 实例产生，与宿主设置系统/表单管线分叉，插件市场崩溃；市场恢复机制随后长期把本包按在关闭状态（`.dsh-market/log.ndjson`："plugin kept off: dsh-switchman"）。1.7.1 起改为 peer-only（`^3.18.1`，与 dshmarket/dsh-mcp-connector 同一生态约定）。
- `scripts/validate.mjs` 第 6 项检查会在此不变量被破坏时失败；`npm pack` 前先跑它。
- 排查此类冲突看三处：`~/.dsh/profiles/desktop/node_modules/` 下是否出现非本包作用域的空目录（`@deepseek-ai`、`@standard-schema` 等，是 hoist 残骸）；`~/.dsh/profiles/desktop/.dsh-market/log.ndjson`；DSH 源码 `packages/boot/app-boot/src/profile-resolution/resolver.ts` 的 `routeScoped`（本地候选优先级）。
