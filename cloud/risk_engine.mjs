export const POLICY=Object.freeze({
  symbol:"BTCUSDT",
  marketType:"USDT_M_PERPETUAL",
  initialBalance:500,
  maxLeverage:10,
  maxMarginPct:0.25,
  minRiskPct:0.005,
  maxRiskPct:0.0125,
  minStopPct:0.004,
  maxStopPct:0.020,
  rewardRiskRatio:2,
  feeRate:0.001,
  slippageRate:0.0005,
  maxHoldHours:48,
  cooldownMinutes:30
});

const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
const mean=values=>values.length?values.reduce((a,b)=>a+b,0)/values.length:NaN;

function ema(values,period){
  if(!values.length) return NaN;
  const alpha=2/(period+1);
  let value=values[0];
  for(let i=1;i<values.length;i++) value=alpha*values[i]+(1-alpha)*value;
  return value;
}

function rsi(values,period=14){
  if(values.length<=period) return NaN;
  let gains=0,losses=0;
  for(let i=values.length-period;i<values.length;i++){
    const delta=values[i]-values[i-1];
    if(delta>=0) gains+=delta;
    else losses-=delta;
  }
  if(losses===0) return 100;
  const rs=(gains/period)/(losses/period);
  return 100-100/(1+rs);
}

function atr(candles,period=14){
  if(candles.length<=period) return NaN;
  const rows=candles.slice(-(period+1));
  const ranges=[];
  for(let i=1;i<rows.length;i++){
    ranges.push(Math.max(
      rows[i].high-rows[i].low,
      Math.abs(rows[i].high-rows[i-1].close),
      Math.abs(rows[i].low-rows[i-1].close)
    ));
  }
  return mean(ranges);
}

export function analyzeMinuteCandles(candles){
  if(!Array.isArray(candles)||candles.length<60) throw new Error("1m candles are insufficient for adaptive risk controls");
  const closed=candles.filter(c=>Number.isFinite(Number(c.close)));
  const last=closed[closed.length-1];
  const closes=closed.slice(-120).map(c=>Number(c.close));
  const atrValue=atr(closed,14);
  const price=Number(last.close);
  return {
    candleTs:Number(last.t),
    closedAt:Number(last.closedAt),
    price,
    high:Number(last.high),
    low:Number(last.low),
    atr:Number.isFinite(atrValue)?atrValue:price*0.003,
    atrPct:Number.isFinite(atrValue)?atrValue/price:0.003,
    rsi:rsi(closes,14),
    emaFast:ema(closes.slice(-60),9),
    emaSlow:ema(closes.slice(-90),21),
    momentum5:closes.length>5?price/closes[closes.length-6]-1:0,
    volumeRatio:mean(closed.slice(-5).map(c=>Number(c.volume)))/Math.max(1e-9,mean(closed.slice(-30).map(c=>Number(c.volume))))
  };
}

export function planPosition(equity,decision,market){
  const side=decision.signal==="BUY"?"LONG":decision.signal==="SELL"?"SHORT":null;
  if(!side||!Number.isFinite(equity)||equity<=0) return null;
  const confidence=clamp(Number(decision.confidence)||50,50,90);
  let leverage=confidence>=78?8:confidence>=70?6:confidence>=62?4:2;
  if(decision.mode==="validated") leverage+=2;
  if(market.atrPct>=0.012) leverage=Math.min(leverage,3);
  else if(market.atrPct>=0.008) leverage=Math.min(leverage,5);
  leverage=clamp(Math.round(leverage),1,POLICY.maxLeverage);

  const stopPct=clamp(market.atrPct*2.2,POLICY.minStopPct,POLICY.maxStopPct);
  const riskPct=clamp(0.005+(confidence-50)/3200+(decision.mode==="validated"?0.0025:0),POLICY.minRiskPct,POLICY.maxRiskPct);
  const riskAmount=equity*riskPct;
  const notionalByRisk=riskAmount/stopPct;
  const notionalByMargin=equity*POLICY.maxMarginPct*leverage;
  const notional=Math.max(0,Math.min(notionalByRisk,notionalByMargin));
  const entryPrice=Number(market.price);
  const qty=notional/entryPrice;
  const takePct=stopPct*POLICY.rewardRiskRatio;
  return {
    side,leverage,notional,qty,riskAmount,riskPct,stopPct,takePct,
    marginUsed:notional/leverage,
    stopPrice:side==="LONG"?entryPrice*(1-stopPct):entryPrice*(1+stopPct),
    takeProfitPrice:side==="LONG"?entryPrice*(1+takePct):entryPrice*(1-takePct)
  };
}

export function unrealizedPnl(position,price){
  if(!position||!Number.isFinite(Number(price))) return 0;
  const direction=position.side==="SHORT"?-1:1;
  return (Number(price)-Number(position.entryPrice))*Number(position.qty)*direction;
}

export function evaluatePosition(position,decision,market,nowMs=Date.now()){
  if(!position) return {action:"HOLD",position:null};
  const side=position.side;
  const stop=Number(position.stopPrice);
  const take=Number(position.takeProfitPrice);
  const high=Number(market.high),low=Number(market.low),price=Number(market.price);
  const opened=Date.parse(position.openedAt);
  const heldHours=Number.isFinite(opened)?(nowMs-opened)/3600000:0;

  if(side==="LONG"&&low<=stop) return {action:"CLOSE",price:stop,reason:"Adaptive stop loss"};
  if(side==="SHORT"&&high>=stop) return {action:"CLOSE",price:stop,reason:"Adaptive stop loss"};
  if(side==="LONG"&&high>=take) return {action:"CLOSE",price:take,reason:"2:1 adaptive take profit"};
  if(side==="SHORT"&&low<=take) return {action:"CLOSE",price:take,reason:"2:1 adaptive take profit"};
  if(heldHours>=POLICY.maxHoldHours) return {action:"CLOSE",price,reason:"Maximum holding time"};

  const opposite=(side==="LONG"&&decision.signal==="SELL")||(side==="SHORT"&&decision.signal==="BUY");
  if(opposite&&Number(decision.confidence)>=55) return {action:"CLOSE",price,reason:"Model direction reversed"};
  const longWeak=side==="LONG"&&market.emaFast<market.emaSlow&&market.rsi<44&&market.momentum5<-0.0015;
  const shortWeak=side==="SHORT"&&market.emaFast>market.emaSlow&&market.rsi>56&&market.momentum5>0.0015;
  if(longWeak||shortWeak) return {action:"CLOSE",price,reason:"1m indicators deteriorated"};

  const next={...position};
  next.highestPrice=Math.max(Number(position.highestPrice)||Number(position.entryPrice),high);
  next.lowestPrice=Math.min(Number(position.lowestPrice)||Number(position.entryPrice),low);
  const riskDistance=Math.abs(Number(position.entryPrice)-Number(position.initialStopPrice||position.stopPrice));
  const favorable=side==="LONG"?next.highestPrice-Number(position.entryPrice):Number(position.entryPrice)-next.lowestPrice;
  const rMultiple=riskDistance>0?favorable/riskDistance:0;
  if(rMultiple>=1){
    if(side==="LONG") next.stopPrice=Math.max(Number(next.stopPrice),Number(position.entryPrice));
    else next.stopPrice=Math.min(Number(next.stopPrice),Number(position.entryPrice));
  }
  if(rMultiple>=1.5){
    const trail=Math.max(Number(market.atr)*1.25,riskDistance*0.5);
    if(side==="LONG") next.stopPrice=Math.max(Number(next.stopPrice),price-trail);
    else next.stopPrice=Math.min(Number(next.stopPrice),price+trail);
  }
  return {action:"HOLD",position:next,rMultiple};
}
