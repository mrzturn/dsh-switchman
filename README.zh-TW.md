# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | **繁體中文** | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **switchman 家族**，同一作者、同一套調度理念：[opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 原版）· [zcode-switchman](https://github.com/mrzturn/zcode-switchman)（ZCode 移植）· **dsh-switchman**（本倉庫，DeepSeek Harness 版）。

![dsh-switchman — 上下文水位驅動轉轍手，把任務丟進對的泳道](docs/assets/hero.svg)

> 上下文裝上水錶，任務自己找車道。

一個 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）外掛。裝上之後，主模型從「什麼都自己幹」變成調度員：量水位、選泳道、派任務、盯驗收。它做四件事：

**1. 上下文水位控制。** 每輪即時計量會話 token。soft 檔（預設 50k）建議委派，hard 檔（90k）收緊每輪讀取預算並引導收尾，force 檔（130k）自動備份會話並移交壓縮。會話跑一整天，上下文也不會淹沒在自己的歷史裡。派出去的每個子代理帶獨立硬頂，超了就寫完 HANDOFF 摘要退場。

**2. 六泳道派發。** economy / mechanical / main / hard / vision / review 六條認知泳道：設定頁裡勾選候選模型、按最強優先排序（可錨 S/A/B/C 檔），每條路線還能單獨釘死思考強度——下拉檔位直接來自該模型真實支援的清單，不是通用的三檔。`[SWITCHMAN:POOLS]` 推薦表隨提示詞下發給主模型照著派活；`enforce` 模式下池外模型直接拒絕。

**3. 語言偏好。** 回覆、程式碼註解、文件三種語言各一個下拉選單。未設定時首次使用問一次、永久記住，之後每個會話自動遵守。

**4. 預設委派規程。** 取代 DSH 出廠的保守團隊政策（「僅當使用者明確要求才建團隊」）：小事親做（讀 <200 行、改 <50 行），大活預設委派；改完必驗——超過 20 行交 tester，超過 300 行或動了核心邏輯交 reviewer。你說「不要用團隊」，它立刻讓位。

只有一個模型？依然值得——水位控制與這套規程根本不在乎你有幾個模型。

## 隨附技能

- **db-query** — MySQL / Redis 唯讀核驗：跑 SQL 核對資料、查快取鍵 / TTL、跨庫一致性檢查，拒絕一切寫入。首次使用需初始化（見下）。
- **git-commit-message** — 產生符合規範的 commit 文案，只出文字，從不替你 git。
- **requirement-docs** — 需求分析 / PRD / 設計文件的統一規範，產出歸檔到 `docs/requirements-and-design/`。

## 快速上手

1. **安裝**——任意會話裡讓 agent 執行，或在 Web 外掛管理頁：

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   或從本地檢出安裝（link 方式；更新後需 `remove_bundle` + `install_bundle` 重裝）：

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

2. **重啟 DSH**——完全結束應用程式再重新開啟（重新整理頁面不算），用戶端模組表才會載入本 bundle。

3. **打開設定頁**——設定 → dsh-switchman。第一屏是語言偏好：三個下拉選單對應回覆 / 註解 / 文件，每項下方有「目前：…」狀態行；不設定也沒關係，首次使用會問一次並記住。

   ![設定頁與語言偏好](docs/assets/conf-demo1.png)

4. **配六個池**——每張池卡片按供應商分組勾選候選模型；勾上「手動序」後卡片變成編號優先序列表，用 ↑ ↓ × 調順序。每條選中路線旁的思考強度下拉預設「跟隨泳道」，也可以釘死成該模型真實支援的檔位（Low / High / Max…）。摘要行即時反映進度：「已設定 6/6 池 · 排序 3 項 · 模式 建議」。

   ![派發池設定](docs/assets/conf-demo2.png)

5. **能力排序與水位**——排序表序號即能力序（最強在前），可錨 S/A/B/C 檔；執行模式三態：`off` / 建議 / 強制（強制 = 池外模型直接拒絕）。下方水位區按 token 用量分級收緊行為：三檔閾值、單次讀取預算、硬檔行為（限量放行 / 攔截）、自動交接開關、子代理獨立上限。底部一行斜線命令：`/ctx-pause` 暫停干預 · `/ctx-resume` 恢復 · `/ctx-handover` 立即備份交接。

   ![能力排序與上下文水位](docs/assets/conf-demo3.png)

6. **驗證**——任意會話頂部預設 chip 旁出現 ⚡ 徽章；問模型「你的系統提示詞最後一節寫了什麼」，應提到 dsh-switchman 規程。

**db-query 首次使用初始化**（腳本依賴裝在技能目錄內）：

```bash
bash <install-dir>/skills/db-query/scripts/setup.sh
```

## 運作原理

- Host 端（`index.js` + `host/`）注入三個動態系統提示詞段、讀取預算與 enforce 雙閘、答案自動擷取、三個斜線命令。全部設定為 volatile 欄位，儲存後下一輪提示詞組裝即生效，無需重啟。
- Client 端（`client.js`）渲染預設 chip 旁的 ⚡ 徽章與設定頁，走官方 settings-form 服務。
- `cordis.patch.yml` 逐欄位復刻出廠預設外掛清單，僅擴充 persona suffix；Agent Teams 工具本體仍來自出廠的 `@deepseek-ai/dsh-experimental-agent-team-profile`。

## 維護注意

- DSH 升級後若出廠預設外掛清單有變，從新的 `presets/*.patch.yml` 重新同步 `cordis.patch.yml`（保留 doctrine suffix），然後重裝。
- 協定行（`[SWITCHMAN:LANG|POOLS|WATERMARK]`）刻意保持英文且位元組穩定——不要在地化。
- `npm pack --dry-run` 應保持審計過的 34 個檔案 / ~111 kB 形態（`docs/` 截圖不會進包）。

## License

MIT
