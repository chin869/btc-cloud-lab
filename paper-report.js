(function(root){
  "use strict";
  const closes=t=>["SELL","CLOSE_LONG","CLOSE_SHORT"].includes(t.side);
  function monthly(ledger,date=new Date()){
    const parts=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Taipei",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
    const value=type=>Number(parts.find(p=>p.type===type).value);
    const year=value("year"),month=value("month"),day=value("day");
    const start=new Date(Date.UTC(year,month-1,1)-8*3600000),end=new Date(Date.UTC(year,month,1)-8*3600000);
    const trades=(ledger?.account?.trades||[]).filter(t=>Date.parse(t.ts)>=start&&Date.parse(t.ts)<end);
    const exits=trades.filter(closes);
    const realized=exits.reduce((s,t)=>s+(Number(t.realized)||0),0);
    const fees=trades.reduce((s,t)=>s+(Number(t.fee)||0),0);
    const wins=exits.filter(t=>t.realized>0).length;
    let cumulative=0;
    const daily=Array.from({length:day},(_,i)=>{
      const until=start.getTime()+(i+1)*86400000;
      cumulative=exits.filter(t=>Date.parse(t.ts)<until).reduce((s,t)=>s+(Number(t.realized)||0),0);
      return {label:String(i+1),value:cumulative};
    });
    return {start,end,label:year+" 年 "+month+" 月（台灣時間）",trades,closes:exits,realized,fees,wins,
      best:exits.length?Math.max(...exits.map(t=>t.realized)):NaN,worst:exits.length?Math.min(...exits.map(t=>t.realized)):NaN,
      winRate:exits.length?wins/exits.length:NaN,returnPct:realized/(Number(ledger?.settingsSnapshot?.initialBalance)||500)*100,daily};
  }
  function health(ledger,status,now=Date.now()){
    const last=Date.parse(ledger?.lastSuccessAt),ageMinutes=Number.isFinite(last)?Math.max(0,(now-last)/60000):null;
    const errors=[ledger?.lastError,status?.lastError].filter(Boolean);
    const state=ledger?.health?.status;
    const disabled=ledger?.settingsSnapshot?.enabled===false;
    const label=errors.length?"雲端異常／需檢查":state==="blocked"?"資料缺口，停止新進場":
      ageMinutes===null?"尚無成功紀錄":ageMinutes>15?"雲端檢查已延遲":state==="degraded"?"模型異常，僅監控持倉":
      state==="stale"?"行情過期，禁止新進場":disabled?"新進場已暫停":"最近一次檢查完成";
    return {ageMinutes,label,level:errors.length||state==="blocked"?"bad":ageMinutes===null||ageMinutes>15||state==="degraded"||state==="stale"||disabled?"neutral":"ok"};
  }
  function segments(ledger){
    return ["legacy","paper-v3"].map(version=>{
      const trades=(ledger?.account?.trades||[]).filter(t=>version==="legacy"?t.strategyVersion!=="paper-v3":t.strategyVersion==="paper-v3");
      const exited=trades.filter(closes);
      return {version,closes:exited.length,realized:exited.reduce((s,t)=>s+(Number(t.realized)||0),0),fees:trades.reduce((s,t)=>s+(Number(t.fee)||0),0)};
    });
  }
  const api={monthly,health,segments,isClose:closes};
  if(typeof module!=="undefined"&&module.exports)module.exports=api;
  root.BTCPaperReport=api;
})(typeof window!=="undefined"?window:globalThis);
