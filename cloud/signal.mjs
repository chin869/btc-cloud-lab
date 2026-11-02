const weights={"1h":1,"4h":1.5,"24h":2};
const mean=models=>{
  const values=(models||[]).map(m=>Number(m.current?.probabilityUp)).filter(p=>Number.isFinite(p)&&p>=0&&p<=1);
  return values.length?values.reduce((a,b)=>a+b,0)/values.length:0.5;
};

export function deriveSignal(main,deriv){
  const validated=[],raw=[];
  for(const [key,weight] of Object.entries(weights)){
    for(const [family,h,factor] of [["OHLCV",main?.horizons?.[key],1],["Derivatives",deriv?.available&&deriv.horizons?.[key],0.8]]){
      if(!h||family==="Derivatives"&&!h.available) continue;
      const p=mean(h.models);
      raw.push({key,p,weight:weight*factor,source:family});
      if(h.consensus?.validated&&["LONG","SHORT"].includes(h.consensus.action)){
        validated.push({key,action:h.consensus.action,weight:weight*factor,source:family+" "+key,probabilityUp:p});
      }
    }
  }
  const total=raw.reduce((s,r)=>s+r.weight,0);
  const probabilityUp=total?raw.reduce((s,r)=>s+r.p*r.weight,0)/total:0.5;
  const horizonProbabilities=Object.fromEntries(Object.keys(weights).map(key=>{
    const rows=raw.filter(r=>r.key===key),w=rows.reduce((s,r)=>s+r.weight,0);
    return [key,w?rows.reduce((s,r)=>s+r.p*r.weight,0)/w:0.5];
  }));
  const score=validated.reduce((s,v)=>s+(v.action==="LONG"?1:-1)*v.weight,0);
  const voteWeight=validated.reduce((s,v)=>s+v.weight,0);
  const agreement=voteWeight?Math.abs(score)/voteWeight:0;
  let signal="HOLD",mode="experimental-unvalidated";
  if(validated.length){
    mode=agreement>=0.34?"validated":"validated-conflict";
    if(agreement>=0.34) signal=score>0?"BUY":"SELL";
  }else{
    const probabilities=Object.values(horizonProbabilities);
    if(probabilityUp>=0.56&&probabilities.filter(p=>p>=0.54).length>=2) signal="BUY";
    if(probabilityUp<=0.44&&probabilities.filter(p=>p<=0.46).length>=2) signal="SELL";
  }
  const supporting=validated.filter(v=>v.action===(signal==="BUY"?"LONG":signal==="SELL"?"SHORT":null));
  const supportingHorizons=new Set(supporting.map(v=>v.key)).size;
  const confidence=Math.min(supportingHorizons<=1?60:supportingHorizons===2?70:80,
    50+Math.abs(probabilityUp-0.5)*100+supportingHorizons*5);
  return {
    signal,mode,probabilityUp,confidence,horizonProbabilities,
    probabilityLabel:"模型原始機率均值，未校準為實際交易勝率",
    confidenceKind:"heuristic-score-not-win-probability",
    evidence:{validatedVotes:validated,supportingVotes:supporting.length,supportingHorizons,agreement},
    reason:validated.length
      ? "模型檢查通過票："+validated.map(v=>v.source+" "+v.action).join("、")+"；支持 "+supportingHorizons+" 個週期。信心分數不是勝率。"
      : "研究模式 "+signal+"；模型原始機率均值 "+(probabilityUp*100).toFixed(1)+"%，不代表實際交易勝率。"
  };
}
