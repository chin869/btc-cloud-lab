import {POLICY,analyzeMinuteCandles,planPosition,evaluatePosition} from "./risk_engine.mjs";

function expect(value,message){if(!value) throw new Error(message);}
const candles=[];
for(let i=0;i<120;i++){
  const close=100+i*0.02;
  candles.push({t:i*60000,closedAt:i*60000+59999,open:close-0.01,high:close+0.12,low:close-0.12,close,volume:100+i%7});
}
const market=analyzeMinuteCandles(candles);
const longPlan=planPosition(500,{signal:"BUY",confidence:80,mode:"validated"},market);
expect(longPlan.leverage<=10,"Leverage exceeded 10x");
expect(longPlan.marginUsed<=500*POLICY.maxMarginPct+1e-8,"Margin allocation exceeded policy");
expect(Math.abs(longPlan.takePct/longPlan.stopPct-2)<1e-10,"Reward/risk is not 2:1");
const position={...longPlan,entryPrice:market.price,initialStopPrice:longPlan.stopPrice,openedAt:new Date().toISOString(),highestPrice:market.price,lowestPrice:market.price};
const stopped=evaluatePosition(position,{signal:"HOLD",confidence:50},{...market,low:longPlan.stopPrice-0.01,high:market.price});
expect(stopped.action==="CLOSE"&&stopped.reason.includes("stop"),"Adaptive stop did not close the position");
const shortPlan=planPosition(500,{signal:"SELL",confidence:70,mode:"experimental-unvalidated"},market);
expect(shortPlan&&shortPlan.side==="SHORT","Short paper position planning failed");
expect(shortPlan.leverage<=10,"Short leverage exceeded 10x");
console.log("Strategy verification passed: 500 USDT, dynamic sizing, <=10x leverage, 2:1 adaptive exits, long/short PAPER positions.");
