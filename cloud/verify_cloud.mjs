import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename=fileURLToPath(import.meta.url);
const root=path.resolve(path.dirname(__filename),"..");

function fail(message){throw new Error(message);}
function read(relative){return fs.readFileSync(path.join(root,relative),"utf8").replace(/^\uFEFF/,"");}
function json(relative){
  try{return JSON.parse(read(relative));}
  catch(err){fail(relative+" is not valid JSON: "+String(err&&err.message||err));}
}
function expect(condition,message){if(!condition) fail(message);}

const required=[
  "index.html","style.css","app.js","predictor.js","derivatives.js",
  "cloud/cloud_cycle.mjs","cloud/build_site.mjs",
  "data/auto-paper-settings.json","data/auto-paper.json",
  "data/auto-paper.js","data/derivatives-history.json","data/derivatives-history.js",
  ".github/workflows/cloud-paper.yml"
];
for(const relative of required){
  expect(fs.existsSync(path.join(root,relative)),"Missing required file: "+relative);
}

const settings=json("data/auto-paper-settings.json");
const expectedRisk={
  initialBalance:500,
  maxLeverage:10,
  maxMarginPct:0.25,
  minRiskPct:0.005,
  maxRiskPct:0.0125,
  rewardRiskRatio:2,
  feeRate:0.001,
  slippageRate:0.0005,
  maxHoldHours:48
};
expect(settings.symbol==="BTCUSDT"&&settings.marketType==="USDT_M_PERPETUAL","AUTO PAPER is not configured for BTCUSDT USDT-M perpetual futures");
for(const [key,value] of Object.entries(expectedRisk)){
  expect(Number(settings[key])===value,"Unexpected risk setting "+key+"; expected "+value);
}

const ledger=json("data/auto-paper.json");
expect(ledger&&ledger.account,"data/auto-paper.json is missing account data");
for(const key of ["cash","qty","avgEntry","realizedPnl"]){
  expect(Number.isFinite(Number(ledger.account[key])),"Ledger field is not numeric: account."+key);
}
expect(Number(ledger.account.qty)>=0,"AUTO PAPER cannot hold a negative BTC quantity");
expect(Number(ledger.account.leverage||1)<=10,"Ledger leverage exceeded 10x");
expect(Array.isArray(ledger.account.trades),"Ledger trades must be an array");
expect(Array.isArray(ledger.account.equityHistory),"Ledger equityHistory must be an array");

const modelContext={window:{}};
vm.createContext(modelContext);
vm.runInContext(read("predictor.js"),modelContext,{filename:"predictor.js"});
vm.runInContext(read("derivatives.js"),modelContext,{filename:"derivatives.js"});
expect(modelContext.window.BTCPredictor&&typeof modelContext.window.BTCPredictor.run==="function","predictor.js did not expose BTCPredictor.run");
expect(modelContext.window.BTCDerivatives&&typeof modelContext.window.BTCDerivatives.run==="function","derivatives.js did not expose BTCDerivatives.run");

const cycle=read("cloud/cloud_cycle.mjs");
expect(cycle.includes("BTCPredictor.run")&&cycle.includes("BTCDerivatives.run"),"Cloud cycle is not using both existing model modules");
expect(cycle.includes("fapi.binance.com")&&cycle.includes("/fapi/v1/klines"),"Primary cloud futures market endpoint is missing");
expect(cycle.includes("www.okx.com")&&cycle.includes("BTC-USDT-SWAP"),"Cloud futures fallback endpoint is missing");
expect(!cycle.includes("/api/v3/klines")&&!cycle.includes("data-api.binance.vision"),"Cloud AUTO PAPER must not use spot candles");
expect(cycle.includes('marketType:"USDT_M_BTC_PERPETUAL"'),"Cloud decision does not identify the USDT-M BTC perpetual market");
expect(cycle.includes('fetchHistory("1m"'),"Cloud cycle is not using closed 1m candles for risk monitoring");
for(const forbidden of ["X-MBX-APIKEY","/api/v3/order","/fapi/v1/order","method:\"POST\"","method:'POST'"]){
  expect(!cycle.includes(forbidden),"Cloud cycle contains a forbidden trading/API-key marker: "+forbidden);
}

const workflow=read(".github/workflows/cloud-paper.yml");
for(const marker of ["schedule:","workflow_dispatch:","actions/upload-pages-artifact@v4","actions/deploy-pages@v4","contents: write","pages: write","id-token: write"]){
  expect(workflow.includes(marker),"Workflow is missing: "+marker);
}

const siteBuilder=read("cloud/build_site.mjs");
expect(siteBuilder.includes('window.BTCCloudMode="usdt-m-futures"'),"Cloud site does not enable futures market mode");

console.log("Cloud verification passed: USDT-M futures public data only, PAPER-only ledger, fixed risk limits, models and Pages workflow present.");
