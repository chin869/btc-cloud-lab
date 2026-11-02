import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {POLICY} from "./risk_engine.mjs";
import {readJson,writeJson} from "./storage.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const arg=(name,fallback)=>{const i=process.argv.indexOf(name);return i<0?fallback:process.argv[i+1];};
const input=path.resolve(arg("--input",path.join(root,"data/auto-paper.json")));
const cache=path.resolve(arg("--cache",path.join(root,".replay-cache")));
const output=path.resolve(arg("--output",path.join(root,"data/reports/legacy-replay.json")));
const download=process.argv.includes("--download");
fs.mkdirSync(cache,{recursive:true});
async function cachedJson(name,url){
  const file=path.join(cache,name);
  if(fs.existsSync(file))return readJson(file,null);
  if(!download)throw Error("缺少歷史查核資料："+name);
  let error;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetch(url,{headers:{"User-Agent":"BTC-Cloud-Lab-Audit","Accept":"application/json"},signal:AbortSignal.timeout(20000)});
      if(!response.ok)throw Error("HTTP "+response.status);
      const value=await response.json();
      if(value.code!==undefined&&value.code!=="0")throw Error("Public API "+value.code+" "+value.msg);
      writeJson(file,value);return value;
    }catch(err){error=err;if(attempt<2)await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));}
  }
  throw error;
}
const originalBytes=fs.readFileSync(input),ledger=JSON.parse(originalBytes);
const sorted=[...ledger.account.trades].filter(t=>!t.strategyVersion).sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
const pairs=[];let open=null;
for(const trade of sorted){if(trade.side.startsWith("OPEN_"))open=trade;else if(trade.side.startsWith("CLOSE_")&&open){pairs.push({open,close:trade});open=null;}}
const results=[];
for(const [index,{open,close}] of pairs.entries()){
  const row={openedAt:open.ts,originalExitAt:close.ts,originalNet:close.realized,replayedNet:null,
    initialStop:open.stopPrice,initialTarget:open.takeProfitPrice,qty:open.qty,leverage:open.leverage,
    entryFill:open.fill,entryFee:open.fee};
  try{
    const until=new Date(Date.parse(open.ts)+60000).toISOString();
    const commits=await cachedJson("entry-"+index+"-commits.json","https://api.github.com/repos/chin869/btc-cloud-lab/commits?path=data/cloud-status.json&per_page=1&until="+encodeURIComponent(until));
    if(!commits.length)throw Error("找不到當時來源紀錄");
    const status=await cachedJson("entry-"+index+"-status.json","https://raw.githubusercontent.com/chin869/btc-cloud-lab/"+commits[0].sha+"/data/cloud-status.json");
    if(Math.abs(Date.parse(status.lastSuccessAt)-Date.parse(open.ts))>60000)throw Error("來源紀錄與進場時間不一致");
    row.venue=status.decision?.marketDataSource?.includes("OKX")?"OKX":status.decision?.marketDataSource?.includes("Binance")?"Binance":null;
    if(!row.venue)throw Error("當時交易所不明，不能替換行情來源重算");
    row.sourceCommit=commits[0].sha;
    const start=Math.min(Math.floor(Date.parse(open.ts)/60000)*60000,Number(status.decision.candleTs));
    let after=Math.ceil(Date.parse(close.ts)/60000)*60000+60000;
    const map=new Map();
    for(let page=0;page<20;page++){
      const url=row.venue==="OKX"?"https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=1m&limit=300&after="+after:
        "https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1m&limit=1000&endTime="+(after-1);
      const data=await cachedJson("entry-"+index+"-minute-"+page+".json",url);
      const rows=row.venue==="OKX"?data.data:data;
      if(!Array.isArray(rows)||!rows.length)break;
      let oldest=Infinity;
      for(const k of rows){const t=Number(k[0]);oldest=Math.min(oldest,t);if(row.venue==="Binance"||k[8]==="1")map.set(t,{t,open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4])});}
      if(oldest<=start)break;
      if(oldest>=after)throw Error("歷史資料分頁沒有前進");after=oldest;
    }
    const entryQuote=map.get(status.decision.candleTs),recorded=status.decision.market;
    if(!entryQuote||![['close','price'],['high','high'],['low','low']].every(([a,b])=>Math.abs(entryQuote[a]-recorded[b])<0.000001))throw Error("當時分鐘報價與此來源無法核對");
    row.venueCheck="entry-minute OHLC matches archived decision";
    const from=Math.ceil(Date.parse(open.ts)/60000)*60000,to=Math.floor(Date.parse(close.ts)/60000)*60000;
    const full=[];
    for(let t=from;t<to;t+=60000){if(!map.has(t))throw Error("分鐘資料有缺口 "+new Date(t).toISOString());full.push(map.get(t));}
    row.checkedMinutes=full.length;
    const side=open.side==="OPEN_SHORT"?"SHORT":"LONG",direction=side==="LONG"?1:-1;
    const partial=map.get(Math.floor(Date.parse(open.ts)/60000)*60000);
    row.partialEntryMinuteTouched=Boolean(partial&&(side==="LONG"?partial.low<=open.stopPrice||partial.high>=open.takeProfitPrice:partial.high>=open.stopPrice||partial.low<=open.takeProfitPrice));
    let exit=null;
    for(const c of full){
      const gap=side==="LONG"?c.open<=open.stopPrice:c.open>=open.stopPrice;
      const stop=side==="LONG"?c.low<=open.stopPrice:c.high>=open.stopPrice;
      const target=side==="LONG"?c.high>=open.takeProfitPrice:c.low<=open.takeProfitPrice;
      if(gap||stop||target){exit={at:c.t,price:gap?c.open:stop?open.stopPrice:open.takeProfitPrice,type:gap?"跳過止損，使用開盤價":stop?"原始止損":"原始止盈",ambiguous:stop&&target};break;}
    }
    if(exit){
      const fill=exit.price*(1-direction*POLICY.slippageRate),fee=fill*open.qty*POLICY.feeRate;
      row.replayedNet=(fill-open.fill)*open.qty*direction-open.fee-fee;
      row.exitAt=new Date(exit.at).toISOString();row.exitFill=fill;row.reason=exit.type;
      row.note=exit.type+(exit.ambiguous?"；同分鐘碰到兩價，採止損優先":"")+"；固定原進場與倉位，不含動態提前離場及資金費";
    }else{
      row.replayedNet=close.realized;row.exitAt=close.ts;row.reason="保留原記錄的提前離場";
      row.note="完整分鐘未觸原始保護價；保留原離場，未重建當時模型與動態保護價";
    }
    if(row.partialEntryMinuteTouched){
      row.conditionalNet=row.replayedNet;row.replayedNet=null;
      row.note="進場所在不完整分鐘已觸價，無法判斷發生於進場前後；不可確認。"+row.note;
    }
  }catch(err){row.note="無法確認："+String(err.message||err);}
  results.push(row);console.log(JSON.stringify({trade:index+1,original:row.originalNet,replayed:row.replayedNet,note:row.note}));
}
const verified=results.filter(r=>r.replayedNet!==null);
const report={generatedAt:new Date().toISOString(),inputSha256:createHash("sha256").update(originalBytes).digest("hex"),
  method:"Fixed original entries and sizes, initial stop/target only; no full counterfactual strategy return",
  originalNet:results.reduce((s,r)=>s+r.originalNet,0),verifiedComparisons:verified.length,
  fixedEntryComparisonNet:verified.reduce((s,r)=>s+r.replayedNet,0),
  summary:"共 "+results.length+" 筆原始交易；"+verified.length+" 筆完成來源及完整分鐘查核。對照固定原進場與倉位，不是重新運行整套策略，也不是新版實績。",trades:results,
  schedule:{summary:"前次完整查核取得 188 次排程，平均間隔約 266 分鐘。啟動後排隊時間中位數 0 分鐘，整個工作耗時中位數約 41 秒；現有紀錄未顯示工作本身耗時數小時。觸發間隔的完整平台原因仍未確認。新版保存每次啟動、排隊及間隔紀錄，未承諾已修復平台延遲。",scheduledRuns:188,meanIntervalMinutes:266.1825311942958,medianQueueMinutes:0,medianRunDurationSeconds:41}};
writeJson(output,report);
if(!fs.readFileSync(input).equals(originalBytes))throw Error("Original input was modified");
