import {POLICY,analyzeMinuteCandles,planPosition,evaluatePosition,unrealizedPnl} from "./risk_engine.mjs";

export const MINUTE=60000;
const iso=ms=>new Date(ms).toISOString();
const finite=n=>typeof n==="number"&&Number.isFinite(n);

export function validateAccount(account){
  if(!account) throw new Error("Missing account: original preserved");
  for(const key of ["cash","qty","avgEntry","realizedPnl"]){
    if(!finite(account[key])) throw new Error("Corrupt account."+key);
  }
  if(!Array.isArray(account.trades)||!Array.isArray(account.equityHistory)) throw new Error("Invalid ledger history");
  if(account.qty<0||account.qty===0&&account.positionSide) throw new Error("Invalid position state");
  if(account.qty>0){
    if(!["LONG","SHORT"].includes(account.positionSide)) throw new Error("Invalid position side");
    for(const key of ["avgEntry","stopPrice","takeProfitPrice","leverage"]){
      if(!finite(account[key])||account[key]<=0) throw new Error("Invalid active position."+key);
    }
    if(account.leverage>POLICY.maxLeverage||!finite(account.entryFee)||account.entryFee<0||!Number.isFinite(Date.parse(account.positionOpenedAt))) throw new Error("Invalid active position accounting");
  }
}

export function createLedger(settings={...POLICY,enabled:true,experimentalTrading:true},now=Date.now()){
  return {
    version:3,strategyVersion:POLICY.strategyVersion,createdAt:iso(now),lastProcessedCandleTs:0,
    lastRunAt:null,lastSuccessAt:null,lastError:null,lastDecision:null,settingsSnapshot:settings,
    pendingEntry:null,pendingExit:null,decisions:[],runs:[],
    account:{cash:settings.initialBalance,qty:0,avgEntry:0,realizedPnl:0,positionSide:null,
      leverage:1,marginUsed:0,entryFee:0,fundingPaid:0,fundingEvents:[],trades:[],equityHistory:[]}
  };
}

export function positionOf(account){
  if(!account.positionSide||!(account.qty>0)) return null;
  return {
    side:account.positionSide,qty:account.qty,entryPrice:account.avgEntry,
    stopPrice:account.stopPrice,initialStopPrice:account.initialStopPrice||account.stopPrice,
    takeProfitPrice:account.takeProfitPrice,entryFee:account.entryFee||0,
    leverage:account.leverage,marginUsed:account.marginUsed,openedAt:account.positionOpenedAt,
    highestPrice:account.highestPrice||account.avgEntry,lowestPrice:account.lowestPrice||account.avgEntry,
    venue:account.positionVenue,positionId:account.positionId,
    entryContext:account.entryContext||{},fundingPaid:account.positionFundingPaid||0
  };
}

export function validateCandles(candles,now){
  const unique=new Map();
  for(const c of candles||[]){
    if(![c.t,c.closedAt,c.open,c.high,c.low,c.close,c.volume].every(finite)) throw new Error("Invalid candle: non-finite value");
    if(c.t%MINUTE!==0||c.closedAt!==c.t+MINUTE-1||c.low<=0||c.volume<0||c.high<Math.max(c.open,c.close)||c.low>Math.min(c.open,c.close)) throw new Error("Invalid candle: OHLC/time range");
    if(c.closedAt>=now) continue;
    if(unique.has(c.t)&&JSON.stringify(unique.get(c.t))!==JSON.stringify(c)) throw new Error("Conflicting candles at "+c.t);
    unique.set(c.t,c);
  }
  return [...unique.values()].sort((a,b)=>a.t-b.t);
}

function clearPosition(a,exitAt){
  Object.assign(a,{qty:0,avgEntry:0,positionSide:null,leverage:1,marginUsed:0,stopPrice:0,
    initialStopPrice:0,takeProfitPrice:0,entryFee:0,riskAmount:0,positionOpenedAt:null,
    highestPrice:0,lowestPrice:0,positionFundingPaid:0,positionId:null,positionVenue:null,
    entryContext:null,lastExitAt:iso(exitAt)});
}

function recordEquity(ledger,c){
  const a=ledger.account;
  const point={ts:c.t,equity:a.cash+unrealizedPnl(positionOf(a),c.close),price:c.close,
    strategyVersion:POLICY.strategyVersion,valuation:"mark-to-market before hypothetical exit costs"};
  a.equityHistory=a.equityHistory.filter(p=>p.ts!==c.t);
  a.equityHistory.push(point);
  a.equityHistory=a.equityHistory.slice(-10000);
}

function closePosition(ledger,outcome,c,now,run){
  const a=ledger.account,p=positionOf(a),direction=p.side==="LONG"?1:-1;
  const fill=outcome.price*(1-direction*POLICY.slippageRate);
  const grossPnl=(fill-p.entryPrice)*p.qty*direction;
  const exitFee=p.qty*fill*POLICY.feeRate;
  const realized=grossPnl-p.entryFee-exitFee-p.fundingPaid;
  const effectiveAt=outcome.atOpen?c.t:c.closedAt;
  a.cash+=grossPnl-exitFee;
  a.realizedPnl+=realized;
  a.trades.unshift({
    id:p.positionId+":close",positionId:p.positionId,ts:iso(effectiveAt),recordedAt:iso(now),
    candleTs:c.t,side:"CLOSE_"+p.side,qty:p.qty,fill,quotePrice:outcome.price,
    fee:exitFee,entryFee:p.entryFee,fundingPaid:p.fundingPaid,grossPnl,realized,
    leverage:p.leverage,mode:p.entryContext.mode||"legacy",entryContext:p.entryContext,
    exitContext:{reason:outcome.reason,executionAssumption:outcome.executionAssumption||"closed candle decision",
      ambiguous:Boolean(outcome.ambiguous),run},
    reason:outcome.reason,venue:p.venue,strategyVersion:POLICY.strategyVersion,
    execution:"delayed-paper-replay",marketType:POLICY.marketType,
    source:"AUTO-CLOUD-USDT-M-1M",slippageRate:POLICY.slippageRate
  });
  clearPosition(a,effectiveAt);
  ledger.pendingExit=null;
}

function settleFunding(ledger,c,rates,now){
  const a=ledger.account,p=positionOf(a);
  if(!p) return;
  a.fundingEvents??=[];
  const known=new Set(a.fundingEvents.map(e=>e.id));
  for(const row of rates||[]){
    const at=Number(row.fundingTime??row.timestamp),rate=Number(row.fundingRate);
    if(row.venue!==p.venue||!finite(rate)||at!==c.t||at<=Date.parse(p.openedAt)) continue;
    const id=p.positionId+":funding:"+at;
    if(known.has(id)) continue;
    // Public settlement rate, with the matching minute open as a disclosed price proxy.
    const paid=p.qty*c.open*rate*(p.side==="LONG"?1:-1);
    a.cash-=paid;
    a.fundingPaid=(a.fundingPaid||0)+paid;
    a.positionFundingPaid=(a.positionFundingPaid||0)+paid;
    a.fundingEvents.push({id,ts:iso(at),recordedAt:iso(now),paid,rate,price:c.open,venue:p.venue,priceMethod:"minute-open proxy, not exchange mark"});
    known.add(id);
  }
}

/** Pure transaction: failure never partially writes a ledger. No retrospective new signals. */
export function processCycle(input,{candles:rawCandles,decision=null,venue,now=Date.now(),run={},funding=[]},settings={...POLICY,enabled:true,experimentalTrading:true}){
  const ledger=structuredClone(input||createLedger(settings,now));
  const a=ledger.account;
  validateAccount(a);
  if(!Number.isInteger(ledger.lastProcessedCandleTs)||ledger.lastProcessedCandleTs<0||ledger.lastProcessedCandleTs%MINUTE!==0) throw new Error("Invalid replay cursor");
  const previousRun=Date.parse(ledger.lastRunAt);
  const previousCursor=Number(ledger.lastProcessedCandleTs)||0;
  const candles=validateCandles(rawCandles,now),latest=candles.at(-1);
  if(!latest) throw new Error("No closed minute candles");
  ledger.settingsSnapshot=settings;
  ledger.lastRunAt=iso(now);
  ledger.lastError=null;
  ledger.decisions??=[];
  ledger.runs??=[];
  a.fundingEvents??=[];
  let cursor=previousCursor,processed=0,gap=null;
  const expectedVenue=a.positionVenue||ledger.pendingEntry?.venue;
  if(expectedVenue&&expectedVenue!==venue) throw new Error("Cannot switch venue while a position/order exists");
  if(ledger.pendingEntry&&!settings.enabled) ledger.pendingEntry=null;
  let required=positionOf(a)?cursor+MINUTE:ledger.pendingEntry?.entryAt;
  if(required){
    const unseen=candles.filter(c=>c.t>=required);
    for(const c of unseen){
      if(c.t<=cursor) continue;
      if((positionOf(a)||ledger.pendingEntry)&&c.t!==required){
        gap={from:required,to:c.t-MINUTE,reason:"missing-minute-candles"};break;
      }
      const index=candles.findIndex(row=>row.t===c.t);
      const context=candles.slice(Math.max(0,index-119),index+1);
      if(positionOf(a)||ledger.pendingEntry){
        if(context.length<60||context.some((v,i)=>i>0&&v.t!==context[i-1].t+MINUTE)){
          gap={from:Math.max(0,c.t-119*MINUTE),to:c.t,reason:"incomplete-indicator-context"};break;
        }
      }
      const market=context.length>=60?analyzeMinuteCandles(context):null;
      if(ledger.pendingEntry&&c.t===ledger.pendingEntry.entryAt){
        const pending=ledger.pendingEntry;
        if(Date.parse(pending.createdAt)>c.t||Date.parse(pending.decision.generatedAt)>c.t) throw new Error("Future signal cannot open a historical order");
        const lastExit=Date.parse(a.lastExitAt);
        const allowed=settings.enabled&&(pending.decision.mode!=="experimental-unvalidated"||settings.experimentalTrading)&&
          (!Number.isFinite(lastExit)||c.t-lastExit>=POLICY.cooldownMinutes*MINUTE);
        const plan=allowed?planPosition(a.cash,pending.decision,{...pending.market,price:c.open}):null;
        ledger.pendingEntry=null;
        if(plan&&plan.notional>=5){
          const positionId=pending.id;
          const entryContext={...pending.decision,signalCreatedAt:pending.createdAt,run:pending.run,plan};
          a.cash-=plan.entryFee;
          Object.assign(a,{qty:plan.qty,avgEntry:plan.entryPrice,positionSide:plan.side,leverage:plan.leverage,
            marginUsed:plan.marginUsed,stopPrice:plan.stopPrice,initialStopPrice:plan.stopPrice,
            takeProfitPrice:plan.takeProfitPrice,entryFee:plan.entryFee,riskAmount:plan.riskAmount,
            estimatedStopLoss:plan.estimatedStopLoss,estimatedTakeProfit:plan.estimatedTakeProfit,
            netRewardRisk:plan.netRewardRisk,positionOpenedAt:iso(c.t),highestPrice:plan.entryPrice,
            lowestPrice:plan.entryPrice,positionVenue:venue,positionId,entryContext,positionFundingPaid:0});
          a.trades.unshift({id:positionId+":open",positionId,ts:iso(c.t),recordedAt:iso(now),candleTs:c.t,
            ...plan,side:"OPEN_"+plan.side,qty:plan.qty,fill:plan.entryPrice,quotePrice:c.open,fee:plan.entryFee,
            realized:0,mode:pending.decision.mode,entryContext,venue,
            strategyVersion:POLICY.strategyVersion,marketType:POLICY.marketType,source:"AUTO-CLOUD-USDT-M-1M",
            execution:"pre-recorded signal, next complete minute open",reason:pending.decision.reason});
        }
      }
      if(positionOf(a)){
        settleFunding(ledger,c,funding,now);
        const exit=ledger.pendingExit;
        let outcome;
        if(exit&&exit.entryAt<=c.t){
          if(Date.parse(exit.createdAt)>c.t) throw new Error("Future model exit");
          outcome={action:"CLOSE",price:c.open,atOpen:true,reason:exit.reason,executionAssumption:"previously recorded model reversal, next minute open"};
        }else{
          outcome=evaluatePosition(positionOf(a),{signal:"HOLD",confidence:0},market,c.closedAt);
        }
        if(outcome.action==="CLOSE") closePosition(ledger,outcome,c,now,run);
        else Object.assign(a,{stopPrice:outcome.position.stopPrice,highestPrice:outcome.position.highestPrice,lowestPrice:outcome.position.lowestPrice});
      }
      cursor=c.t;required=cursor+MINUTE;processed++;
      recordEquity(ledger,c);
    }
    if((positionOf(a)||ledger.pendingEntry)&&required<=latest.t&&cursor<latest.t&&!gap){
      gap={from:required,to:latest.t,reason:"requested-history-unavailable"};
    }
  }
  // With no historical exposure, there are no trades to invent during the gap.
  if(!gap&&!positionOf(a)&&!ledger.pendingEntry) cursor=Math.max(cursor,latest.t);
  const ageMinutes=(now-latest.closedAt)/MINUTE;
  const recent=candles.slice(-120);
  const indicatorContextComplete=recent.length>=60&&recent.every((c,i)=>i===0||c.t===recent[i-1].t+MINUTE);
  const signalFresh=indicatorContextComplete&&decision&&Number.isFinite(Date.parse(decision.generatedAt))&&
    finite(decision.modelAsOf)&&decision.modelAsOf<=latest.closedAt&&now-decision.modelAsOf<=2*3600000&&
    Date.parse(decision.generatedAt)<=now&&now-Date.parse(decision.generatedAt)<=POLICY.maxQuoteAgeMinutes*MINUTE&&
    decision.candleTs===latest.t&&decision.venue===venue&&ageMinutes<=POLICY.maxQuoteAgeMinutes;
  const decisionAlreadySeen=decision&&ledger.decisions.some(d=>d.candleTs===decision.candleTs&&d.venue===venue&&d.strategyVersion===POLICY.strategyVersion);
  const entryAt=(Math.floor(now/MINUTE)+1)*MINUTE;
  let action="HOLD",reason=decision?.reason||"本輪只補查持倉；尚無新模型決策";
  if(!gap&&signalFresh&&!decisionAlreadySeen){
    if(positionOf(a)){
      const opposite=a.positionSide==="LONG"&&decision.signal==="SELL"||a.positionSide==="SHORT"&&decision.signal==="BUY";
      if(opposite&&decision.confidence>=55&&!ledger.pendingExit){
        ledger.pendingExit={entryAt,createdAt:iso(now),reason:"Previously recorded model direction reversed",decision};
        action="PENDING_EXIT";
      }
    }else if(settings.enabled&&!ledger.pendingEntry&&["BUY","SELL"].includes(decision.signal)){
      const lastExit=Date.parse(a.lastExitAt);
      const cooled=!Number.isFinite(lastExit)||now-lastExit>=POLICY.cooldownMinutes*MINUTE;
      if(cooled&&(decision.mode!=="experimental-unvalidated"||settings.experimentalTrading)){
        const market=analyzeMinuteCandles(candles.slice(-120));
        ledger.pendingEntry={id:POLICY.strategyVersion+":"+venue+":"+latest.t,entryAt,createdAt:iso(now),venue,decision,market,run};
        action="PENDING_ENTRY";
        reason+="；訊號已保存，下一個完整分鐘開盤模擬成交，於下次執行補算。";
      }else reason=cooled?"研究交易已停用":"平倉後冷卻 30 分鐘";
    }
    ledger.decisions.push({...decision,recordedAt:iso(now),strategyVersion:POLICY.strategyVersion,run,action,reason});
    ledger.decisions=ledger.decisions.slice(-2000);
  }
  if(gap){action="BLOCKED";reason="分鐘資料有缺口，已停止於缺口前；禁止新進場，等待補齊。";}
  else if(ageMinutes>POLICY.maxQuoteAgeMinutes||!indicatorContextComplete){action="STALE";reason="行情已過期或近期分鐘資料不完整；未建立新單。";}
  else if(!settings.enabled){action="DISABLED";reason="已暫停新進場；現有持倉仍補查風控。";}
  else if(ledger.pendingEntry&&action==="HOLD") action="PENDING_ENTRY";
  ledger.lastProcessedCandleTs=cursor;
  ledger.lastDecision={...(decision||ledger.lastDecision||{}),at:iso(now),executed:action,reason,venue,
    price:latest.close,candleTs:latest.t,marketDataSource:venue+" USDT-M perpetual"};
  ledger.health={status:gap?"blocked":ageMinutes>POLICY.maxQuoteAgeMinutes||!indicatorContextComplete?"stale":"ok",
    lastAttemptAt:iso(now),lastCheckedCandleAt:iso(cursor+MINUTE-1),quoteAt:iso(latest.closedAt),
    intervalMinutes:Number.isFinite(previousRun)?(now-previousRun)/MINUTE:null,
    expectedIntervalMinutes:POLICY.expectedIntervalMinutes,processedMinutes:processed,gap,
    venue,indicatorContextComplete,execution:"delayed-paper-replay",fundingModel:"public rate × minute-open proxy; funding history coverage not guaranteed",
    limitations:["非即時交易；排程不保證準點","資金費以公開費率估算，覆蓋可能不完整","尚未模擬維持保證金與交易所強平"]};
  if(!gap&&ageMinutes<=POLICY.maxQuoteAgeMinutes&&indicatorContextComplete) ledger.lastSuccessAt=iso(now);
  if(gap) ledger.lastError=reason+" "+JSON.stringify(gap);
  ledger.runs.push({at:iso(now),...run,...ledger.health});
  ledger.runs=ledger.runs.slice(-288);
  ledger.totalRuns=(ledger.totalRuns||0)+1;
  ledger.updatedAt=iso(now);
  if(!gap) recordEquity(ledger,latest);
  return ledger;
}
