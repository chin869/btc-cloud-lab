import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename=fileURLToPath(import.meta.url);
const cloudDir=path.dirname(__filename);
const root=path.resolve(cloudDir,"..");
const dist=path.join(root,"dist");

fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(path.join(dist,"data"),{recursive:true});

for(const name of ["style.css","predictor.js","derivatives.js"]){
  fs.copyFileSync(path.join(root,name),path.join(dist,name));
}
for(const name of ["derivatives-history.js","auto-paper.js"]){
  const src=path.join(root,"data",name);
  if(!fs.existsSync(src)) throw new Error("Missing required cloud data file: data/"+name);
  fs.copyFileSync(src,path.join(dist,"data",name));
}
for(const name of ["cloud-status.json"]){
  const src=path.join(root,"data",name);
  if(fs.existsSync(src)) fs.copyFileSync(src,path.join(dist,"data",name));
}

function replaceRequired(text,from,to,label){
  if(!text.includes(from)) throw new Error("Cloud UI source text not found: "+label);
  return text.replace(from,to);
}

let html=fs.readFileSync(path.join(root,"index.html"),"utf8");
html=replaceRequired(html,"<title>BTC Local Lab</title>","<title>BTC Cloud Lab</title>","page title");
html=replaceRequired(html,"LOCAL · PAPER TRADING ONLY","CLOUD · PAPER TRADING ONLY","environment badge");
html=replaceRequired(html,"<h1>BTC Local Lab</h1>","<h1>BTC Cloud Lab</h1>","main heading");
html=replaceRequired(
  html,
  "免費公開行情分析 + 本機模擬盤。所有交易只存在你的瀏覽器。",
  "Binance BTCUSDT 永續合約公開行情 + 雲端 AUTO PAPER；不連接真實合約帳戶。",
  "intro copy"
);
html=replaceRequired(
  html,
  "Windows 背景每小時檢查一次；只使用虛擬資金，不會送出真實交易。",
  "GitHub Actions 約每 5 分鐘啟動一次，使用已收盤的 BTCUSDT 永續合約 1 分鐘 K 線監控；只使用虛擬資金，不會送出真實交易。",
  "AUTO PAPER schedule copy"
);
html=replaceRequired(
  html,
  "AUTO 目前預設允許 <strong>experimental-unvalidated</strong> 研究交易，因為現有模型尚未通過完整 PASS；這些交易只用來 forward test，不代表已證明有獲利能力。要暫停可執行 auto_paper_off.bat，重新開啟用 auto_paper_on.bat。",
  "AUTO 目前預設允許 <strong>experimental-unvalidated</strong> 研究交易，因為現有模型尚未通過完整 PASS；這些交易只用來 forward test，不代表已證明有獲利能力。雲端開關由儲存庫中的 AUTO PAPER 設定管理。",
  "AUTO PAPER mode copy"
);
html=replaceRequired(html,"<span>模擬盤總資產</span>","<span>手動模擬總資產</span>","manual equity label");
html=replaceRequired(html,"<h2>AUTO PAPER 自動模擬盤</h2>","<h2>AUTO PAPER 永續合約模擬盤</h2>","cloud futures heading");
html=replaceRequired(html,"<span>BTC 持倉</span>","<span>合約持倉</span>","cloud position label");
html=replaceRequired(
  html,
  "<span>單筆上限 10%</span><span>現貨 BTC</span><span>無槓桿</span><span>止損 2%</span><span>止盈 4%</span><span>最長持倉 48H</span>",
  "<span>USDT-M 永續合約</span><span>本金 500 USDT</span><span>動態倉位</span><span>最高 10x</span><span>1m 風控</span><span>TP:SL = 2:1</span><span>最長持倉 48H</span>",
  "cloud risk policy"
);
html=replaceRequired(html,"<h2>模擬盤</h2>","<h2>手動瀏覽器模擬盤</h2>","manual paper heading");
html=replaceRequired(html,"現貨 BTC 模擬交易，不連接真實交易所。","這是獨立的手動現貨練習盤，與雲端 AUTO 合約帳本分開。","manual paper copy");
html=replaceRequired(html,"<h2>模擬設定</h2>","<h2>手動模擬設定</h2>","manual settings heading");
html=replaceRequired(html,"<h2>本機備份</h2>","<h2>瀏覽器模擬盤備份</h2>","manual backup heading");
html=replaceRequired(html,"<h2>交易紀錄</h2>","<h2>手動模擬交易紀錄</h2>","manual trades heading");
html=replaceRequired(html,"網站會把本機累積資料與即時 API 合併。","網站會把雲端累積資料與 Binance 合約公開 API 合併。","collector copy");
html=replaceRequired(
  html,
  '<script src="data/derivatives-history.js"></script>',
  '<script>window.BTCCloudMode="usdt-m-futures";</script>\n  <script src="data/derivatives-history.js"></script>',
  "cloud futures mode"
);

let app=fs.readFileSync(path.join(root,"app.js"),"utf8");
app=replaceRequired(app," · 本機收集器 "," · 雲端收集器 ","collector label");

if(/auto_paper_(?:on|off)\.bat/i.test(html)) throw new Error("Cloud page still references Windows AUTO PAPER controls");

fs.writeFileSync(path.join(dist,"index.html"),html,"utf8");
fs.writeFileSync(path.join(dist,"app.js"),app,"utf8");
fs.writeFileSync(path.join(dist,".nojekyll"),"","utf8");

console.log("Cloud site built at "+dist);
