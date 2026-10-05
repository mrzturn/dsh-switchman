# dsh-switchman 发布清单（release 触发自动发布）

> 状态：**就绪待发**。发布方式与 opencode-switchman 一致：在 GitHub main 分支发 Release，`publish.yml` 自动完成 npm 发布（OIDC 免 token），`release-publish` 环境人工审批后执行。

## 一次性配置（首次发布前手工完成）

1. **npmjs.com Trusted Publisher**：npm 账户 → 包名 `dsh-switchman` → Trusted Publishing，绑定仓库 `mrzturn/dsh-switchman`、workflow `.github/workflows/publish.yml`、environment `release-publish`（与 opencode-switchman 同款 OIDC 方案，无长期 NPM_TOKEN）。
2. **GitHub environment**：仓库 Settings → Environments → 新建 `release-publish`，配 required reviewers（发布审批门）+ deployment branch 规则 `v*`（release 运行携带 refs/tags/*）。
3. workflow 需要 npm >= 11.5.1（已固定 node 24）。

## 已完成的就绪项（2026-10-01，形态数字 2026-10-02 复核）

- [x] 市场面：icon.svg（517B）、locale/{en,zh}.json 展示 meta、exports `./locale/*.json`、`dsh.manifestVersion: 1`、`engines.dsh: >=0.2.0-rc.0`
- [x] 依赖：唯一 dependencies `@deepseek-ai/schemastery@3.18.4`（与宿主同版，零 peer 依赖 → 安装前置检查无拒绝面）
- [x] files 精确枚举：`npm pack --dry-run` = **50 文件 / ~205 kB（2026-10-05 复核） / 零 node_modules**（含 11 语言 README 与 host/ui-locale.js；技能本地依赖经 setup.sh 首用安装；docs/ 截图不进包，CI 有防泄漏断言）
- [x] 脱敏扫描：全仓 grep（凭据模式 / 个人路径 / 内网地址 / Bearer token）仅命中公开 GitHub URL 与本文件所在 docs/ 目录（docs/ 不在 files 内，不随包发布）
- [x] validate.mjs：4 项全绿（patch 与出厂逐字段一致 / 客户端发现面 / 市场面 / 技能完整）
- [x] 双语 README（README.md 英文 + README.zh.md 中文）
- [x] 行为验证：validate + node --check 全量 + Host 侧 33 组 mock 测试 + Client 侧 mini-React 烟雾（三阶段回归）
- [x] 发布流水线 `.github/workflows/publish.yml`：release published 触发 → 仅 main 分支 → tag 与 package.json 版本一致性校验 → `npm ci` → validate → pack 防泄漏 → environment 审批 → `npm publish`（OIDC）

## 发布当日流程

1. 本地确认 `node scripts/validate.mjs` 全绿、`npm pack --dry-run` 保持 50 文件形态（CI 会再跑一遍）。
2. 脱敏复扫（上方 grep 命令，预期仅公开 URL）。
3. 版本号确认：`package.json` 的 version 与即将发布的 Release tag 一致（`v1.3.0` ↔ `1.3.0`，CI 强校验）。
4. 在 GitHub 上基于 main 打 `v*` tag 发 Release → Actions 等待 `release-publish` 环境审批 → 批准后自动 `npm publish`。
5. 发布后冒烟：新 profile `plugin_manager inspect target=dsh-switchman` → `install_bundle` → 完全重启 DSH → 徽标/设置页/`[SWITCHMAN:...]` 行为三连验证。
6. 若上架 dsh-market 等目录站，按其提交规范补充仓库元数据（topics、截图）。

## 已知边界（发布文案可引用）

- 实机端到端（真实 tokenMeter 测量、compaction 协调、命令 UI 呈现）待用户桌面端核验；mock 层已全覆盖。
- DSH 升级若改出厂预设 plugins 列表，需重新同步 cordis.patch.yml（README 维护注意）。
- 协议行（`[SWITCHMAN:*]`）保持英文——捕获锚点字节稳定性依赖。
