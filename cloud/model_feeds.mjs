// Only observations available by the model candle may enter that model.
export function selectModelFeeds(feeds,venue,modelAsOf){
  const selected={},warnings=[];
  for(const name of ["funding","openInterest","longShort","taker"]){
    const rows=(feeds[name]||[]).filter(r=>r.venue===venue&&Number.isFinite(Number(r.timestamp??r.fundingTime))&&Number(r.timestamp??r.fundingTime)<=modelAsOf)
      .sort((a,b)=>Number(a.timestamp??a.fundingTime)-Number(b.timestamp??b.fundingTime));
    const last=Number(rows.at(-1)?.timestamp??rows.at(-1)?.fundingTime);
    const maxAge=(name==="funding"?24:2)*3600000;
    const fresh=Number.isFinite(last)&&modelAsOf-last<=maxAge;
    selected[name]=fresh?rows:[];
    if(!fresh)warnings.push(name+"：來源不符、資料缺少或過期，本輪不送入模型");
  }
  return {selected,warnings};
}
