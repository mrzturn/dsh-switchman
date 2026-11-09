# dsh-switchman

[English](./README.md) | [简体中文](./README.zh.md) | **繁體中文** | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **switchman 家族**，同一作者、同一套調度理念：[opencode-switchman](https://github.com/mrzturn/opencode-switchman)（OpenCode 原版）· [zcode-switchman](https://github.com/mrzturn/zcode-switchman)（ZCode 移植）· **dsh-switchman**（本儲存庫，DeepSeek Harness 版）。

![dsh-switchman — 上下文水位驅動轉轍器，把任務丟進對的車道](docs/assets/hero.svg)

> 上下文裝上水錶，任務自己找車道。

## 為什麼需要它

用 DSH 幹活久了有兩件煩心事：一是對話越聊越重，上下文被歷史撐到幾十萬 token，模型開始忘事、變慢、變貴，手動 /compact 又丟細節；二是主力模型什麼都自己幹，查個檔案、跑個測試、對個資料都是它在啃，大半活其實該交給便宜模型。

dsh-switchman 是一個 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）外掛。裝上之後，主模型從「親自幹活」變成調度員：量水位、選車道、派任務、盯驗收。它不是新模型，是一套掛在 DSH 上的調度規程加一個設定頁，一共做八件事：

**1. 上下文水位：長對話不撐爆。** 每輪即時統計對話 token，三條水位線逐級加碼：80k（soft，可調）提醒「該委派了」；95k（hard）收緊單次讀取預算、引導收尾；150k（force）自動交接——寫交接文件（附加式對話日誌本身就是完整備份）、壓縮上下文、喚醒續跑，任務不斷線。交接那一刻還在跑的背景子代理也不會丟：id、任務、報告路徑都寫進交接文件，續跑的對話知道去哪收報告，不會重複派工。每個子代理自帶獨立硬上限，到頂寫完 HANDOFF 摘要退場。自動干預不合手時可臨時接管：`/ctx-pause` 停掉全部水位動作（量測照跑、尾部水位線轉成 paused，只是不動手），`/ctx-resume` 隨時恢復——重新啟動 DSH 後干預也會自動回來，是臨時放手，不是永久關閉；`/ctx-handover` 不等水位到頂，主動發起同一次交接：寫交接文件、壓縮上下文、喚醒續跑（對話先被引導到閒置邊界，結果可能要等幾分鐘）。

**2. 六個派發池：什麼活配什麼模型。** 輕量池（批次小活）、機械池（模板化改寫）、主力池（日常編碼）、高難池（高難推理與大規模重構）、多模態池（看圖）、複審池（獨立驗證）。設定頁裡勾候選、排優先順序、標 S/A/B/C 級，還能給每條路線單獨釘選思考強度——強度下拉來自該模型真實支援的級別，不是通用三級。主模型每輪提示詞裡都帶著一張 `[SWITCHMAN:POOLS]` 推薦表，照表派工。執行模式三態：關閉 / 建議 / 強制（強制 = 池外模型直接拒絕）。

**3. Agent Teams 模式：從單幹到帶團隊。** 預設關閉，裝完就是輕量的 subagent 派發。設定頁兩個獨立開關：

- **代理團隊模式**——打開後注入團隊規程（預設委派 + 分級驗證 + 共享任務板紀律），並自動啟用 DSH 的 Agent Teams：主模型可以拉常駐隊友（`spawn_teammate`）、往共享任務板派工（`team_task_*`）、和隊友互傳訊息。什麼時候組團隊有明確紀律：可並行的獨立子任務、量大且自包含、主上下文水位已高、需要角色分離；一次性的單點調查仍走 subagent。再關掉開關，團隊條款零殘留，也不會撤走正在執行的對話裡的團隊工具。
- **同步子代理模型白名單**——DSH 有張「允許 Agent 為子代理選擇模型」的授權白名單：池裡選了但沒授權的路線，點名派發會被拒（團隊模式下會標 ⚠）。打開這個開關，六個池的聯集整體寫入那張白名單——switchman 做唯一事實來源，不用兩邊重複設定。白名單按「新建對話」快照生效，同步只對之後新開的對話起作用。

對話標頭有直觀回饋：⚡「自主團隊」徽章、◇ 目前對話實際模型；自動交接進行時出現「交接進行中 · 寫入交接文件 / 壓縮上下文 / 喚醒續接」的即時提示。

**4. 語言偏好：問一次，記一輩子。** 回覆、程式碼註解、文件三種語言各一個下拉，作用域可選全域或按專案（`.switchman/lang.json`）。不設也行——首次用到時用你 DSH 介面的語言問一次，記住後每個對話自動遵守。

**5. 介面語言：外掛自己也說你的話。** 設定頁頂部的「介面」區裡一個「介面語言」下拉（設定鍵 `uiLocale`）：自動（預設，跟隨 DeepSeek Harness 應用程式語言），或手動選任一內建介面語言——選項一律顯示語言原名、不作翻譯。它只切換本外掛自己的介面（徽章、首頁面板、設定頁），不動 DSH 應用程式語言：選中即即時預覽、無須重新啟動，儲存後記住、下次啟動自動還原，任何失敗都回退到應用程式語言；字典全部內建在外掛包裡，無須下載。

**6. 分級驗證：改完必查。** 超過 20 行的改動交 tester 驗證；超過 300 行、或動了核心 / 安全 / 資料一致性邏輯，再交一個 reviewer 獨立複審。複審模型錨定「寫出這份 diff 的代理」所用的模型來選，盡量避開；池裡實在避不開時，會在結論裡聲明 DOWNGRADED。你說一句「不要用團隊」，它立刻退回單幹。

**7. `/vision`：純文字模型也能處理圖。** 主力模型讀不了圖時，DSH 會在入口直接拒掉帶圖訊息。貼上圖、輸入 `/vision 這張圖錯在哪`，圖片會被交給多模態池的模型去讀，結論回到目前對話。輸入框上方會提前提示「目前模型不支援讀圖」；直接傳圖被拒時，自動改寫成 `/vision` 重送一次，不用手動重來；多模態池沒設時指令會拒絕並給出設定指引。

**8. 意圖識別自動選模型：訊息進來，模型自動落位。** 設定頁新增【意圖識別】分組：主開關（預設關閉，開啟需設定分類器並至少一個候選）、分類器小模型路由（provider + model + 可選 effort，TypeSafe Jev 類決策模型與通用對話模型都支援，輸出寬容解析）、分類器類型三選（auto / decision / chat）、獨立候選模型清單（每個候選 provider + model + 可選 effort + 一句能力描述）、快取視窗秒數（預設 300，對齊廠商 prompt cache 約 5 分鐘）、切換信心閾值（預設 80）、分類逾時（預設 60000ms）、歷史訊息則數（預設 6）與字元預算（預設 2400）、可選備援模型。模型選擇器出現「Auto · Switchman」分組下的「Auto」入口（用戶端渲染為在地化的「自動（意圖識別）」）；選中後每條使用者訊息先由分類器判定最合適的候選，同一輪鎖定決策：信心不足或仍在快取視窗內時優先沿用目前模型（快取續用），信心足夠高或目前模型不在候選裡才切換；切換在呼叫層靜默完成，不往對話裡插「模型已切換」。輸入框上方有狀態 chip（自動路由時顯示目前路由模型與上次決策信心），候選與閾值隨時回設定頁查看。

只有一個模型也值得裝——水位控制和分級驗證與模型數量無關，單模型長對話同樣受益。

## 隨附技能

- **db-query**——MySQL / Redis 唯讀核驗：跑 SQL 核對資料、查快取鍵 / TTL、跨庫一致性檢查，拒絕一切寫入。首次使用需初始化（見下）。
- **git-commit-message**——產生規範的 commit 文案，只出文字，從不替你 git。
- **requirement-docs**——需求分析 / PRD / 設計文件的統一規範，產出歸檔到 `docs/requirements-and-design/`。

## 快速上手

1. **安裝**——任意對話裡讓 agent 執行，或在 Web 外掛管理頁：

   ```
   plugin_manager: install_bundle  target=dsh-switchman
   ```

   或從本機 checkout 安裝（link 方式；更新後需 `remove_bundle` + `install_bundle` 重裝）：

   ```
   plugin_manager: install_bundle  target=/path/to/dsh-switchman
   ```

   或在終端機用 `dsh` 指令——按執行方式選對應的 profile：

   ```bash
   dsh plugin --profile web add dsh-switchman      # Web GUI
   dsh plugin --profile desktop add dsh-switchman   # 桌面應用
   ```

2. **重新啟動 DSH**——完全退出應用程式再打開（重新整理頁面不算），用戶端模組表才能識別本 bundle。

3. **設定**——設定 → dsh-switchman，或首頁側邊欄的「Switchman 調度中心」。設定就一頁，長這樣，從上往下過一遍就設完了：

   ![dsh-switchman 設定頁全貌：介面語言、語言偏好、六個派發池、能力排序與執行模式、團隊開關、上下文水位與指令](docs/assets/conf-interface-zh-TW.png)

   - **介面**——外掛自己的介面語言。圖中下拉停在「繁體中文」——切換的即時預覽；出廠預設是「自動」（跟隨 DSH 應用程式語言）。選定語言當場整頁切換，儲存後記住，隨時切回「自動」。
   - **語言**——代理產出物的語言。作用域圖中為「全域（本 profile）」（也可按專案，各自讀 `.switchman/lang.json`）；回覆 / 程式碼註解 / 文件三個下拉圖中都定在繁體中文，每項顯示為「原生語名（標籤）」，如「繁體中文 (zh-TW)」，每項下方有「目前：…」狀態行。全不設也行，首次用到問一次、記住即用。
   - **派發池**——六張卡片兩行三列：上排輕量、機械、主力，下排高難、多模態、複審。卡片按供應商分組勾候選模型；勾上「手動排序」變成編號優先清單，用 ↑ ↓ × 調順序；每條路線可釘思考強度（預設「跟隨泳道」）。頂部彙總行即時更新，圖中即「已設定 4/6 池 · 排名 2 項 · 模式 建議」。
   - **能力排序 + 執行模式**——六池選中模型的聯集按能力排序、最強在前（圖中 glm-5.3 錨 S 級、glm-5.3-flash 錨 A 級），可調序、可刪減；執行模式建議 / 強制（強制 = 池外模型直接拒絕）。
   - **代理團隊**——團隊模式與白名單同步兩個開關，預設全關；圖中為開啟狀態，開關下方有同步狀態行。
   - **上下文水位**——三級閾值（圖中 80000 / 120000 / 150000）、單次讀取預算（3000）、hard 級行為（限流放行 / 攔截）、自動交接開關、子代理獨立上限，都在這區。底部一行指令：`/ctx-pause` 暫停干預 · `/ctx-resume` 恢復 · `/ctx-handover` 立即交接（它會把對話引導到閒置邊界再壓縮，結果可能要等幾分鐘）。
   - **意圖識別**——主開關、分類器小模型路由、分類器類型（auto / decision / chat）、獨立候選清單（每項附一句能力描述）、快取視窗 / 信心閾值 / 分類逾時 / 歷史訊息預算、可選備援模型。開啟後模型選擇器出現「自動（意圖識別）」入口，輸入框上方顯示目前路由模型與信心 chip。

4. **驗證**——對話標頭出現 ⚡「自主團隊」徽章（旁邊 ◇ 顯示目前對話模型）；或者直接問模型「你系統提示詞最後一段的標題是什麼」，答案應提到 dsh-switchman 規程。

**db-query 首次使用初始化**（腳本相依裝在技能目錄內，不污染專案）：

```bash
bash <安裝目錄>/skills/db-query/scripts/setup.sh
```

**分類器選型建議**：若要在本機部署決策模型，建議用 Ollama 執行 `d3:4b-mxfp8`：分類器類型選「決策端點（systemone）」，端點填 `http://127.0.0.1:11434/v1/systemone`，模型名稱填 `d3:4b-mxfp8`。若走 LLM 目錄的 chat 分類器，建議選雲端小模型，或不帶思考（推理）能力的本機小模型——關閉思考可同時壓低延遲與分類逾時失敗率。

## 預設配置

以下為新安裝後的全部預設值（權威來源：`host/config.js` 的 zod schema）。

**介面與語言**：`uiLocale` = `auto`（跟隨 DSH 應用程式語言）；`langScope` = `global`；`langConversation/Comments/Docs` = 空（首次對話問一次後記住；註解與文件語言跟隨對話語言）。

**派發池**：六條泳道（economy/mechanical/main/hard/vision/review）候選均為空（= 用系統預設模型，不干預）；手動排序與 effort 釘選均為關/空；`dispatchEnforce` = `advice`（建議不強制）。

**上下文水位**：soft `80000` / hard `95000` / force `150000` tokens；單次讀取預算 `3000`；超預算行為 `cap`（截斷加警告）；`wmAutoHandover` = 開（force 級自動寫交接文件+壓縮）；子代理硬上限 = 開（共享 150k）。

**Agent Teams**：`teamsMode` = 關；`syncWhitelist` = 關（兩者相互獨立）。

**意圖識別**（預設不可用，需設定分類器 + 至少一個候選 + 打開主開關）：`intentEnabled` = 關（關閉時 Auto 入口隱藏，已選 Auto 的對話走備援鏈）；分類器路由未設定；分類器類型 `chat`；候選清單空（預置分類需填模型才參與路由）；快取視窗 `300` 秒 / 切換信心閾值 `80` / 分類逾時 `60000` ms；歷史 `6` 則 / `2400` 字元；`intentContextWindow` = `200000`。

**上下文裁剪**：`trimEnabled` = 開；`trimMode` = `auto`（全自動）；增長閘門 `22500` token + 增量 `25000` token；壓力 `65%` / 緊急 `95%`；保護尾部 `10` 則；折疊節奏上限每小時 `30` 次；side model 未設定（繼承對話模型）——詳見下文「自動上下文裁剪」一節。

**開箱要點**：① 意圖識別開箱不可用是有意設計，三步開啟（分類器、候選、開關）；② Auto 有效視窗開箱即為 200000——護欄保證 0.8×視窗 ≥ force 級（150000），核心壓縮線（160000）永遠在平滑交接線（150000）之後；③ 開箱最有感的是水位三件套：80k 提醒委派 / 95k 收斂讀取 / 150k 自動交接（寫文件+壓縮），無須任何設定。

## 自動上下文裁剪

長對話也能保持便宜：已被消化掉的對話區間會被折疊成緊湊的確定性摘要——全自動完成，且不破壞服務商提示詞快取。在閒置邊界上，裁剪引擎（`host/context-trim/`）挑出值得折疊的區間，由 side model 寫出摘要（僅在緊急壓力下才改走無 side model 呼叫的機械折疊），並把 fold 提交進該對話的折疊狀態。此後每個出站請求都從該狀態重建——摘要塊頂替被折疊的區間，活動尾部原樣保留。儲存的對話從不被改寫，也絕不在串流過程中動手。

自動化層級（`trimMode`）：

- **`off`**——只測量：用量與快取命中取樣照常執行；無橫幅、無折疊。
- **`advisory`**——對話模型自己折疊：向其暴露 `ctx_trim_fold` 與 `ctx_trim_status` 工具和協定頭。
- **`auto`**（預設）——以上全部，外加閒置邊界上的自動折疊，分三級：增長閘門（自上次折疊後的低谷起算的增長 > `trimGrowthTokens`——該錨點保證高位折疊後閘門依然有效——且連續可壓縮增量 ≥ `trimIncrementTokens`）、壓力級（上下文視窗的 `trimPressurePercent`）、緊急級（`trimEmergencyPercent`——帶獨立冷卻的機械折疊）。

所有鍵位於 設定 → dsh-switchman；預設值出自 `host/config.js`：

| 鍵 | 預設值 | 含義 |
| --- | --- | --- |
| `trimEnabled` | `true` | 總開關。關閉後折疊與度量全部停用（監聽器退化為純透傳）。 |
| `trimMode` | `auto` | `off` 只測量 / `advisory` 模型自折 / `auto` 系統自動折。 |
| `trimGrowthTokens` | `22500` | 增長閘門：出站 view 自上次 fold 以來增長到該值即觸發折疊。 |
| `trimIncrementTokens` | `25000` | 閘門搭檔：連續可壓縮增量也須達到該規模。 |
| `trimPressurePercent` | `65` | 壓力級：view 用量達到上下文視窗該百分比即折疊。 |
| `trimEmergencyPercent` | `95` | 緊急級：到該百分比強制機械折疊（無 side model 呼叫）。 |
| `trimWindowTokens` | `0` | 視窗上限：壓力與緊急檔按 min(模型視窗, 上限) 計算。`0` = 跟隨 `wmForceTokens`。 |
| `trimProtectedTail` | `10` | 最後 N 則訊息永不折疊。 |
| `trimMaxFoldsPerHour` | `30` | 每滾動小時 side model 折疊的節奏上限（緊急級豁免）。 |
| `trimSideModel` | 未設定 | 寫摘要的 side model 路由。留空 = 繼承對話目前模型。 |
| `trimFoldFallbackModel` | 未設定 | 摘要 side model 失敗時摺疊改用的重試路由；壓力檔仍失敗則退回機械摺疊。留空 = 無備援。盡量選擇冷卻、風控與並行餘量充足的路由。 |
| `trimStateDir` | 未設定 | 折疊狀態目錄覆蓋。留空 = `<dshHome>/.dsh-switchman/state/trim/`。 |
| `surfaceFold` | `true` | 把已提交的 fold 送上對話表面（shadow-price 計量事件 + `surfaceOp` replace 事件對）。關閉則維持僅拼接的 view。 |

**觸發路徑。** 級別檢查在閒置邊界上執行；在閒置狀態事件不可達的宿主上，兜底改為在每次模型串流完成後也檢查一次（每個對話節流為每 60 秒至多評估一次）。每個決策——fold 與 no-op 皆然——都會作為一行帶時間戳的 `key=value` 附加進裁剪狀態目錄（見 `trimStateDir`）下的 `decisions.log`，為 fold 留下離線稽核軌跡；列詞彙（`view-applied`、fold 決策/結果列、`surface-replace`、`surface-replace skipped reason=…`）收錄於 [docs/context-trim.md](./docs/context-trim.md)。

**線上真值與穩態。** 決策列攜帶 `view=<n>`，回應落地後還會帶上 `wire=<n>`——真實的廠商提示詞（未快取輸入 + 快取讀取 + 快取寫入，從串流的 usage 事件取樣得到）。view 估算只統計 messages 陣列，而且總是比線上讀數小一個固定額外開銷（實測 ≈ 17.3k：系統提示詞 + 工具 schema + persona），所以壓力級與緊急級按 `max(view, wire)` 評估，只有 `wire` 才是提示詞大小的讀數。150k 視窗下，健康的鋸齒波在每次 fold 剛結束時線上 ≈ 40k ↔ 下次 fold 時 64–97.5k（佔視窗的 ≈27%–65%），每 ~25k 原始增長折疊一次，上限由壓力級而非視窗釘在 97.5k 附近。若 `view` 持續攀升卻從不出現 `surface-replace` 列，就去讀跳過列（`incomplete-seqs`、`no-service`、`compaction-lock`）。

**宿主壓縮紀元。** fold 引用錨定在訊息 id 與內容雜湊上，因此宿主自身的壓縮一旦替換了重發歷史，整本帳就會同時老化：所有塊都無法定位，view 靜默回退為原始歷史（fail-open——決策日誌會記錄 `view-applied applied=0`），外掛在下一次請求時把增長基線重錨到壓縮後的視圖。宿主壓縮因此是兜底的裁剪層，外掛 fold 負責單一宿主紀元內的細粒度工作。 部分派發改用完全凍結的請求陣列或選項物件（目前的 agent loop 會深凍結裝配好的請求）；對這類派發，`injectView` 會在決策日誌裡報告結果：`nothing-to-apply`（沒有定位到 fold 塊——原始歷史本身就是 view）、`in-place`/`swapped`（fold view 已隨請求送出）或 `none`（fold 存在但凍結的派發帶不動它——線上送出原始歷史）。**Surface replace 是可用時的發送路徑**（`surfaceFold`，預設開啟）：在序列的 `agent/turn-stopping` 邊界外加一次閒置清掃，外掛追加宿主風格的 shadow-price 計量事件與一條攜帶 `surfaceOp {op:'replace', startSeq, endSeq}` 的 `user/message` 替換事件，`sourceEventSeqs` 覆蓋被遮蔽的每個表面節點——與宿主自身壓縮用的是同一機制——已提交的 fold 由此從源頭直達線上，凍結派發也不例外。當某對話近期派發都記錄 `none` 時，外掛把 view 當作僅供計量：水位改用服務商上報的計數（force 檔與自動交接照常運作），fold 循環暫停、不再空燒 summarizer 呼叫，裁剪橫幅以 `wire=raw`（folds not shipping; watermark reads the tally）標記該行；沒有 surface 機制的宿主（或開關關閉時）保持的正是這套舊行為。

**fold 如何保住快取命中。** 每次 fold 都要為前綴重付一次；目標是攤銷成本，不是滿分命中率。引擎守住快取契約：fold 只附加——frontier 只前進，凍結區永不再改；view 由（歷史, 折疊狀態）確定性重建，因此兩次 fold 之間序列化前綴位元組不變，服務商快取持續命中；fold 邊界絕不把 assistant 的 tool-call 與其 tool 結果拆開；最後 `trimProtectedTail` 則訊息豁免；一切皆 fail-open——內部出錯退化為透傳，絕不產生壞請求。

**壓縮仲裁。** 兩個自動裁剪器搶同一份歷史會互相重複摘要、互相摧毀 frontier，因此 `cordis.patch.yml` 給宿主的 `dsh-compaction-basic` 行設了 `auto: false`：context-trim 成為唯一語義裁剪器。手動 `/compact` 照常可用，force 級交接（借用的正是這條手動路徑）不受影響。溢出恢復改由裁剪承擔：超視窗的那次嘗試失敗一次，隨後緊急級折好 view，下一次嘗試就能裝下。

**fork 繼承。** 被 fork 的對話（子代理 fork）按 copy-on-fork 繼承父對話的折疊狀態——但僅當父狀態存在且子對話歷史確實能解析到父 frontier；否則子對話從乾淨狀態起步。每個子對話只繼承一次，跨重啟冪等。

**水位讀的是 view。** 水位橫幅報的是出站 view 的 token 數（折疊後模型真正看到的部分），不再是儲存側計數，重度折疊的對話因此不會再把水位釘死在 hard 級。

## 運作原理

- Host 半（`index.js` + `host/`）注入位元組恆定的系統提示詞段（語言 / 泳道 / 水位協定 / 團隊），即時水位線改走尾部 runtime-context 快照通道（只附加、不改寫提示詞頭部，廠商 prompt cache 不受影響）、讀取預算與 enforce 雙閘、四個斜線指令（ctx 三件套 + `/vision`）。設定儲存後下一輪提示詞組裝即生效，無須重新啟動。
- Client 半（`client.js`）渲染設定頁、對話標頭的 ⚡ 徽章與 ◇ 模型標識、交接進行中的動態提示；設定快照經 Host 路由家族讀寫。
- 首頁側邊欄的「Switchman 調度中心」入口，點一下即以中央面板開啟同一設定頁；原設定入口保留。
- `cordis.patch.yml` 完整保留出廠預設的外掛清單，只在 persona suffix 上做擴充；Agent Teams 工具本體來自出廠 bundle，開啟團隊模式時自動啟用。

## 維護須知

- DSH 升級後若出廠預設外掛清單有變，從新的 `presets/*.patch.yml` 重新同步 `cordis.patch.yml`（保留 doctrine suffix 與壓縮仲裁——`compaction-basic` 行上的 `auto: false`），然後重裝。
- 協定行（`[SWITCHMAN:LANG|POOLS|WATERMARK|TEAMS]`）刻意保持英文且位元組穩定——不要在地化。
- `npm pack --dry-run` 應保持稽核過的 60 個檔案 / ~380 kB 形態（解壓後 ~1.26 MB，`docs/` 不進包）。

## License

MIT
