# dsh-switchman 发布清单（Phase 5 · 发布就绪，暂不执行发布）

> 状态：**就绪待发**。按用户要求，`npm publish` 明确推迟，等用户明确指令再执行。

## 已完成的就绪项（2026-10-01）

- [x] 市场面：icon.svg（517B）、locale/{en,zh}.json 展示 meta、exports `./locale/*.json`、`dsh.manifestVersion: 1`、`engines.dsh: >=0.2.0-rc.0`
- [x] 依赖：唯一 dependencies `@deepseek-ai/schemastery@3.18.4`（与宿主同版，零 peer 依赖 → 安装前置检查无拒绝面）
- [x] files 精确枚举：`npm pack --dry-run` = **32 文件 / 97.2 kB / 零 node_modules**（技能本地依赖经 setup.sh 首用安装）
- [x] 脱敏扫描：全仓 grep（凭据模式 / 个人路径 / 内网地址 / Bearer token）仅命中公开 GitHub URL 与本文件所在 docs/ 目录（docs/ 不在 files 内，不随包发布）
- [x] validate.mjs：4 项全绿（patch 与出厂逐字段一致 / 客户端发现面 / 市场面 / 技能完整）
- [x] 双语 README（README.md 英文 + README.zh.md 中文）
- [x] 行为验证：validate + node --check 全量 + Host 侧 33 组 mock 测试 + Client 侧 mini-React 烟雾（三阶段回归）

## 发布当日流程（等用户确认后执行）

1. `node scripts/validate.mjs` 全绿 + `npm pack --dry-run` 保持 32 文件形态。
2. 脱敏复扫一遍（上方 grep 命令，预期仅公开 URL）。
3. 版本号确认（当前 1.3.0）→ `npm publish`（首次发布建议先 `npm publish --access public` 如未设 publishConfig）。
4. 发布后冒烟：新 profile `plugin_manager inspect target=dsh-switchman` → `install_bundle` → 完全重启 DSH → 徽标/设置页/`[SWITCHMAN:...]` 行为三连验证。
5. 若上架 dsh-market 等目录站，按其提交规范补充仓库元数据（topics、截图）。

## 已知边界（发布文案可引用）

- 实机端到端（真实 tokenMeter 测量、compaction 协调、命令 UI 呈现）待用户桌面端核验；mock 层已全覆盖。
- DSH 升级若改出厂预设 plugins 列表，需重新同步 cordis.patch.yml（README 维护注意）。
- 协议行（`[SWITCHMAN:*]`）保持英文——捕获锚点字节稳定性依赖。
