# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | **繁體中文** | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **switchman 家族**，同一作者、同一套調度理念：[opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 原版）· [zcode-switchman](https://github.com/mrzturn/zcode-switchman)（ZCode 移植）· **dsh-switchman**（本倉庫，DeepSeek Harness 版）。

![dsh-switchman — 上下文水位驅動轉轍，把任務丟進對的車道](docs/assets/hero.svg)

> 上下文裝上水錶，任務自己找車道。

## 為什麼需要它

用 DSH 做事，時間一長會撞上兩件事：

1. **會話越聊越重。** 上下文被歷史撐到幾十萬 token，模型開始忘事、變慢、變貴，最後只能手動 /compact，一壓又丟細節。
2. **主力模型什麼都自己幹。** 查個檔案、跑個測試、對個資料都是它在啃——又慢又燒錢，其中大半其實該交給便宜模型。

dsh-switchman 是一個 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）外掛。裝上之後，主模型從「什麼都自己幹」變成調度員：量水位、選車道、派任務、盯驗收。它不是一個新模型，是一套掛在 DSH 上的調度規程加一個設定介面。具體做六件事：

**1. 上下文水位：長會話不撐爆。** 每輪即時統計會話 token，三條水位線逐級加碼：50k（soft，可調）提醒「該委派了」；90k（hard）收緊單次讀取檔案的預算、引導收尾；130k（force）自動交接——fork 一份會話留底、壓縮上下文、喚醒續跑，任務不斷線。交接那一刻還在跑的背景子智能體也不會丟：id、任務描述、報告路徑都寫進交接文件，續跑的會話知道去哪收報告，而不是重複派活。派出去的每個子智能體自帶獨立硬頂，到頂寫完 HANDOFF 摘要退場。

**2. 六個派發池：什麼活配什麼模型。** 輕量池（economy，批次小活）、機械池（mechanical，模板化改寫）、主力池（main，日常編碼）、高難池（hard，高難推理與大規模重構）、多模態池（vision，看圖）、複審池（review，獨立驗證）。設定頁裡勾候選、排優先順序（可標 S/A/B/C 檔）、給每條路線單獨釘思考強度——檔位下拉來自該模型真實支援的級別，不是通用三檔。主模型每輪提示詞裡都帶著一張 `[SWITCHMAN:POOLS]` 推薦表，照表派活。執行模式三態：關閉 / 建議 / 強制（強制 = 池外模型直接拒絕）。

**3. Agent Teams 模式：從單打獨鬥到帶團隊。** 預設關閉，裝完就是輕量的 subagent 派發。設定頁兩個獨立開關：

- **智能體團隊模式**——打開後注入團隊規程（預設委派 + 分級驗證 + 共享任務板紀律），並自動啟用 DSH 的 Agent Teams：主模型可以拉常駐隊友（`spawn_teammate`）、往共享任務板派活（`team_task_*`）、和隊友互傳訊息（`send_message`）。什麼時候建團隊有明確紀律：可並行的獨立子任務、量大且自包含的活、主上下文水位已高、需要角色分離；一次性的單點調查仍走 subagent。DSH 出廠策略是「使用者不點名就不建團隊」，這裡反轉成「該用就用」。再關掉開關，團隊條款零殘留，也不會撤走正在執行的會話裡的團隊工具。
- **同步子智能體模型白名單**——DSH 有張「允許 Agent 為子智能體選擇模型」的授權白名單：池裡選了但沒授權的路線，主模型點名派發會被拒（團隊模式下，推薦表和設定頁會給這些路線標 ⚠）。打開這個開關，六個池的聯集整體寫入那張白名單——不用兩邊重複設定，switchman 是唯一事實來源，fork 派發路徑也一併納入。白名單按「新增會話」快照生效，同步只對之後新開的會話起作用。

會話標頭有直觀回饋：⚡「自主團隊」徽章、◇ 目前會話實際模型；自動交接進行時會出現「交接進行中 · 備份會話 / 壓縮上下文 / 喚醒續接」的即時提示。

**4. 語言偏好：問一次，記一輩子。** 回覆、程式碼註解、文件三種語言各一個下拉選單，作用域可選全域或按專案（`.switchman/lang.json`）。不設也行——首次用到時用你 DSH 介面的語言問一次，記住後每個會話自動遵守。

**5. 分級驗證：改完必查。** 超過 20 行的改動交 tester 驗證；超過 300 行、或動了核心 / 安全 / 資料一致性邏輯，再交一個 reviewer 獨立複審。複審模型錨定「寫出這份 diff 的智能體」所用的模型來選，儘量避開；池裡實在避不開時，會在結論裡宣告 DOWNGRADED。你說一句「不要用團隊」，它立刻退回單打獨鬥。

**6. `/vision`：純文字模型也能處理圖。** 主力模型讀不了圖時，DSH 會在入口直接拒絕帶圖訊息。貼上圖、輸入 `/vision 這張圖哪裡錯了`，圖片會被解析成檔案路徑交給多模態池的模型去讀，結論回到目前會話。輸入框上方會提前提示「目前模型不支援讀圖」；直接傳圖被拒時，自動改寫成 `/vision` 重送一次，不用手動重來；多模態池沒設定時命令會拒絕並給出設定指引。

只有一個模型？也值得裝——水位控制和分級驗證與模型數量無關，單模型長會話同樣受益。

## 隨附技能

- **db-query**——MySQL / Redis 唯讀核驗：跑 SQL 核對資料、查快取鍵 / TTL、跨庫一致性檢查，拒絕一切寫入。首次使用需初始化（見下）。
- **git-commit-message**——產生符合規範的 commit 文案，只出文字，從不替你 git。
- **requirement-docs**——需求分析 / PRD / 設計文件的統一規範，產出歸檔到 `docs/requirements-and-design/`。

## 快速上手

1. **安裝**——任意會話裡讓 agent 執行，或在 Web 外掛管理頁：

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   或從本地檢出安裝（link 方式；更新後需 `remove_bundle` + `install_bundle` 重裝）：

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   或在終端機用 `dsh` 命令安裝——依執行方式選擇對應的 profile：

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # 桌面應用
   ```

2. **重啟 DSH**——完全結束應用程式再重新開啟（重新整理頁面不算），用戶端模組表才能識別本 bundle。

3. **語言偏好**——設定 → dsh-switchman，或首頁側邊欄的「Switchman 調度中心」。第一屏先選作用域：全域（本 profile）或按專案（各專案 `.switchman/lang.json`）；再用三個下拉選單分別設定回覆 / 註解 / 文件的語言，每項下方有「目前：…」狀態行。跳過也沒關係，首次使用會問一次並記住（提問語言跟隨 DSH 介面語言）。

   ![語言偏好：作用域與三項語言](docs/assets/conf-language.png)

4. **配派發池**——每張池卡片按供應商分組勾選候選模型；勾上「手動序」後卡片變成編號優先序列表，用 ↑ ↓ × 調整順序，每條路線旁還能釘思考強度（預設「跟隨泳道」，釘死後列出該模型真實支援的檔位）。頂部彙總行即時反映進度，比如「已配置 6/6 池 · 排名 2 項 · 模式 建議」。

   ![派發池：輕量 / 機械 / 主力 / 高難四池](docs/assets/conf-pool-1.png)

   多模態池和複審池在下方；再往下是**能力排序**（六池選中模型的聯集，序號即能力序、最強在前，可錨 S/A/B/C 檔）和**執行模式**（建議 / 強制）。

   ![多模態池、複審池與能力排序、執行模式](docs/assets/conf-pool-2.png)

5. **智能體團隊**——兩個開關預設關閉，先用純 subagent 模式跑起來。想讓它自己拉團隊，開「智能體團隊模式」；想省掉兩邊重複授權，開「同步子智能體模型白名單」——開關下方有「已同步 N 條 + 時間」的狀態行，確認寫入結果。

   ![智能體團隊：兩個開關與白名單同步狀態](docs/assets/conf-team.png)

6. **上下文水位**——三檔閾值（預設 50000 / 90000 / 130000）、單次讀取預算、硬檔行為（限流放行 / 攔截）、自動交接開關、子智能體獨立上限，都在這一區。底部一行命令：`/ctx-pause` 暫停干預 · `/ctx-resume` 恢復 · `/ctx-handover` 立即備份交接（它會把會話引導到閒置邊界並等待壓縮重試視窗，結果可能要等幾分鐘）。

   ![上下文水位：閾值、預算與命令](docs/assets/conf-ctx.png)

7. **驗證**——會話標頭出現 ⚡「自主團隊」徽章（旁邊 ◇ 顯示目前會話模型）；或者直接問模型「你系統提示詞最後一段標題是什麼」，應提到 dsh-switchman 規程。

**db-query 首次使用初始化**（腳本依賴裝在技能目錄內，不污染專案）：

```bash
bash <安裝目錄>/skills/db-query/scripts/setup.sh
```

## 運作原理

- Host 端（`index.js` + `host/`）注入動態系統提示詞段（語言 / 泳道 / 水位 / 團隊）、讀取預算與 enforce 雙閘、四個斜線命令（ctx 三件套 + `/vision`）。全部設定儲存後下一輪提示詞組裝即生效，無需重啟。
- Client 端（`client.js`）渲染設定頁、會話標頭的 ⚡ 徽章與 ◇ 模型識別、交接進行中的動態提示，走官方 settings-form 服務。
- 首頁側邊欄的「Switchman 調度中心」入口，點擊即以中央面板開啟同一設定頁（語言偏好、派發池與排序、水位）；原設定入口保留。
- `cordis.patch.yml` 完整保留出廠預設的外掛清單，只在 persona suffix 上做擴充；Agent Teams 工具本體來自出廠 bundle，開啟團隊模式時自動啟用。

## 維護注意

- DSH 升級後若出廠預設外掛清單有變，從新的 `presets/*.patch.yml` 重新同步 `cordis.patch.yml`（保留 doctrine suffix），然後重裝。
- 協定行（`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`）刻意保持英文且位元組穩定——不要在地化。
- `npm pack --dry-run` 應保持審計過的 50 個檔案 / ~205 kB 形態（`docs/` 截圖不會進包）。

## License

MIT
