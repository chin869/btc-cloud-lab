import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { POLICY,analyzeMinuteCandles,planPosition,evaluatePosition,unrealizedPnl } from "./risk_engine.mjs";

const __filename=fileURLToPath(import.meta.url);
const cloudDir=path.dirname(__filename);
const root=path.resolve(cloudDir,"..");
const dataDir=path.join(root,"data");

const SETTINGS_PATH=path.join(dataDir,"auto-paper-settings.json");
const LEDGER_PATH=path.join(dataDir,"auto-paper.json");
const AUTO_JS_PATH=path.join(dataDir,"auto-paper.js");
const DERIV_JSON_PATH=path.join(dataDir,"derivatives-history.json");
const DERIV_JS_PATH=path.join(dataDir,"derivatives-history.js");
const CLOUD_STATUS_PATH=path.join(dataDir,"cloud-status.json");

const BASE_FUTURES="https://fapi.binance.com";
const BASE_OKX="https://www.okx.com";
const OKX_INSTRUMENT="BTC-USDT-SWAP";
const MAX_ROWS_PER_FEED=30000;

fs.mkdirSync(dataDir,{recursive:true});

function nowIso(){return new Date().toISOString();}
function stripBom(text){return String(text||"").replace(/^\uFEFF/,"");}
function readJson(file,fallback,{strict=false}={}){
  if(!fs.existsSync(file)) return fallback;
  try{return JSON.parse(stripBom(fs.readFileSync(file,"utf8")));}
  catch(err){
    if(strict) throw new Error("Invalid JSON in "+path.relative(root,file)+": "+String(err&&err.message||err));
    return fallback;
  }
}
function writeText(file,value){
  const temp=file+".tmp-"+process.pid+"-"+Date.now();
  try{
    fs.writeFileSync(temp,value,"utf8");
    fs.renameSync(temp,file);
  }finally{
    if(fs.existsSync(temp)) fs.rmSync(temp,{force:true});
  }
}
function writeJson(file,value){writeText(file,JSON.stringify(value,null,2)+"\n");}

async function fetchJson(url,timeoutMs=20000){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const res=await fetch(url,{
      signal:controller.signal,
      headers:{"User-Agent":"BTC-Cloud-Lab/1.0"},
      cache:"no-store"
    });
    if(!res.ok) throw new Error("HTTP "+res.status+" "+url);
    return await res.json();
  }finally{
    clearTimeout(timer);
  }
}

async function fetchOkxData(pathname,query,timeoutMs=20000){
  const payload=await fetchJson(BASE_OKX+pathname+"?"+query,timeoutMs);
  if(!payload||String(payload.code)!=="0"||!Array.isArray(payload.data)){
    throw new Error("OKX "+String(payload&&payload.code||"invalid")+" "+String(payload&&payload.msg||"response"));
  }
  return payload.data;
}

async function firstSuccessful(sources){
  const errors=[];
  for(const source of sources){
    try{return {rows:await source.run(),source:source.name};}
    catch(err){errors.push(source.name+": "+String(err&&err.message||err));}
  }
  throw new Error(errors.join(" | "));
}

function normalizeTsRow(row,timestampField="timestamp"){
  const out={...row};
  const raw=out[timestampField];
  const ts=Number(Array.isArray(raw)?raw[raw.length-1]:raw);
  if(Number.isFinite(ts)) out.timestamp=ts;
  return out;
}

function mergeRows(existing,incoming){
  const map=new Map();
  for(const row of [...(Array.isArray(existing)?existing:[]),...(Array.isArray(incoming)?incoming:[])]){
    if(!row) continue;
    const ts=Number(row.timestamp ?? row.fundingTime);
    if(!Number.isFinite(ts)||ts<=0) continue;
    map.set(ts,{...row,timestamp:ts});
  }
  return Array.from(map.values())
    .sort((a,b)=>Number(a.timestamp)-Number(b.timestamp))
    .slice(-MAX_ROWS_PER_FEED);
}

async function getPagedRows(endpoint,extraQuery,startMs,endMs,limit,timestampField){
  const all=[];
  let cursor=startMs;
  let pages=0;
  while(cursor<=endMs&&pages<20){
    const url=BASE_FUTURES+endpoint+"?symbol=BTCUSDT&"+extraQuery+
      "&startTime="+cursor+"&endTime="+endMs+"&limit="+limit;
    const raw=await fetchJson(url);
    const rows=Array.isArray(raw)?raw:[];
    if(!rows.length) break;
    for(const row of rows) all.push(normalizeTsRow(row,timestampField));
    const last=normalizeTsRow(rows[rows.length-1],timestampField);
    const lastTs=Number(last.timestamp);
    if(!Number.isFinite(lastTs)||lastTs<=cursor) break;
    cursor=lastTs+1;
    pages++;
    if(rows.length<limit) break;
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  return all;
}

async function getOkxFunding(){
  const rows=await fetchOkxData(
    "/api/v5/public/funding-rate-history",
    "instId="+OKX_INSTRUMENT+"&limit=100"
  );
  return rows.map(row=>({
    symbol:"BTCUSDT",venue:"OKX",fundingRate:row.fundingRate,
    fundingTime:Number(row.fundingTime),timestamp:Number(row.fundingTime)
  }));
}

async function getOkxMetric(pathname,mapRow,extraQuery=""){
  const rows=await fetchOkxData(
    pathname,
    "instId="+OKX_INSTRUMENT+"&period=1H&limit=100"+extraQuery
  );
  return rows.map(mapRow).filter(Boolean);
}

function okxOpenInterest(row){
  if(!Array.isArray(row)||row.length<4) return null;
  return {
    symbol:"BTCUSDT",venue:"OKX",timestamp:Number(row[0]),
    sumOpenInterest:String(row[2]),sumOpenInterestValue:String(row[3])
  };
}

function okxLongShort(row){
  if(!Array.isArray(row)||row.length<2) return null;
  return {symbol:"BTCUSDT",venue:"OKX",timestamp:Number(row[0]),longShortRatio:String(row[1])};
}

function okxTaker(row){
  if(!Array.isArray(row)||row.length<3) return null;
  const sell=Number(row[1]),buy=Number(row[2]);
  if(!Number.isFinite(sell)||!Number.isFinite(buy)||sell<=0) return null;
  return {
    symbol:"BTCUSDT",venue:"OKX",timestamp:Number(row[0]),
    sellVol:String(row[1]),buyVol:String(row[2]),buySellRatio:String(buy/sell)
  };
}

function emptyDerivatives(){
  return {version:1,updatedAt:null,feeds:{funding:[],openInterest:[],longShort:[],taker:[]}};
}

async function collectDerivatives(){
  const attemptAt=nowIso();
  const existing=readJson(DERIV_JSON_PATH,emptyDerivatives(),{strict:true});
  const feeds=existing&&existing.feeds?existing.feeds:emptyDerivatives().feeds;
  const status={version:1,lastAttemptAt:attemptAt,lastSuccessAt:null,lastError:null,counts:{},sources:{}};
  const existingUpdated=existing.updatedAt?Date.parse(existing.updatedAt):NaN;
  if(Number.isFinite(existingUpdated)&&Date.now()-existingUpdated<45*60000){
    status.lastSuccessAt=existing.updatedAt;
    status.counts={
      funding:Array.isArray(feeds.funding)?feeds.funding.length:0,
      openInterest:Array.isArray(feeds.openInterest)?feeds.openInterest.length:0,
      longShort:Array.isArray(feeds.longShort)?feeds.longShort.length:0,
      taker:Array.isArray(feeds.taker)?feeds.taker.length:0
    };
    status.sources={cached:{ok:true,reason:"1h derivatives data is still fresh"}};
    writeText(DERIV_JS_PATH,"window.BTCLocalDerivativesHistory = "+JSON.stringify({...existing,collector:status})+";\n");
    return {payload:existing,status};
  }
  const endMs=Date.now();
  const derivativeStartMs=endMs-29*24*3600000;
  const requests={
    funding:firstSuccessful([
      {name:"Binance USDT-M",run:()=>fetchJson(BASE_FUTURES+"/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000")},
      {name:"OKX USDT-M SWAP",run:getOkxFunding}
    ]),
    openInterest:firstSuccessful([
      {name:"Binance USDT-M",run:()=>getPagedRows("/futures/data/openInterestHist","period=1h",derivativeStartMs,endMs,500,"timestamp")},
      {name:"OKX USDT-M SWAP",run:()=>getOkxMetric("/api/v5/rubik/stat/contracts/open-interest-history",okxOpenInterest)}
    ]),
    longShort:firstSuccessful([
      {name:"Binance USDT-M",run:()=>getPagedRows("/futures/data/globalLongShortAccountRatio","period=1h",derivativeStartMs,endMs,500,"timestamp")},
      {name:"OKX USDT-M SWAP",run:()=>getOkxMetric("/api/v5/rubik/stat/contracts/long-short-account-ratio-contract",okxLongShort)}
    ]),
    taker:firstSuccessful([
      {name:"Binance USDT-M",run:()=>getPagedRows("/futures/data/takerlongshortRatio","period=1h",derivativeStartMs,endMs,500,"timestamp")},
      {name:"OKX USDT-M SWAP",run:()=>getOkxMetric("/api/v5/rubik/stat/taker-volume-contract",okxTaker,"&unit=1")}
    ])
  };
  const names=Object.keys(requests);
  const results=await Promise.allSettled(Object.values(requests));
  const incoming={};
  const errors=[];
  let successCount=0;

  results.forEach((result,index)=>{
    const name=names[index];
    if(result.status==="fulfilled"){
      const rows=Array.isArray(result.value.rows)?result.value.rows:[];
      incoming[name]=name==="funding"?rows.map(row=>normalizeTsRow(row,"fundingTime")):rows;
      status.sources[name]={ok:true,received:incoming[name].length,source:result.value.source};
      successCount++;
    }else{
      incoming[name]=[];
      const message=String(result.reason&&result.reason.message||result.reason);
      status.sources[name]={ok:false,error:message};
      errors.push(name+": "+message);
    }
  });

  const updatedAt=successCount?nowIso():(existing.updatedAt||null);
  const merged={
    version:1,
    updatedAt,
    feeds:{
      funding:mergeRows(feeds.funding,incoming.funding),
      openInterest:mergeRows(feeds.openInterest,incoming.openInterest),
      longShort:mergeRows(feeds.longShort,incoming.longShort),
      taker:mergeRows(feeds.taker,incoming.taker)
    }
  };
  status.lastSuccessAt=successCount?updatedAt:(existing.updatedAt||null);
  status.lastError=errors.length?errors.join(" | "):null;
  status.counts={
    funding:merged.feeds.funding.length,
    openInterest:merged.feeds.openInterest.length,
    longShort:merged.feeds.longShort.length,
    taker:merged.feeds.taker.length
  };
  if(successCount) writeJson(DERIV_JSON_PATH,merged);
  writeText(DERIV_JS_PATH,"window.BTCLocalDerivativesHistory = "+JSON.stringify({...merged,collector:status})+";\n");
  return {payload:merged,status};
}

async function fetchHistoryFrom(base,interval,target=5000){
  let endTime=Date.now();
  let rows=[];
  while(rows.length<target){
    const limit=Math.min(1000,target-rows.length);
    const url=base+"/fapi/v1/klines?symbol=BTCUSDT&interval="+interval+"&limit="+limit+"&endTime="+endTime;
    const data=await fetchJson(url,25000);
    if(!Array.isArray(data)||!data.length) break;
    const batch=data.map(k=>({
      t:Number(k[0]),open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),
      close:Number(k[4]),volume:Number(k[5]),closedAt:Number(k[6])
    }));
    rows=batch.concat(rows);
    endTime=batch[0].t-1;
    if(data.length<limit) break;
  }
  const unique=new Map();
  for(const c of rows) unique.set(c.t,c);
  return Array.from(unique.values())
    .sort((a,b)=>a.t-b.t)
    .filter(c=>c.closedAt<Date.now())
    .slice(-target);
}

function intervalMs(interval){
  if(interval==="1m") return 60000;
  if(interval==="1h") return 3600000;
  throw new Error("Unsupported contract candle interval: "+interval);
}

async function fetchOkxHistory(interval,target=5000){
  const bar=interval==="1h"?"1H":"1m";
  let after="";
  const rows=[];
  for(let page=0;rows.length<target&&page<25;page++){
    const limit=Math.min(300,target-rows.length);
    const query="instId="+OKX_INSTRUMENT+"&bar="+bar+"&limit="+limit+(after?"&after="+after:"");
    const data=await fetchOkxData("/api/v5/market/history-candles",query,25000);
    if(!data.length) break;
    let oldest=Infinity;
    for(const k of data){
      const t=Number(k[0]);
      oldest=Math.min(oldest,t);
      if(String(k[8])!=="1") continue;
      rows.push({
        t,open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),
        volume:Number(k[6]),closedAt:t+intervalMs(interval)-1
      });
    }
    if(!Number.isFinite(oldest)||String(oldest)===after||data.length<limit) break;
    after=String(oldest);
    await new Promise(resolve=>setTimeout(resolve,120));
  }
  const unique=new Map();
  for(const candle of rows) unique.set(candle.t,candle);
  return Array.from(unique.values()).sort((a,b)=>a.t-b.t).slice(-target);
}

async function fetchHistory(interval,target=5000,minRows=700){
  const errors=[];
  const sources=[
    {name:"Binance USDT-M BTCUSDT",run:()=>fetchHistoryFrom(BASE_FUTURES,interval,target)},
    {name:"OKX USDT-M BTC-USDT-SWAP",run:()=>fetchOkxHistory(interval,target)}
  ];
  for(const source of sources){
    try{
      const candles=await source.run();
      if(candles.length<minRows) throw new Error(interval+" candles are insufficient");
      return {candles,source:source.name};
    }catch(err){
      errors.push(source.name+": "+String(err&&err.message||err));
    }
  }
  throw new Error("USDT-M futures market data unavailable: "+errors.join(" | "));
}

function loadModels(){
  globalThis.window=globalThis;
  const predictor=fs.readFileSync(path.join(root,"predictor.js"),"utf8");
  const derivatives=fs.readFileSync(path.join(root,"derivatives.js"),"utf8");
  vm.runInThisContext(predictor,{filename:"predictor.js"});
  vm.runInThisContext(derivatives,{filename:"derivatives.js"});
  if(!globalThis.BTCPredictor||!globalThis.BTCDerivatives) throw new Error("Model scripts did not initialize");
}

function modelMean(models){
  const ps=(models||[]).map(m=>Number(m.current&&m.current.probabilityUp)).filter(Number.isFinite);
  return ps.length?ps.reduce((a,b)=>a+b,0)/ps.length:0.5;
}

function deriveSignal(main,deriv){
  const weights={"1h":1,"4h":1.5,"24h":2};
  const validated=[];
  const raw=[];

  for(const key of ["1h","4h","24h"]){
    const h=main.horizons[key];
    if(h&&h.consensus&&h.consensus.validated&&h.consensus.action!=="NEUTRAL"){
      validated.push({action:h.consensus.action,weight:weights[key],source:"OHLCV "+key});
    }
    raw.push({key,p:modelMean(h&&h.models),weight:weights[key],source:"OHLCV"});

    const dh=deriv&&deriv.available&&deriv.horizons&&deriv.horizons[key];
    if(dh&&dh.available){
      if(dh.consensus&&dh.consensus.validated&&dh.consensus.action!=="NEUTRAL"){
        validated.push({action:dh.consensus.action,weight:weights[key]*0.8,source:"Derivatives "+key});
      }
      raw.push({key,p:modelMean(dh.models),weight:weights[key]*0.65,source:"Derivatives"});
    }
  }

  if(validated.length){
    let score=0,total=0;
    for(const v of validated){
      score+=(v.action==="LONG"?1:-1)*v.weight;
      total+=v.weight;
    }
    const agreement=total?Math.abs(score)/total:0;
    if(agreement>=0.34){
      return {
        signal:score>0?"BUY":"SELL",
        mode:"validated",
        probabilityUp:score>0?0.5+agreement*0.35:0.5-agreement*0.35,
        confidence:Math.min(90,55+agreement*30),
        reason:"通過 PASS 的模型投票："+validated.map(v=>v.source+" "+v.action).join("、")
      };
    }
  }

  let weighted=0,totalWeight=0;
  for(const r of raw){weighted+=r.p*r.weight;totalWeight+=r.weight;}
  const p=totalWeight?weighted/totalWeight:0.5;
  const byHorizon={};
  for(const key of ["1h","4h","24h"]){
    const rows=raw.filter(r=>r.key===key);
    byHorizon[key]=rows.length?rows.reduce((a,b)=>a+b.p,0)/rows.length:0.5;
  }
  const longVotes=Object.values(byHorizon).filter(v=>v>=0.54).length;
  const shortVotes=Object.values(byHorizon).filter(v=>v<=0.46).length;
  let signal="HOLD";
  if(p>=0.56&&longVotes>=2) signal="BUY";
  else if(p<=0.44&&shortVotes>=2) signal="SELL";
  return {
    signal,
    mode:"experimental-unvalidated",
    probabilityUp:p,
    confidence:Math.min(78,50+Math.abs(p-0.5)*120),
    horizonProbabilities:byHorizon,
    reason:"研究模式："+signal+"；綜合上漲機率 "+(p*100).toFixed(1)+"%，1H/4H/24H="+
      [byHorizon["1h"],byHorizon["4h"],byHorizon["24h"]].map(v=>(v*100).toFixed(1)+"%").join(" / ")
  };
}

function defaultSettings(){
  return {
    enabled:true,
    ...POLICY,
    experimentalTrading:true
  };
}

function loadSettings(){
  const requested=readJson(SETTINGS_PATH,{}, {strict:true});
  const fixed=defaultSettings();
  return {
    ...fixed,
    enabled:requested.enabled!==false,
    experimentalTrading:requested.experimentalTrading!==false
  };
}

function newLedger(settings){
  return {
    version:2,
    createdAt:nowIso(),
    updatedAt:null,
    lastRunAt:null,
    lastSuccessAt:null,
    lastError:null,
    lastProcessedCandleTs:0,
    lastDecision:null,
    settingsSnapshot:settings,
    account:{
      cash:Number(settings.initialBalance),
      qty:0,
      avgEntry:0,
      realizedPnl:0,
      positionSide:null,
      leverage:1,
      marginUsed:0,
      stopPrice:0,
      takeProfitPrice:0,
      entryFee:0,
      riskAmount:0,
      positionOpenedAt:null,
      lastExitAt:null,
      trades:[],
      equityHistory:[]
    }
  };
}

function normalizeLedger(ledger,settings){
  const out=ledger&&ledger.account?ledger:newLedger(settings);
  out.settingsSnapshot=settings;
  out.account.cash=Number(out.account.cash)||0;
  out.account.qty=Number(out.account.qty)||0;
  out.account.avgEntry=Number(out.account.avgEntry)||0;
  out.account.realizedPnl=Number(out.account.realizedPnl)||0;
  out.account.positionSide=out.account.positionSide||null;
  out.account.leverage=Math.min(POLICY.maxLeverage,Math.max(1,Number(out.account.leverage)||1));
  out.account.marginUsed=Number(out.account.marginUsed)||0;
  out.account.stopPrice=Number(out.account.stopPrice)||0;
  out.account.takeProfitPrice=Number(out.account.takeProfitPrice)||0;
  out.account.entryFee=Number(out.account.entryFee)||0;
  out.account.riskAmount=Number(out.account.riskAmount)||0;
  out.account.trades=Array.isArray(out.account.trades)?out.account.trades:[];
  out.account.equityHistory=Array.isArray(out.account.equityHistory)?out.account.equityHistory:[];
  return out;
}

function saveLedger(ledger){
  ledger.updatedAt=nowIso();
  writeJson(LEDGER_PATH,ledger);
  writeText(AUTO_JS_PATH,"window.BTCAutoPaper = "+JSON.stringify(ledger)+";\n");
}

function appendTrade(account,trade){
  account.trades=[trade,...account.trades].slice(0,500);
}

function accountPosition(account){
  if(!account.positionSide||Number(account.qty)<=0) return null;
  return {
    side:account.positionSide,qty:Number(account.qty),entryPrice:Number(account.avgEntry),
    leverage:Number(account.leverage),marginUsed:Number(account.marginUsed),
    stopPrice:Number(account.stopPrice),initialStopPrice:Number(account.initialStopPrice||account.stopPrice),
    takeProfitPrice:Number(account.takeProfitPrice),entryFee:Number(account.entryFee),
    openedAt:account.positionOpenedAt,highestPrice:Number(account.highestPrice||account.avgEntry),
    lowestPrice:Number(account.lowestPrice||account.avgEntry)
  };
}

function appendEquity(account,candleTs,price){
  const equity=Number(account.cash)+unrealizedPnl(accountPosition(account),price);
  const old=account.equityHistory.filter(x=>Number(x.ts)!==Number(candleTs));
  old.push({ts:Number(candleTs),equity,price});
  old.sort((a,b)=>Number(a.ts)-Number(b.ts));
  account.equityHistory=old.slice(-5000);
}

async function makeDecision(feeds){
  const [history,minuteHistory]=await Promise.all([
    fetchHistory("1h",5000,700),
    fetchHistory("1m",1000,60)
  ]);
  const candles=history.candles;
  const market=analyzeMinuteCandles(minuteHistory.candles);
  loadModels();

  const main=globalThis.BTCPredictor.run(candles,{feeRate:POLICY.feeRate,slippageRate:POLICY.slippageRate});
  let deriv=null;
  try{
    deriv=globalThis.BTCDerivatives.run(candles,feeds,{feeRate:POLICY.feeRate,slippageRate:POLICY.slippageRate});
  }catch{}

  const decision=deriveSignal(main,deriv);
  return {
    ok:true,
    generatedAt:nowIso(),
    marketType:"USDT_M_BTC_PERPETUAL",
    marketDataSource:history.source,
    candleTs:market.candleTs,
    price:market.price,
    market,
    currentRegime:main.currentRegime,
    signal:decision.signal,
    mode:decision.mode,
    probabilityUp:decision.probabilityUp,
    confidence:decision.confidence,
    horizonProbabilities:decision.horizonProbabilities||null,
    reason:decision.reason,
    mainValidated:{
      "1h":Boolean(main.horizons["1h"].consensus.validated),
      "4h":Boolean(main.horizons["4h"].consensus.validated),
      "24h":Boolean(main.horizons["24h"].consensus.validated)
    },
    derivativesAvailable:Boolean(deriv&&deriv.available)
  };
}

function runPaperCycle(decision){
  const settings=loadSettings();
  const ledger=normalizeLedger(readJson(LEDGER_PATH,null,{strict:true}),settings);
  ledger.lastRunAt=nowIso();

  if(!settings.enabled){
    ledger.lastDecision={signal:"DISABLED",mode:"off",reason:"AUTO PAPER disabled",at:ledger.lastRunAt};
    ledger.lastError=null;
    saveLedger(ledger);
    return ledger;
  }

  const price=Number(decision.price);
  const candleTs=Number(decision.candleTs);
  const account=ledger.account;

  if(Number(ledger.lastProcessedCandleTs)===candleTs){
    appendEquity(account,candleTs,price);
    ledger.lastSuccessAt=nowIso();
    ledger.lastError=null;
    saveLedger(ledger);
    return ledger;
  }

  let signal=String(decision.signal);
  const mode=String(decision.mode);
  if(mode==="experimental-unvalidated"&&!settings.experimentalTrading) signal="HOLD";
  let action="HOLD";
  let reason=String(decision.reason||"");
  let position=accountPosition(account);

  if(position){
    const outcome=evaluatePosition(position,{...decision,signal},decision.market);
    if(outcome.action==="CLOSE"){
      const target=Number(outcome.price)||price;
      const fill=position.side==="LONG"?target*(1-POLICY.slippageRate):target*(1+POLICY.slippageRate);
      const direction=position.side==="LONG"?1:-1;
      const grossPnl=(fill-position.entryPrice)*position.qty*direction;
      const exitFee=position.qty*fill*POLICY.feeRate;
      const realized=grossPnl-Number(position.entryFee||0)-exitFee;
      account.cash=Number(account.cash)+grossPnl-exitFee;
      account.realizedPnl=Number(account.realizedPnl)+realized;
      action="CLOSE_"+position.side;
      reason=outcome.reason;
      appendTrade(account,{
        ts:nowIso(),candleTs,side:action,qty:position.qty,fill,fee:exitFee,
        entryFee:Number(position.entryFee||0),realized,leverage:position.leverage,
        mode,source:"AUTO-CLOUD-USDT-M-1M",marketType:decision.marketType,reason,
        probabilityUp:Number(decision.probabilityUp),confidence:Number(decision.confidence)
      });
      Object.assign(account,{
        qty:0,avgEntry:0,positionSide:null,leverage:1,marginUsed:0,
        stopPrice:0,initialStopPrice:0,takeProfitPrice:0,entryFee:0,riskAmount:0,
        positionOpenedAt:null,highestPrice:0,lowestPrice:0,lastExitAt:nowIso()
      });
      position=null;
    }else{
      position=outcome.position;
      account.stopPrice=position.stopPrice;
      account.highestPrice=position.highestPrice;
      account.lowestPrice=position.lowestPrice;
      reason="Position monitored; protective levels updated";
    }
  }else if(signal==="BUY"||signal==="SELL"){
    const lastExit=account.lastExitAt?Date.parse(account.lastExitAt):NaN;
    const cooled=!Number.isFinite(lastExit)||(Date.now()-lastExit)>=POLICY.cooldownMinutes*60000;
    const plan=cooled?planPosition(Number(account.cash),{...decision,signal},decision.market):null;
    if(plan&&plan.notional>=5){
      const fill=plan.side==="LONG"?price*(1+POLICY.slippageRate):price*(1-POLICY.slippageRate);
      const entryFee=plan.notional*POLICY.feeRate;
      const stopPrice=plan.side==="LONG"?fill*(1-plan.stopPct):fill*(1+plan.stopPct);
      const takeProfitPrice=plan.side==="LONG"?fill*(1+plan.takePct):fill*(1-plan.takePct);
      account.cash=Number(account.cash)-entryFee;
      Object.assign(account,{
        qty:plan.notional/fill,avgEntry:fill,positionSide:plan.side,
        leverage:plan.leverage,marginUsed:plan.marginUsed,stopPrice,
        initialStopPrice:stopPrice,takeProfitPrice,entryFee,riskAmount:plan.riskAmount,
        positionOpenedAt:nowIso(),highestPrice:fill,lowestPrice:fill
      });
      action="OPEN_"+plan.side;
      reason="Dynamic size: "+plan.leverage+"x, risk "+(plan.riskPct*100).toFixed(2)+"%, stop "+(plan.stopPct*100).toFixed(2)+"%, target "+(plan.takePct*100).toFixed(2)+"%";
      appendTrade(account,{
        ts:nowIso(),candleTs,side:action,qty:account.qty,fill,fee:entryFee,realized:0,
        leverage:plan.leverage,marginUsed:plan.marginUsed,riskAmount:plan.riskAmount,
        stopPrice,takeProfitPrice,mode,source:"AUTO-CLOUD-USDT-M-1M",marketType:decision.marketType,reason,
        probabilityUp:Number(decision.probabilityUp),confidence:Number(decision.confidence)
      });
    }else if(!cooled){
      reason="30-minute re-entry cooldown";
    }
  }

  appendEquity(account,candleTs,price);
  ledger.lastProcessedCandleTs=candleTs;
  ledger.lastDecision={
    at:nowIso(),candleTs,signal,executed:action,mode,price,
    marketType:decision.marketType,marketDataSource:decision.marketDataSource,
    probabilityUp:Number(decision.probabilityUp),
    confidence:Number(decision.confidence),
    reason,
    market:{atrPct:decision.market.atrPct,rsi:decision.market.rsi,emaFast:decision.market.emaFast,emaSlow:decision.market.emaSlow}
  };
  ledger.lastSuccessAt=nowIso();
  ledger.lastError=null;
  saveLedger(ledger);
  return ledger;
}

async function main(){
  const cloudStatus={version:1,lastRunAt:nowIso(),lastSuccessAt:null,lastError:null,collector:null,decision:null};
  try{
    const collected=await collectDerivatives();
    cloudStatus.collector=collected.status;
    const decision=await makeDecision(collected.payload.feeds);
    cloudStatus.decision=decision;
    runPaperCycle(decision);
    cloudStatus.lastSuccessAt=nowIso();
  }catch(err){
    cloudStatus.lastError=String(err&&err.stack||err);
    try{
      const settings=loadSettings();
      const ledger=normalizeLedger(readJson(LEDGER_PATH,null,{strict:true}),settings);
      ledger.lastRunAt=nowIso();
      ledger.lastError=cloudStatus.lastError;
      saveLedger(ledger);
    }catch(ledgerErr){
      cloudStatus.ledgerError=String(ledgerErr&&ledgerErr.stack||ledgerErr);
    }
  }

  writeJson(CLOUD_STATUS_PATH,cloudStatus);
  console.log(JSON.stringify({
    ok:!cloudStatus.lastError,
    at:cloudStatus.lastRunAt,
    collectorError:cloudStatus.collector&&cloudStatus.collector.lastError,
    decision:cloudStatus.decision&&{
      signal:cloudStatus.decision.signal,
      mode:cloudStatus.decision.mode,
      price:cloudStatus.decision.price
    },
    error:cloudStatus.lastError
  },null,2));
  if(cloudStatus.lastError) process.exitCode=1;
}

await main();
