# BTC Cloud Lab 部署說明

這是 BTC Local Lab 的雲端執行層。Windows 本機版與原有批次檔仍然保留；雲端版上線後，即使家裡電腦關機，GitHub Actions 仍會約每 5 分鐘執行一次 AUTO PAPER，GitHub Pages 則提供固定的瀏覽網址。

## 雲端版會做什麼

- 從 Binance 公開、免金鑰的 USDT-M Futures 端點讀取 BTCUSDT 永續合約的價格、K 線與衍生品資料。
- 直接執行既有的 `predictor.js` 與 `derivatives.js`。
- 只操作 repository 內的 AUTO PAPER 虛擬帳本。
- 更新完成後，把模擬持倉、交易紀錄、衍生品歷史與執行狀態提交回 repository。
- 重新產生 GitHub Pages 網站，讓手機、iPad 與電腦都能開啟。

雲端程式沒有 API Key、私鑰、餘額查詢或下單端點，也不會連接真實交易帳戶。

## 雲端風控規則

- 初始虛擬資金：500 USDT
- 標的：Binance USDT-M `BTCUSDT` 永續合約，可做多或做空；只計算模擬成交、保證金與損益
- 槓桿：依模型信心與 1 分鐘波動動態使用，最高 10 倍
- 倉位：每筆預計風險約為帳戶權益的 0.5%～1.25%，保證金最多使用權益的 25%
- 手續費：0.10%
- 滑價：0.05%
- 初始止損：依 1 分鐘 ATR 自動計算，約 0.4%～2.0%
- 初始止盈：固定為初始止損距離的 2 倍，報酬風險比 2:1
- 動態離場：模型反轉、EMA／RSI／短線動能惡化時可提前平倉；獲利達 1R 後會移動保護價
- 最長持倉：48 小時
- 平倉後 30 分鐘內不重新進場
- 同一根已收盤 1 分鐘 K 線不重複交易

雲端程式只允許切換 `enabled` 與 `experimentalTrading`。本金、槓桿上限、倉位風險與 2:1 初始報酬風險比由程式固定保護。

AUTO PAPER 的進場價、持倉監控與回測價格都使用合約 K 線，不以 BTC 現貨 K 線代替。畫面中的手動瀏覽器現貨練習盤是舊版保留功能，帳本與雲端合約 AUTO PAPER 完全分開。

## 最簡單的首次部署流程

1. 登入 GitHub，建立一個新的 **Public repository**，名稱可用 `btc-cloud-lab`，預設分支保持 `main`。建立時不要另外加入 README、`.gitignore` 或 License。
2. 把 `WebCodex-Test` 資料夾內的所有內容上傳到 repository 根目錄。務必確認 GitHub 上看得到 `.github/workflows/cloud-paper.yml`、`cloud`、`data`、`index.html`、`app.js`、`predictor.js` 與 `derivatives.js`。
3. 打開 repository 的 **Settings → Pages**，在 **Build and deployment** 將 Source 選成 **GitHub Actions**。
4. 打開 **Actions**。若 GitHub 顯示需要啟用 workflows，先按啟用；接著選 **BTC Cloud AUTO PAPER → Run workflow → Run workflow**。
5. 等待 `build` 和 `deploy` 兩個工作都顯示綠色勾勾。第一次通常需要幾分鐘。
6. 回到 **Settings → Pages**，開啟 GitHub 顯示的網站網址。之後可把這個網址加入手機或 iPad 書籤。

不需要建立 GitHub Secret，也不要上傳任何 Binance API Key。

若 `Persist cloud paper data` 顯示沒有寫入權限，請到 **Settings → Actions → General → Workflow permissions**，選擇 **Read and write permissions** 後重跑一次。若 `deploy` 顯示 Pages 尚未設定，回到第 3 步確認 Source 是 GitHub Actions。

## 資料如何保存

每次雲端循環會提交下列檔案：

- `data/derivatives-history.json`
- `data/derivatives-history.js`
- `data/auto-paper.json`
- `data/auto-paper.js`
- `data/cloud-status.json`

下一輪會讀取上一輪帳本，因此持倉與績效不會因 GitHub Actions 使用新的執行環境而重置。寫入採用暫存檔後再替換，若帳本 JSON 已損壞，執行會報錯並保留原檔，不會靜默建立新帳本覆蓋歷史。

## 暫停或恢復 AUTO PAPER

在 GitHub 打開 `data/auto-paper-settings.json`：

- 暫停：把 `"enabled": true` 改成 `"enabled": false` 並提交。
- 恢復：改回 `"enabled": true` 並提交。

這只會停止或恢復虛擬模擬盤，不涉及真實交易。

## 本機版與雲端版的關係

第一次上雲會沿用目前的 `data/auto-paper.json` 作為雲端起點。桌面上的 Windows 版本不會被覆蓋，仍可保留作為備份或測試環境。上線後兩邊若同時執行，會各自形成不同的模擬盤歷史；正式觀察時建議把 GitHub 上的 ledger 當作雲端主紀錄。

GitHub Actions 允許的最短排程間隔是 5 分鐘，而且不是準點保證，繁忙時可能延後。程式每次會讀取最新已收盤的 1 分鐘 K 線，但無法保證每一分鐘都執行。若日後需要真正每分鐘常駐監控，應搬到 VPS 或支援 1 分鐘排程的雲端服務。排程只會在 repository 的預設分支執行；公開 repository 若長時間完全沒有活動，GitHub 也可能停用排程，可在 Actions 頁面重新啟用。
