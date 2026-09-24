# BTC Local Lab

這是一個完全本機的 BTC 行情分析與模擬交易第一版。

## 啟動

直接雙擊 start.bat。

不需要 Python、不需要 Node.js、不需要資料庫、不需要交易所 API Key。

## 目前功能

- BTC 公開行情，自動優先 Binance，失敗時切換 Kraken。
- 5 分、15 分、1 小時、4 小時、1 天 K 線。
- SMA20、SMA50、RSI14、6 根 K 動能、24 根 K 波動與區間。
- 簡單分析分數：多方偏向 / 中性 / 空方偏向。
- 本機現貨模擬盤：買入、賣出、全部平倉。
- 預設初始資金 10,000 USDT。
- 預設手續費 0.10%。
- 預設滑價 0.05%。
- 現金、BTC 持倉、平均成本、總資產、未實現與已實現損益。
- 最近 200 筆交易紀錄。
- 所有設定與模擬盤資料保存在瀏覽器 localStorage，關閉後再打開仍保留。
- JSON 匯出與匯入備份。
- 第二階段預測核心：同時輸出 1H / 4H / 24H 的做多 / 觀望 / 做空。
- 每個週期同時顯示規則模型與純瀏覽器 Logistic Regression ML。
- 顯示模型信心與 ML 上漲機率；信心不是保證勝率。
- 使用時間順序 walk-forward 回測，訓練只使用當時已知的資料，避免未來資料洩漏。
- 回測顯示訊號數、覆蓋率、訊號勝率、扣除估計雙邊手續費與滑價後的平均淨變動。
- 第三階段把 Binance 1H 歷史拉長到最多約 9,000 根完整 K 線；只使用已收盤 K 線訓練與驗證。
- 特徵擴充到多週期動能、SMA10/20/50/100、EMA、RSI、ATR、6/24/72 小時波動、成交量、布林位置、K 棒實體、時間週期等。
- 同時比較規則基準、Logistic Regression、Ridge Return Regression、Gaussian Naive Bayes、Stump Ensemble 五套模型。
- Ridge Return 直接預測未來報酬幅度，用來補足只猜漲跌方向的分類模型；同樣必須通過 walk-forward 與跨盤勢驗證。
- 使用 5 段 expanding walk-forward，並在每個測試切點 purge 尚未完成的未來標籤，降低 look-ahead leakage。
- 市場狀態分為多頭 / 空頭 / 震盪，模型必須有足夠跨盤勢穩定性，不能只靠單一行情片段通過。
- PASS 門檻包含：至少 80 個訊號、扣成本平均淨變動 > 0、Profit Factor ≥ 1.05、至少 60% 有效時間折為正，以及至少兩種盤勢為正且沒有明顯負盤勢。
- 第四階段加入 Binance Futures 公開衍生品資料：Funding Rate、Open Interest、Global Long/Short Account Ratio、Taker Buy/Sell Ratio，不需要 API Key。
- 衍生品資料按時間戳對齊到「該 1H K 線已收盤時」能看到的最新資料，避免把未來資料塞回過去。
- 衍生品增強層有 Derivatives Logistic 與 Derivatives Ridge 兩套模型，使用獨立的短期 walk-forward 驗證；若資料源失敗或有效樣本不足，會降級回原本 OHLCV 模型。
- 不會用補值方式假造更長的衍生品歷史；介面會顯示各資料源的實際覆蓋範圍。
- 第五階段加入 Windows 背景收集器 collector.ps1，每小時透過工作排程器抓取衍生品資料並永久合併到 data/derivatives-history.json。
- 網站會先載入 data/derivatives-history.js，再與當下 API 回傳的資料合併；因此累積的舊資料不會因 Binance 公開端點只提供短期窗口而消失。
- install_collector.bat：初次收集 + 安裝每小時排程；collector_status.bat：查看排程、最後成功時間與 log；uninstall_collector.bat：只移除排程，不刪歷史資料。
- 斷網或 API 暫時失敗時，collector 會保留既有資料並把錯誤寫到 data/collector.log，下次排程再重試。
- 第六階段加入網站內「數據中心」分頁：頂部可在「總覽 / 數據中心」切換。
- 數據中心提供 Funding Rate、Open Interest、Global Long/Short Ratio、Taker Buy/Sell Ratio 走勢圖，可切換 24H / 7D / 30D / 全部資料範圍。
- 數據中心同時顯示本月模擬盤已實現 PnL、目前未實現 PnL、本月平倉次數、勝率、手續費、最佳/最差平倉，以及本月累計已實現 PnL 曲線。
- 月績效不把目前浮盈浮虧混入「本月已實現 PnL」，避免把未平倉收益誤當成已賺到的模擬收益。
- 第七階段加入 AUTO PAPER 自動模擬盤：現有 Windows 每小時排程在收完市場資料後，會執行 auto_paper.ps1，使用 auto-engine.html 跑現有 OHLCV + 衍生品模型並產生 BUY / SELL / HOLD 決策。
- AUTO PAPER 與手動模擬盤完全分帳；自動帳本存於 data/auto-paper.json，網站使用 data/auto-paper.js 顯示。
- 預設虛擬資金 10,000 USDT，單筆最大 10%，現貨 BTC、無槓桿、止損 2%、止盈 4%、最長持倉 48 小時；SHORT 訊號在現貨模式只代表退出持倉，不建立放空。
- 現階段因完整模型尚未 PASS，AUTO 預設允許 experimental-unvalidated forward test，網站會明確標示，不能解讀為已驗證策略。
- auto_paper_off.bat 可暫停自動模擬，auto_paper_on.bat 可重新開啟；兩者不會刪除既有 AUTO 歷史。

## 安全邊界

此版本沒有任何真實交易 API Key，也沒有真實下單程式碼。分析結果不會觸發交易。

## 目前限制

- 第一版只做現貨模擬，不含槓桿、合約與放空。
- 行情需要網路，因為來源是免費公開 API。
- localStorage 是瀏覽器本機資料；若清除瀏覽器網站資料，模擬盤會被清除，所以重要紀錄請使用匯出 JSON 備份。
- 技術指標是研究工具，不代表未來報酬或勝率保證。
