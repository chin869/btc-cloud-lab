import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename=fileURLToPath(import.meta.url);
const cloudDir=path.dirname(__filename);
const root=path.resolve(cloudDir,"..");
const dist=path.join(root,"dist");

if(path.dirname(dist)!==root||path.basename(dist)!=="dist"||fs.existsSync(dist)&&fs.lstatSync(dist).isSymbolicLink()) throw new Error("Unsafe build output path");
fs.rmSync(dist,{recursive:true,force:true});
fs.mkdirSync(path.join(dist,"data"),{recursive:true});

for(const name of ["style.css","predictor.js","derivatives.js","paper-report.js","cloud-review.html"]){
  fs.copyFileSync(path.join(root,name),path.join(dist,name));
}
for(const name of ["derivatives-history.js","auto-paper.js"]){
  const src=path.join(root,"data",name);
  if(!fs.existsSync(src)) throw new Error("Missing required cloud data file: data/"+name);
  fs.copyFileSync(src,path.join(dist,"data",name));
}
for(const name of ["cloud-status.json","auto-paper.json","cloud-analysis.json","cloud-analysis.js","derivatives-history.json"]){
  const src=path.join(root,"data",name);
  if(fs.existsSync(src)) fs.copyFileSync(src,path.join(dist,"data",name));
}

function replaceRequired(text,from,to,label){
  if(!text.includes(from)) throw new Error("Cloud UI source text not found: "+label);
  return text.replace(from,to);
}

for(const name of ["archive","reports"]){
  const src=path.join(root,"data",name);
  if(fs.existsSync(src))fs.cpSync(src,path.join(dist,"data",name),{recursive:true});
}
if(!fs.existsSync(path.join(dist,"data/cloud-analysis.js")))fs.writeFileSync(path.join(dist,"data/cloud-analysis.js"),"window.BTCCloudAnalysis=null;\n");
if(!fs.existsSync(path.join(dist,"data/cloud-analysis.json")))fs.writeFileSync(path.join(dist,"data/cloud-analysis.json"),"null\n");

let html=fs.readFileSync(path.join(root,"index.html"),"utf8").replace(/\r\n/g,"\n");
html=replaceRequired(html,"<title>BTC Local Lab</title>","<title>BTC Cloud Lab</title>","page title");
html=replaceRequired(html,"LOCAL · PAPER TRADING ONLY","CLOUD · PAPER TRADING ONLY","environment badge");
html=replaceRequired(html,"<h1>BTC Local Lab</h1>","<h1>BTC Cloud Lab</h1>","main heading");
html=replaceRequired(
  html,
  "免費公開行情分析 + 本機模擬盤。所有交易只存在你的瀏覽器。",
  "BTCUSDT 永續合約公開行情 + 雲端 AUTO PAPER；不連接真實合約帳戶。",
  "intro copy"
);
html=replaceRequired(
  html,
  "Windows 背景每小時檢查一次；只使用虛擬資金，不會送出真實交易。",
  "免費 GitHub 排程設定每 5 分鐘，實際可能延遲。執行時逐根補查已收盤的分鐘行情；這是延後更新的模擬紀錄，不是每分鐘即時交易。",
  "AUTO PAPER schedule copy"
);
html=replaceRequired(
  html,
  "AUTO 目前預設允許 <strong>experimental-unvalidated</strong> 研究交易，因為現有模型尚未通過完整 PASS；這些交易只用來 forward test，不代表已證明有獲利能力。要暫停可執行 auto_paper_off.bat，重新開啟用 auto_paper_on.bat。",
  "AUTO 目前預設允許 <strong>experimental-unvalidated</strong> 研究交易，因為現有模型尚未通過完整 PASS；這些交易只用來 forward test，不代表已證明有獲利能力。雲端開關由儲存庫中的 AUTO PAPER 設定管理。",
  "AUTO PAPER mode copy"
);
html=replaceRequired(html,"<span>模擬盤總資產</span>","<span>AUTO 合約總資產</span>","cloud equity label");
html=replaceRequired(html,"<h2>AUTO PAPER 自動模擬盤</h2>","<h2>AUTO PAPER 永續合約模擬盤</h2>","cloud futures heading");
html=replaceRequired(html,"<span>BTC 持倉</span>","<span>合約持倉</span>","cloud position label");
html=replaceRequired(
  html,
  "<span>單筆上限 10%</span><span>現貨 BTC</span><span>無槓桿</span><span>止損 2%</span><span>止盈 4%</span><span>最長持倉 48H</span>",
  "<span>USDT-M 永續合約</span><span>本金 500 USDT</span><span>倉位含成本估算</span><span>最高 10x</span><span>逐分鐘補查</span><span>價格距離 TP:SL = 2:1</span><span>最長持倉 48H</span>",
  "cloud risk policy"
);
html=replaceRequired(html,"<h2>模擬盤</h2>","<h2>手動瀏覽器模擬盤</h2>","manual paper heading");
html=replaceRequired(html,"現貨 BTC 模擬交易，不連接真實交易所。","這是獨立的手動現貨練習盤，與雲端 AUTO 合約帳本分開。","manual paper copy");
html=replaceRequired(html,"<h2>模擬設定</h2>","<h2>手動模擬設定</h2>","manual settings heading");
html=replaceRequired(html,"<h2>本機備份</h2>","<h2>瀏覽器模擬盤備份</h2>","manual backup heading");
html=replaceRequired(html,"<h2>交易紀錄</h2>","<h2>手動模擬交易紀錄</h2>","manual trades heading");
html=replaceRequired(html,"網站會把本機累積資料與即時 API 合併。","市場圖表與筆數僅顯示本輪雲端使用的交易所；未知來源的舊資料保留，但不混入模型。","collector copy");
html=replaceRequired(html,"本月 SELL / 平倉紀錄","本月合約做多／做空平倉紀錄","futures reporting copy");
html=replaceRequired(html,'<section class="layout-main">','<section class="layout-main cloud-contract-layout">',"cloud layout class");
html=replaceRequired(html,'<aside class="right-column">','<aside class="right-column cloud-manual-only">',"hide manual controls");
html=replaceRequired(
  html,
  '<section class="card">\n      <div class="section-head">\n        <div>\n          <h2>手動模擬交易紀錄</h2>',
  '<section class="card cloud-manual-only">\n      <div class="section-head">\n        <div>\n          <h2>手動模擬交易紀錄</h2>',
  "hide manual trades"
);
html=replaceRequired(
  html,
  '<link rel="stylesheet" href="style.css">',
  '<link rel="stylesheet" href="style.css">\n  <style>.cloud-manual-only{display:none!important}.cloud-contract-layout{grid-template-columns:minmax(0,1fr)!important}.cloud-contract-layout .left-column{min-width:0}</style>',
  "cloud-only styles"
);
html=replaceRequired(
  html,
  '<script src="data/derivatives-history.js"></script>',
  '<script>window.BTCCloudMode="usdt-m-futures";</script>\n  <script src="data/derivatives-history.js"></script>',
  "cloud futures mode"
);

let app=fs.readFileSync(path.join(root,"app.js"),"utf8");
html=replaceRequired(html,'<script src="app.js"></script>',
  '<script src="paper-report.js"></script>\n  <script src="data/cloud-analysis.js"></script>\n  <script src="app.js"></script>',"cloud reporting modules");
html=replaceRequired(html,'<main class="container">',`<main class="container">
    <section class="card cloud-health-panel" aria-label="雲端執行狀態">
      <div class="section-head"><h2>雲端模擬狀態</h2><span id="cloudHealthLabel" class="status neutral">讀取中</span></div>
      <p>關閉你的電腦不會停止雲端。上方報價連線成功，不代表雲端剛剛檢查過持倉。</p>
      <div class="auto-paper-metrics">
        <div><span>最後成功檢查</span><strong id="cloudLastCheck">--</strong><small id="cloudAge">--</small></div>
        <div><span>模擬使用的交易所</span><strong id="cloudSource">--</strong><small>帳戶估值使用雲端最後檢查價格</small></div>
      </div>
      <p id="cloudCoverage">等待紀錄</p><p id="cloudRiskNote"></p>
      <p id="cloudSegments"></p>
      <p class="tiny">新訊號先記錄，再以下一個完整分鐘開盤模擬成交；中斷後補算，不會事後新增歷史訊號。資金費按公開費率估算，資料覆蓋可能不完整；尚未完整模擬強制平倉。</p>
      <div class="cloud-links"><a href="data/auto-paper.json" download="btc-paper-ledger.json">下載完整帳本</a>
        <a id="cloudArchive" hidden download>下載升級前原始帳本</a>
        <a href="cloud-review.html">舊交易重算對照與排程檢查</a></div>
    </section>`,"cloud health panel");
html=replaceRequired(html,'</head>',`<style>
  .cloud-health-panel{margin-bottom:20px;border-color:#b88b3c}.cloud-health-panel strong{font-size:18px;overflow-wrap:anywhere}
  .cloud-links{display:flex;flex-wrap:wrap;gap:16px}.cloud-links a{color:#8bc6ff}.cloud-links [hidden]{display:none}
  .auto-trades-wrap td small{display:block;min-width:180px;color:#98a6b8}.top-actions .status{white-space:normal;max-width:190px}
  .top-actions .btn{white-space:nowrap;flex-shrink:0}
  @media(max-width:980px){.topbar{align-items:flex-start;flex-direction:column;gap:14px}.top-actions{width:100%;flex-wrap:wrap}.top-actions .status{max-width:none}.page-tabs{margin:0}.cloud-health-panel .section-head{align-items:flex-start;flex-wrap:wrap}}
  </style></head>`,"cloud responsive status styles");
app=replaceRequired(app," · 本機收集器 "," · 雲端收集器 ","collector label");

if(/auto_paper_(?:on|off)\.bat/i.test(html)) throw new Error("Cloud page still references Windows AUTO PAPER controls");

fs.writeFileSync(path.join(dist,"index.html"),html,"utf8");
fs.writeFileSync(path.join(dist,"app.js"),app,"utf8");
fs.writeFileSync(path.join(dist,".nojekyll"),"","utf8");

console.log("Cloud site built at "+dist);
