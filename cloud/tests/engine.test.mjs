import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {POLICY,planPosition,evaluatePosition} from "../risk_engine.mjs";
import {processCycle,createLedger,MINUTE} from "../paper_engine.mjs";
import {deriveSignal} from "../signal.mjs";
import {selectModelFeeds} from "../model_feeds.mjs";
import {loadLedger,saveLedger} from "../storage.mjs";
const require=createRequire(import.meta.url),report=require("../../paper-report.js");
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
const settings={...POLICY,enabled:true,experimentalTrading:true};
const base=Date.UTC(2026,9,19),bar=(t,overrides={})=>({t,closedAt:t+MINUTE-1,open:100,high:100.01,low:99.99,close:100,volume:100,...overrides});
const series=(end=base,count=120)=>Array.from({length:count},(_,i)=>bar(end-(count-1-i)*MINUTE));
const modelDecision=(candleTs=base,overrides={})=>({generatedAt:new Date(candleTs+MINUTE+1000).toISOString(),modelAsOf:candleTs,candleTs,venue:"OKX",signal:"BUY",mode:"validated",confidence:60,probabilityUp:0.56,reason:"Test existing signal",evidence:{supportingVotes:1,supportingHorizons:1},...overrides});
function held(side="LONG"){
  const ledger=createLedger(settings,base);
  Object.assign(ledger.account,{qty:1,avgEntry:100,positionSide:side,stopPrice:side==="LONG"?99:101,
    initialStopPrice:side==="LONG"?99:101,takeProfitPrice:side==="LONG"?102:98,entryFee:0.1,cash:499.9,
    positionOpenedAt:new Date(base-60*MINUTE).toISOString(),positionVenue:"OKX",positionId:"test-position",
    entryContext:{mode:"validated"},leverage:2,marginUsed:50});
  ledger.lastProcessedCandleTs=base-MINUTE;return ledger;
}
function cycle(ledger,candles,overrides={}){
  return processCycle(ledger,{candles,venue:"OKX",now:candles.at(-1).closedAt+1001,...overrides},settings);
}

test("missed stop is detected inside a gap even if the newest candle recovered",()=>{
  const candles=series();candles.push(bar(base+MINUTE,{low:98.5,open:100,close:99.5}));
  candles.push(bar(base+2*MINUTE));
  const ledger=cycle(held(),candles);
  assert.equal(ledger.account.qty,0);
  assert.equal(ledger.account.trades.length,1);
  assert.equal(ledger.account.trades[0].candleTs,base+MINUTE);
  assert.ok(ledger.account.trades[0].realized<0);
});

test("processing the same data twice cannot trade or charge twice",()=>{
  const candles=series();candles.at(-1).low=98;
  const first=cycle(held(),candles),second=cycle(first,candles);
  assert.deepEqual(second.account.trades,first.account.trades);
  assert.equal(second.account.cash,first.account.cash);
});

test("a missing minute freezes the cursor and forbids new entries; complete retry recovers",()=>{
  const candles=series();candles.push(bar(base+2*MINUTE,{low:98}));
  const first=cycle(held(),candles,{decision:modelDecision(base+2*MINUTE)});
  assert.equal(first.health.status,"blocked");assert.equal(first.lastProcessedCandleTs,base);
  assert.equal(first.pendingEntry,null);assert.equal(first.account.qty,1);
  const complete=[...candles,bar(base+MINUTE)].sort((a,b)=>a.t-b.t);
  const fixed=cycle(first,complete);assert.equal(fixed.account.qty,0);assert.equal(fixed.health.gap,null);
});

test("gap through a stop fills at the available open, never the unreachable stop",()=>{
  const p={side:"LONG",entryPrice:100,stopPrice:99,takeProfitPrice:102};
  const result=evaluatePosition(p,{signal:"HOLD"},{open:96,high:97,low:95,price:96},base);
  assert.equal(result.price,96);assert.equal(result.atOpen,true);
  const short=evaluatePosition({...p,side:"SHORT",stopPrice:101,takeProfitPrice:98},{signal:"HOLD"},{open:105,high:106,low:104,price:105},base);
  assert.equal(short.price,105);
});

test("unknown intraminute ordering uses the adverse protective exit",()=>{
  const p={side:"LONG",entryPrice:100,stopPrice:99,takeProfitPrice:102};
  const result=evaluatePosition(p,{signal:"HOLD"},{open:100,high:103,low:98,price:101},base);
  assert.equal(result.price,99);assert.equal(result.ambiguous,true);
});

test("a new signal is recorded before the future minute, not backfilled into past bars",()=>{
  const first=cycle(createLedger(settings,base),series(),{decision:modelDecision()});
  assert.equal(first.account.trades.length,0);
  assert.equal(first.pendingEntry.entryAt,base+2*MINUTE);
  const future=[...series(),bar(base+MINUTE),bar(base+2*MINUTE)];
  const second=cycle(first,future);
  assert.equal(second.account.trades[0].side,"OPEN_LONG");
  assert.equal(Date.parse(second.account.trades[0].ts),base+2*MINUTE);
  assert.ok(Date.parse(second.account.trades[0].entryContext.signalCreatedAt)<Date.parse(second.account.trades[0].ts));
});

test("recent model reversal cannot be applied to older candles",()=>{
  const candles=series(base+10*MINUTE,130);
  const ledger=cycle(held(),candles,{decision:modelDecision(base+10*MINUTE,{signal:"SELL"})});
  assert.equal(ledger.account.qty,1);assert.equal(ledger.account.trades.length,0);
  assert.ok(ledger.pendingExit.entryAt>candles.at(-1).closedAt);
});

test("stale prices and invalid input cannot create an order or mutate original account",()=>{
  const original=createLedger(settings,base),before=JSON.stringify(original);
  const stale=cycle(original,series(),{now:base+20*MINUTE,decision:modelDecision()});
  assert.equal(stale.pendingEntry,null);assert.equal(stale.health.status,"stale");
  const invalid=series();invalid.at(-1).low=-1;
  assert.throws(()=>cycle(original,invalid),/Invalid candle/);
  assert.equal(JSON.stringify(original),before);
});

test("incomplete indicator history also blocks entry while flat",()=>{
  const candles=series().filter(c=>c.t!==base-3*MINUTE);
  const ledger=cycle(createLedger(settings,base),candles,{decision:modelDecision()});
  assert.equal(ledger.pendingEntry,null);assert.equal(ledger.health.status,"stale");
});

test("future and expired hourly models cannot create a fresh order",()=>{
  for(const modelAsOf of [base+2*MINUTE,base-3*3600000]){
    const result=cycle(createLedger(settings,base),series(),{decision:modelDecision(base,{modelAsOf})});
    assert.equal(result.pendingEntry,null);
  }
});

test("invalid active position protection fails without mutating the account",()=>{
  const ledger=held();ledger.account.stopPrice=null;
  const before=JSON.stringify(ledger);
  assert.throws(()=>cycle(ledger,series()),/Invalid active position/);
  assert.equal(JSON.stringify(ledger),before);
});

test("derivative models reject future, stale and different-venue observations",()=>{
  const feeds={openInterest:[{venue:"OKX",timestamp:base-3*3600000},{venue:"Binance",timestamp:base}],
    taker:[{venue:"OKX",timestamp:base-MINUTE},{venue:"OKX",timestamp:base+MINUTE}],
    funding:[{venue:"OKX",fundingTime:base-8*3600000}]};
  const {selected,warnings}=selectModelFeeds(feeds,"OKX",base);
  assert.equal(selected.openInterest.length,0);assert.equal(selected.taker.length,1);
  assert.equal(selected.taker[0].timestamp,base-MINUTE);assert.equal(selected.funding.length,1);
  assert.equal(warnings.length,2);
});

test("single passed horizon is not upgraded to an 85 percent win probability or 10x",()=>{
  const h={models:[{current:{probabilityUp:0.56}}],consensus:{validated:true,action:"LONG"}};
  const decision=deriveSignal({horizons:{"24h":h}},null);
  assert.ok(Math.abs(decision.probabilityUp-0.56)<1e-9);assert.ok(decision.confidence<=60);
  const plan=planPosition(500,decision,{price:100,atrPct:0.001});
  assert.equal(plan.leverage,2);assert.equal(decision.evidence.supportingHorizons,1);
});

test("long and short position sizes include entry/exit fees and modeled exit slippage",()=>{
  for(const signal of ["BUY","SELL"]){
    const plan=planPosition(500,{...modelDecision(),signal},{price:100,atrPct:0.001});
    assert.ok(plan.estimatedStopLoss<=plan.riskAmount+1e-9);
    assert.ok(plan.marginUsed<=(500-plan.entryFee)*0.25+1e-9);
    assert.equal(plan.takePct/plan.stopPct,2);
    const direction=signal==="BUY"?1:-1,exit=plan.stopPrice*(1-direction*POLICY.slippageRate);
    const loss=-(exit-plan.entryPrice)*plan.qty*direction+plan.entryFee+exit*plan.qty*POLICY.feeRate;
    assert.ok(Math.abs(loss-plan.estimatedStopLoss)<1e-9);
    assert.ok(plan.leverage<=10);
  }
});

test("paper cash reconciles through an actual long and short lifecycle",()=>{
  for(const signal of ["BUY","SELL"]){
    const first=cycle(createLedger(settings,base),series(),{decision:modelDecision(base,{signal})});
    const bars=[...series(),bar(base+MINUTE),bar(base+2*MINUTE),bar(base+3*MINUTE,signal==="BUY"?{low:98}:{high:102})];
    const second=cycle(first,bars);
    assert.equal(second.account.trades.length,2);
    assert.equal(second.account.qty,0);
    assert.ok(Math.abs(second.account.cash-500-second.account.realizedPnl)<1e-9);
    assert.equal(report.segments(second)[1].closes,1);
  }
});

test("funding settles once, with recorded source and price assumption",()=>{
  const ledger=held(),candles=series(),funding=[{venue:"OKX",fundingTime:base,fundingRate:0.001}];
  const first=cycle(ledger,candles,{funding}),second=cycle(first,candles,{funding});
  assert.equal(first.account.fundingEvents.length,1);assert.equal(second.account.fundingEvents.length,1);
  assert.ok(Math.abs(first.account.cash-499.8)<1e-9);assert.equal(second.account.cash,first.account.cash);
});

test("a venue outage cannot silently move an open position onto another exchange",()=>{
  assert.throws(()=>cycle(held(),series(),{venue:"Binance"}),/Cannot switch venue/);
});

test("holding limits and cooldown use historical event time",()=>{
  const ledger=held();ledger.account.positionOpenedAt=new Date(base-49*3600000).toISOString();
  const result=cycle(ledger,series(),{decision:modelDecision()});
  assert.equal(result.account.qty,0);assert.equal(result.pendingEntry,null);
  assert.match(result.account.trades[0].reason,/Maximum holding/);
});

test("disabled entries still protect an existing position",()=>{
  const candles=series();candles.at(-1).low=98;
  const result=processCycle(held(),{candles,venue:"OKX",now:base+MINUTE+1000}, {...settings,enabled:false});
  assert.equal(result.account.qty,0);assert.equal(result.pendingEntry,null);
});

test("Taipei monthly totals recognize futures closes across UTC month boundary",()=>{
  const ledger=createLedger(settings,base);ledger.account.trades=[
    {side:"OPEN_SHORT",ts:"2026-09-30T16:00:00Z",realized:0,fee:1},
    {side:"CLOSE_SHORT",ts:"2026-09-30T16:01:00Z",realized:5,fee:1},
    {side:"CLOSE_LONG",ts:"2026-10-01T00:00:00Z",realized:-2,fee:1},
    {side:"CLOSE_LONG",ts:"2026-09-30T15:59:00Z",realized:100,fee:1}];
  const perf=report.monthly(ledger,new Date("2026-10-15T00:00:00Z"));
  assert.equal(perf.closes.length,2);assert.equal(perf.realized,3);assert.equal(perf.fees,3);
  assert.equal(perf.daily.at(-1).value,3);
});

test("health becomes stale even with enabled flag and no prior error",()=>{
  const ledger=createLedger(settings,base);ledger.lastSuccessAt=new Date(base).toISOString();
  assert.equal(report.health(ledger,null,base+16*MINUTE).label,"雲端檢查已延遲");
});

test("migration saves immutable original, carries balance and is idempotent",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"btc-v3-test-"));
  const original={...createLedger(settings,base),version:2};original.account.cash=513.45;original.account.realizedPnl=13.45;
  saveLedger(dir,original);
  const bytes=fs.readFileSync(path.join(dir,"auto-paper.json"));
  const migrated=loadLedger(dir,settings,base);
  assert.equal(migrated.account.cash,513.45);
  const archive=path.join(dir,migrated.migration.archive.replace(/^data\//,""));
  assert.deepEqual(fs.readFileSync(archive),bytes);
  saveLedger(dir,migrated);
  assert.deepEqual(loadLedger(dir,settings,base).migration,migrated.migration);
});

test("corrupt persisted ledger fails closed without replacing its bytes",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"btc-v3-corrupt-"));
  const file=path.join(dir,"auto-paper.json");fs.writeFileSync(file,"broken");
  assert.throws(()=>loadLedger(dir,settings,base));assert.equal(fs.readFileSync(file,"utf8"),"broken");
});

test("2026-10-19 03:33 Taipei public candle crosses the original stop",()=>{
  const fixture=JSON.parse(fs.readFileSync(path.join(root,"cloud/tests/fixtures/oct19-stop.json"),"utf8"));
  const outcome=evaluatePosition(fixture.position,{signal:"HOLD"},fixture.market,fixture.at);
  assert.equal(outcome.action,"CLOSE");assert.match(outcome.reason,/stop/i);
  assert.ok(outcome.price<=fixture.position.stopPrice);
});
