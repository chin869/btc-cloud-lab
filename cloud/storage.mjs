import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {POLICY} from "./risk_engine.mjs";
import {createLedger,validateAccount} from "./paper_engine.mjs";

export function readJson(file,fallback){
  if(!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
}
export function writeText(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+".tmp-"+process.pid;
  try{fs.writeFileSync(temp,value,"utf8");fs.renameSync(temp,file);}
  finally{if(fs.existsSync(temp)) fs.unlinkSync(temp);}
}
export function writeJson(file,value){writeText(file,JSON.stringify(value,null,2)+"\n");}

export function loadLedger(dataDir,settings,now=Date.now()){
  const file=path.join(dataDir,"auto-paper.json");
  const ledger=readJson(file,null);
  if(!ledger) return createLedger(settings,now);
  validateAccount(ledger.account);
  if(!Number.isInteger(ledger.version)||ledger.version>3) throw new Error("Unsupported ledger version: original preserved");
  if(ledger.version>=3) return ledger;
  const raw=fs.readFileSync(file);
  const hash=createHash("sha256").update(raw).digest("hex");
  const relative="archive/auto-paper-before-v3-"+hash.slice(0,12)+".json";
  const backup=path.join(dataDir,relative);
  fs.mkdirSync(path.dirname(backup),{recursive:true});
  if(!fs.existsSync(backup)) fs.writeFileSync(backup,raw,{flag:"wx"});
  if(createHash("sha256").update(fs.readFileSync(backup)).digest("hex")!==hash) throw new Error("Legacy archive checksum mismatch");
  ledger.migration={at:new Date(now).toISOString(),archive:"data/"+relative,sha256:hash,
    previousVersion:ledger.version,carriedCash:ledger.account.cash,legacyRealized:ledger.account.realizedPnl,
    legacyTradeEvents:ledger.account.trades.length,
    note:"原始帳本保留。沿用現金與持倉，舊績效未因升級而變可信；新版交易以 paper-v3 分開標記。"};
  ledger.version=3;
  ledger.strategyVersion=POLICY.strategyVersion;
  ledger.pendingEntry=null;ledger.pendingExit=null;ledger.decisions=[];ledger.runs=[];
  if(ledger.account.qty>0){
    const entry=ledger.account.trades.find(t=>String(t.side).startsWith("OPEN_"));
    const source=ledger.lastDecision?.marketDataSource||"";
    ledger.account.positionVenue=entry?.venue||(source.includes("OKX")?"OKX":source.includes("Binance")?"Binance":null);
    if(!ledger.account.positionVenue) throw new Error("Legacy open position venue is unknown; original preserved");
    ledger.account.positionId="legacy:"+(entry?.ts||ledger.account.positionOpenedAt);
    ledger.account.entryContext={mode:entry?.mode||"legacy",reason:entry?.reason,legacy:true};
    ledger.account.initialStopPrice=entry?.stopPrice||ledger.account.initialStopPrice||ledger.account.stopPrice;
  }
  return ledger;
}

export function saveLedger(dataDir,ledger){
  writeJson(path.join(dataDir,"auto-paper.json"),ledger);
  writeText(path.join(dataDir,"auto-paper.js"),"window.BTCAutoPaper = "+JSON.stringify(ledger)+";\n");
}
