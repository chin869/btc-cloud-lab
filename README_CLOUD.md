# BTC Cloud Lab 免費版使用說明（paper-v3）

這是既有 BTC Local Lab 的雲端執行層。只記錄 BTC 永續合約模擬交易，不連接真實交易帳戶，也不需要交易所 API Key。Windows 本機版保留。

GitHub Actions 負責收集與計算，GitHub Pages 顯示結果。你的電腦可以關機，iPad 開啟相同網址即可查看。

## 這次修正了什麼

| 項目 | 新版行為 |
| --- | --- |
| 排程隔很久才執行 | 按順序補查期間每根分鐘 K 線，確認原持倉是否早已碰到止損或止盈 |
| 新進場 | 先保存模型訊號，再於下一個完整分鐘開盤模擬成交；到下次執行才補算 |
| 行情缺漏 | 停在缺口前、顯示異常、禁止新進場；補齊後從原位置繼續 |
| 跳過止損價 | 使用可取得的開盤價，加不利滑價，不假設一定能成交在原止損價 |
| 同分鐘碰到止盈與止損 | 無法知道先後順序，保守採止損優先並留紀錄 |
| 單一週期通過檢查 | 不把一票同意當成 85% 勝率，也不直接使用 10 倍槓桿 |
| 倉位分配 | 依風險預算計算，納入進出手續費及設定滑價 |
| 月報 | 統計合約多空平倉；依台灣時間區分月份 |
| 網頁狀態 | 分開顯示報價連線與雲端檢查；超過 15 分鐘提示延遲 |
| 歷史保留 | 原帳本先原樣備份，舊版、新版交易分開標示，可下載 |

每筆交易記錄訊號、交易所、策略版本、費用、倉位依據、發生時間與補寫時間。既有 predictor.js、derivatives.js 保持原樣；網頁顯示雲端實際使用的模型快照。

## 逐分鐘補查，不等於每分鐘即時交易

GitHub 排程設定每 5 分鐘觸發，但可能延遲或略過部分排程，無法保證準點。中間行情會在之後執行時補查；你當下看到的持倉可能尚未更新。

例如 10:00 執行後，到 11:00 才再執行，程式會檢查這段分鐘行情；若原持倉在 10:20 碰到止損，就留下該分鐘的出場紀錄。它不會用 11:00 才知道的訊號，假裝 10:20 開過新單。

分鐘高低價只能證明該分鐘碰過價位，不能精確知道秒數。帳本對分鐘內觸價以該分鐘結束時間記錄，另保存原分鐘時間及實際補寫時間。

單次最多抓取最近 7 天及指標暖機資料。如果缺口超出範圍或來源無法提供歷史，會停止核對並提示，不跳過缺口假裝成功。沒有持倉或預先保存的委託時，不會憑空補出中斷期間的新交易。

## 帳戶與風控

- 初始模擬本金 500 USDT；升級沿用現有餘額，不抹除過去盈虧。因此總資產不一定正好是 500。
- USDT 本位 BTC 永續合約，可多可空，同時一個持倉。
- 槓桿最高 10 倍，依支持週期與波動調整；僅單一週期支持時上限 2 倍。
- 每筆預計風險為權益 0.5%～1.25%；保證金不超過扣除進場費後權益的 25%。跳價及資金費仍可能使損失超出預算。
- 止損距離依分鐘波動決定，範圍 0.4%～2%；初始止盈距離為止損的 2 倍。
- **2:1 指價格距離；扣費後實際盈虧比會較低。** 網頁另顯示預估含費止損及扣費後比例。
- 進出場各收 0.10% 模擬手續費，各加 0.05% 不利滑價。這是研究假設，並非交易所實際費率承諾。
- 方向反轉或短線指標惡化可提前離場，有利走勢可移動保護價。收盤後才得知的新保護價不倒套到同分鐘之前。
- 最長持倉 48 小時，平倉後冷卻 30 分鐘。
- 資金費使用同交易所公開結算費率及該分鐘開盤價估算，每筆只扣一次；缺漏歷史不會憑空估值，覆蓋不保證完整。
- 尚未完整模擬維持保證金、強制平倉、訂單簿成交與流動性。結果不能視為真實交易可實現報酬。

信心分數與模型原始上漲機率均未校準成實際交易勝率。研究模式預設開啟，未通過完整檢查的交易保留 experimental-unvalidated 標記；通過檢查也不是保證獲利。

## 資料來源

使用 Binance USDT-M 公開合約行情；該區域無法存取時，空倉可選 OKX BTC-USDT-SWAP。持倉或等待成交的委託鎖定原交易所，避免用另一交易所價格補算出場。

衍生品必須同來源，且時間不超過模型最後收盤 K 線。持倉量、多空比、主動買賣量超過 2 小時，資金費率超過 24 小時時，該項不送入模型；缺少或過期資料另有標記。

網頁報價可持續更新；帳戶估值使用雲端最後檢查價格，避免把新報價與尚未補查的持倉混成即時績效。

## 已有網站：最簡單更新流程

現有網站：https://chin869.github.io/btc-cloud-lab/

1. 登入原 GitHub 帳號，開啟 chin869/btc-cloud-lab，使用既有 main 分支。
2. 提交程式更新及 data/reports/legacy-replay.json。**不要用舊 auto-paper.json、auto-paper.js 或整個舊 data 資料夾蓋掉線上帳本。** 本次專用更新包只包含修改的程式、說明與獨立查核報告。
3. 在 Settings → Pages 確認 Source 為 GitHub Actions。
4. 到 Actions → BTC Cloud AUTO PAPER → Run workflow，分支選 main，再按 Run workflow。
5. 等待 build 與 deploy。新版首次執行會自動備份當時原帳本並沿用餘額。
6. 開啟原網站並重新整理。應看到「雲端模擬狀態」、最後成功時間、舊版／新版交易統計及「舊交易重算對照」。iPad 使用相同網址。

無需新增付費服務、API Key 或交易所帳戶。收集失敗時，工作流盡可能把錯誤發布到網站；若建置、持久化或 Pages 部署本身失敗，網站可能仍是舊版本，請以 Actions 記錄為準。

若寫入被儲存庫政策拒絕，確認 Actions 可寫入此儲存庫；分支保護拒絕需要調整對應規則或採用核准的資料分支方案，不能靠重跑解決。不要上傳私人密碼或金鑰。

## 首次建立網站

1. 建立公開儲存庫，預設分支 main。
2. 上傳完整專案，包含 .github/workflows/cloud-paper.yml、cloud、data 及根目錄網頁檔案。
3. 依上方第 3～6 步啟用 Pages 並執行工作流。

公開儲存庫的程式及模擬紀錄任何人都可查看。標準公開儲存庫的 GitHub Actions 執行器與 Pages 可使用免費方案；不要改選大型付費執行器或私人儲存庫而假設費用仍相同。

## 暫停與恢復

編輯 data/auto-paper-settings.json：enabled 設 false 暫停新進場，true 恢復。暫停時取消等待中的進場委託，但仍補查與保護現有持倉，不會立刻清空持倉。

experimentalTrading 設 false 可禁止未通過檢查的研究進場。其他資金及風控參數由 cloud/risk_engine.mjs 固定保護。

## 保存與舊交易查核

每輪提交帳本、分鐘游標、行情快取、模型快照、執行狀態與排程診斷回 GitHub。先寫暫存檔再替換；損壞帳本會報錯，不會靜默重建成新帳戶。

首次升級建立 data/archive/auto-paper-before-v3-<雜湊>.json，原樣備份並保存完整 SHA-256。舊交易不改寫，新交易標記 paper-v3。升級時若仍有舊持倉，新版風控出場會保留舊進場背景，不代表完全由新版選出的交易。

cloud-review.html 提供 13 筆舊交易對照：固定當時進場與數量，檢查原始止損／止盈是否更早觸發。它未重建全部模型、動態離場、後續進場與資金費，**不可把加總當成新版策略報酬率**。

data/run-diagnostics.json 保存啟動時間、間隔、能取得的 GitHub 排隊時間與工作連結。這能協助找原因，不能保證修復平台延遲；沒有新增付費通知服務。

## 可執行驗證（Node.js 24）

```powershell
node cloud/verify_cloud.mjs
node cloud/verify_strategy.mjs
node --test cloud/tests/*.test.mjs
node cloud/build_site.mjs
```

實際行情試跑使用隔離資料夾：

```powershell
New-Item -ItemType Directory -Force .paper-test
Copy-Item data/auto-paper.json,data/auto-paper-settings.json,data/derivatives-history.json .paper-test/
$env:BTC_DATA_DIR = (Resolve-Path .paper-test).Path
node cloud/cloud_cycle.mjs
Remove-Item Env:BTC_DATA_DIR
```

不要把 .paper-test 測試帳本上傳蓋掉雲端資料。建置只讀正式 data，不會自動部署測試資料。

重做舊交易查核可執行 node cloud/replay_legacy.mjs --download。首次取得公開歷史資料，之後保留快取即可離線重跑。原帳本不會被修改。

## 官方限制參考

- [GitHub 排程：最短 5 分鐘、可能延遲、公開儲存庫 60 天無活動可停用](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [以 Actions 發布 Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)
- [GitHub Actions 計費與公開儲存庫](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
