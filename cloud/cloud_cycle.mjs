import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { POLICY,analyzeMinuteCandles } from "./risk_engine.mjs";
import {deriveSignal} from "./signal.mjs";
import {processCycle,positionOf,MINUTE} from "./paper_engine.mjs";
import {loadLedger,saveLedger} from "./storage.mjs";
import {selectModelFeeds} from "./model_feeds.mjs";

const __filename=fileURLToPath(import.meta.url);
const cloudDir=path.dirname(__filename);
const root=path.resolve(cloudDir,"..");
const dataDir=process.env.BTC_DATA_DIR?path.resolve(process.env.BTC_DATA_DIR):path.join(root,"data");

const SETTINGS_PATH=path.join(dataDir,"auto-paper-settings.json");
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
    map.set((row.venue||"UNKNOWN")+":"+ts,{...row,timestamp:ts});
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

async function collectDerivatives(venue){
  const attemptAt=nowIso();
  const existing=readJson(DERIV_JSON_PATH,emptyDerivatives(),{strict:true});
  const feeds=existing&&existing.feeds?existing.feeds:emptyDerivatives().feeds;
  const status={version:1,lastAttemptAt:attemptAt,lastSuccessAt:null,lastError:null,counts:{},sources:{}};
  const existingUpdated=existing.updatedAt?Date.parse(existing.updatedAt):NaN;
  if(Number.isFinite(existingUpdated)&&Date.now()-existingUpdated<45*60000&&existing.venue===venue){
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
    ].filter(source=>source.name.startsWith(venue))),
    openInterest:firstSuccessful([
      {name:"Binance USDT-M",run:()=>getPagedRows("/futures/data/openInterestHist","period=1h",derivativeStartMs,endMs,500,"timestamp")},
      {name:"OKX USDT-M SWAP",run:()=>getOkxMetric("/api/v5/rubik/stat/contracts/open-interest-history",okxOpenInterest)}
    ].filter(source=>source.name.startsWith(venue))),
    longShort:firstSuccessful([
      {name:"Binance USDT-M",run:()=>getPagedRows("/futures/data/globalLongShortAccountRatio","period=1h",derivativeStartMs,endMs,500,"timestamp")},
      {name:"OKX USDT-M SWAP",run:()=>getOkxMetric("/api/v5/rubik/stat/contracts/long-short-account-ratio-contract",okxLongShort)}
    ].filter(source=>source.name.startsWith(venue))),
    taker:firstSuccessful([
      {name:"Binance USDT-M",run:()=>getPagedRows("/futures/data/takerlongshortRatio","period=1h",derivativeStartMs,endMs,500,"timestamp")},
      {name:"OKX USDT-M SWAP",run:()=>getOkxMetric("/api/v5/rubik/stat/taker-volume-contract",okxTaker,"&unit=1")}
    ].filter(source=>source.name.startsWith(venue)))
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
      incoming[name]=(name==="funding"?rows.map(row=>normalizeTsRow(row,"fundingTime")):rows).map(row=>({...row,venue}));
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
    version:2,venue,
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
  for(let page=0;rows.length<target&&page<50;page++){
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

async function fetchHistory(interval,target=5000,minRows=700,venue=null){
  const errors=[];
  const sources=[
    {name:"Binance USDT-M BTCUSDT",run:()=>fetchHistoryFrom(BASE_FUTURES,interval,target)},
    {name:"OKX USDT-M BTC-USDT-SWAP",run:()=>fetchOkxHistory(interval,target)}
  ];
  for(const source of sources.filter(s=>!venue||s.name.startsWith(venue))){
    try{
      const candles=await source.run();
      if(candles.length<minRows) throw new Error(interval+" candles are insufficient");
      return {candles,source:source.name,venue:source.name.startsWith("OKX")?"OKX":"Binance"};
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

function loadSettings(){
  const requested=readJson(SETTINGS_PATH,{}, {strict:true});
  return {...POLICY,enabled:requested.enabled!==false,experimentalTrading:requested.experimentalTrading!==false};
}

function venueFrom(source){return String(source).includes("OKX")?"OKX":String(source).includes("Binance")?"Binance":null;}

async function getMinutes(ledger){
  const now=Date.now();
  const required=positionOf(ledger.account)?Number(ledger.lastProcessedCandleTs)+MINUTE:ledger.pendingEntry?.entryAt;
  const count=required?Math.min(POLICY.maxReplayMinutes+120,Math.max(180,Math.ceil((now-required)/MINUTE)+121)):180;
  const locked=ledger.account.positionVenue||ledger.pendingEntry?.venue;
  const preferred=locked||ledger.health?.venue||venueFrom(ledger.lastDecision?.marketDataSource);
  let history;
  try{history=await fetchHistory("1m",count,60,preferred);}
  catch(err){if(locked||!preferred)throw err;history=await fetchHistory("1m",count,60);}
  const cachePath=path.join(dataDir,"minute-history.json");
  const cache=readJson(cachePath,null,{strict:true});
  const rows=new Map((cache?.venue===history.venue?cache.candles:[]).map(c=>[c.t,c]));
  for(const candle of history.candles)rows.set(candle.t,candle);
  history.candles=[...rows.values()].sort((a,b)=>a.t-b.t).slice(-(POLICY.maxReplayMinutes+120));
  writeJson(cachePath,{venue:history.venue,updatedAt:nowIso(),candles:history.candles});
  return history;
}

async function makeDecision(feeds,minuteHistory){
  const venue=minuteHistory.venue;
  const cachePath=path.join(dataDir,"model-cache.json");
  const cached=readJson(cachePath,null,{strict:true});
  const lastHour=Math.floor(Date.now()/3600000)*3600000-3600000;
  let hourly=cached?.venue===venue?cached.candles:[];
  if(!hourly.length||hourly.at(-1).t<lastHour){
    const count=hourly.length?Math.min(5000,Math.max(3,Math.ceil((lastHour-hourly.at(-1).t)/3600000)+2)):5000;
    const recent=await fetchHistory("1h",count,Math.min(count,3),venue);
    const map=new Map(hourly.map(c=>[c.t,c]));
    for(const candle of recent.candles)map.set(candle.t,candle);
    hourly=[...map.values()].sort((a,b)=>a.t-b.t).slice(-5000);
  }
  if(hourly.length<700||hourly.at(-1).t<lastHour||hourly.some((c,i)=>i>0&&c.t!==hourly[i-1].t+3600000))throw new Error("Hourly model history is stale or incomplete");
  const {selected,warnings:feedWarnings}=selectModelFeeds(feeds,venue,hourly.at(-1).closedAt);
  const feedKey=JSON.stringify(Object.fromEntries(Object.entries(selected).map(([key,rows])=>[key,rows.at(-1)?.timestamp])));
  let analysis=cached?.strategyVersion===POLICY.strategyVersion&&cached.venue===venue&&cached.feedKey===feedKey&&cached.candles.at(-1).t===hourly.at(-1).t?cached.analysis:null;
  if(!analysis){
    loadModels();
    const main=globalThis.BTCPredictor.run(hourly,{feeRate:POLICY.feeRate,slippageRate:POLICY.slippageRate});
    let deriv=null,derivativeError=null;
    try{deriv=globalThis.BTCDerivatives.run(hourly,selected,{feeRate:POLICY.feeRate,slippageRate:POLICY.slippageRate});}
    catch(err){derivativeError=String(err.message||err);}
    analysis={main,deriv,derivativeError,feedWarnings,venue,generatedAt:nowIso(),modelAsOf:hourly.at(-1).closedAt,historyLength:hourly.length};
    writeJson(cachePath,{strategyVersion:POLICY.strategyVersion,venue,feedKey,candles:hourly,analysis});
  }
  writeJson(path.join(dataDir,"cloud-analysis.json"),analysis);
  writeText(path.join(dataDir,"cloud-analysis.js"),"window.BTCCloudAnalysis = "+JSON.stringify(analysis)+";\n");
  const market=analyzeMinuteCandles(minuteHistory.candles.slice(-120));
  return {
    ok:true,...deriveSignal(analysis.main,analysis.deriv),generatedAt:nowIso(),modelAsOf:analysis.modelAsOf,
    marketType:"USDT_M_BTC_PERPETUAL",marketDataSource:minuteHistory.source,venue,
    candleTs:market.candleTs,price:market.price,market,currentRegime:analysis.main.currentRegime,
    mainValidated:Object.fromEntries(Object.entries(analysis.main.horizons).map(([key,h])=>[key,Boolean(h.consensus?.validated)])),
    derivativesAvailable:Boolean(analysis.deriv?.available),feedWarnings
  };
}

export async function main(){
  const started=Date.now(),settings=loadSettings();
  const run={id:process.env.GITHUB_RUN_ID||"local",attempt:process.env.GITHUB_RUN_ATTEMPT||"1",
    event:process.env.GITHUB_EVENT_NAME||"local",codeRevision:process.env.GITHUB_SHA||"local"};
  const status={version:2,strategyVersion:POLICY.strategyVersion,lastRunAt:nowIso(),lastSuccessAt:null,
    lastError:null,collector:null,decision:null,run};
  let ledger=null;
  try{
    ledger=loadLedger(dataDir,settings);
    status.lastSuccessAt=ledger.lastSuccessAt;
    const minutes=await getMinutes(ledger);
    const collected=await collectDerivatives(minutes.venue);
    status.collector=collected.status;
    let decision=null;
    try{decision=await makeDecision(collected.payload.feeds,minutes);}
    catch(err){status.modelError=String(err.message||err);}
    status.decision=decision;
    ledger=processCycle(ledger,{candles:minutes.candles,decision,venue:minutes.venue,now:Date.now(),run,funding:collected.payload.feeds.funding},settings);
    if(status.modelError){ledger.health.status="degraded";ledger.health.modelError=status.modelError;}
    status.health=ledger.health;
    status.lastSuccessAt=ledger.lastSuccessAt;
    status.lastError=ledger.lastError||status.modelError;
    if(status.lastError)ledger.lastError=status.lastError;
    saveLedger(dataDir,ledger);
  }catch(err){
    status.lastError=String(err.message||err);
    if(ledger){
      ledger.lastRunAt=status.lastRunAt;ledger.lastError=status.lastError;
      ledger.health={...(ledger.health||{}),status:"error",lastAttemptAt:status.lastRunAt,error:status.lastError};
      status.health=ledger.health;saveLedger(dataDir,ledger);
    }
  }
  status.durationSeconds=(Date.now()-started)/1000;
  writeJson(CLOUD_STATUS_PATH,status);
  console.log(JSON.stringify({ok:!status.lastError,...status,decision:status.decision&&{signal:status.decision.signal,mode:status.decision.mode,venue:status.decision.venue}},null,2));
  if(status.lastError)process.exitCode=1;
  return status;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
