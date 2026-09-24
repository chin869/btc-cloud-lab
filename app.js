(() => {
  "use strict";

  const STORAGE_SETTINGS = "btc-local-lab-settings-v1";
  const STORAGE_ACCOUNT = "btc-local-lab-account-v1";
  const CLOUD_FUTURES_MODE = window.BTCCloudMode === "usdt-m-futures";
  const DEFAULTS = {
    initialBalance: 10000,
    feeRate: 0.001,
    slippageRate: 0.0005,
    interval: "1h"
  };

  const state = {
    settings: loadSettings(),
    account: null,
    candles: [],
    market: null,
    source: "--",
    predictions: null,
    derivatives: null,
    derivativesError: null,
    derivativesPersistedAt: null,
    derivativeFeeds: null,
    autoPaper: window.BTCAutoPaper || null,
    currentPage: "overview",
    predictionSource: "--",
    predictionUpdatedAt: 0,
    predictionRefreshing: false,
    refreshing: false
  };
  state.account = loadAccount(state.settings);

  function el(id){ return document.getElementById(id); }
  function nowIso(){ return new Date().toISOString(); }
  function clamp(n,min,max){ return Math.min(max,Math.max(min,n)); }
  function fmtUsd(n){
    if(!Number.isFinite(n)) return "--";
    return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(n);
  }
  function fmtNum(n,d=2){
    if(!Number.isFinite(n)) return "--";
    return new Intl.NumberFormat("en-US",{maximumFractionDigits:d}).format(n);
  }
  function fmtPct(n,d=2){
    if(!Number.isFinite(n)) return "--";
    return (n>=0?"+":"") + n.toFixed(d) + "%";
  }
  function safeParse(raw,fallback){
    try { return JSON.parse(raw); } catch { return fallback; }
  }

  function loadSettings(){
    const saved = safeParse(localStorage.getItem(STORAGE_SETTINGS),{});
    return normalizeSettings(Object.assign({},DEFAULTS,saved || {}));
  }

  function normalizeSettings(input){
    return {
      initialBalance: clamp(Number(input.initialBalance) || DEFAULTS.initialBalance,100,100000000),
      feeRate: clamp(Number(input.feeRate),0,0.05),
      slippageRate: clamp(Number(input.slippageRate),0,0.05),
      interval: ["5m","15m","1h","4h","1d"].includes(input.interval) ? input.interval : "1h"
    };
  }

  function loadAccount(settings){
    const saved = safeParse(localStorage.getItem(STORAGE_ACCOUNT),null);
    if(saved && Number.isFinite(Number(saved.cash)) && Array.isArray(saved.trades)){
      return {
        cash:Number(saved.cash),
        qty:Math.max(0,Number(saved.qty)||0),
        avgEntry:Math.max(0,Number(saved.avgEntry)||0),
        realizedPnl:Number(saved.realizedPnl)||0,
        trades:saved.trades.slice(0,200)
      };
    }
    return freshAccount(settings.initialBalance);
  }

  function freshAccount(balance){
    return {cash:Number(balance),qty:0,avgEntry:0,realizedPnl:0,trades:[]};
  }

  function saveAll(){
    localStorage.setItem(STORAGE_SETTINGS,JSON.stringify(state.settings));
    localStorage.setItem(STORAGE_ACCOUNT,JSON.stringify(state.account));
  }

  function sma(values,period){
    if(values.length < period) return NaN;
    let sum=0;
    for(let i=values.length-period;i<values.length;i++) sum += values[i];
    return sum/period;
  }

  function rsi(values,period=14){
    if(values.length <= period) return NaN;
    let gains=0,losses=0;
    for(let i=values.length-period;i<values.length;i++){
      const diff=values[i]-values[i-1];
      if(diff>=0) gains+=diff; else losses-=diff;
    }
    if(losses===0) return 100;
    const rs=(gains/period)/(losses/period);
    return 100-(100/(1+rs));
  }

  function std(values){
    if(values.length<2) return 0;
    const mean=values.reduce((a,b)=>a+b,0)/values.length;
    const variance=values.reduce((a,b)=>a+Math.pow(b-mean,2),0)/(values.length-1);
    return Math.sqrt(variance);
  }

  function analyze(candles){
    const closes=candles.map(c=>c.close);
    const price=closes[closes.length-1];
    const sma20=sma(closes,20);
    const sma50=sma(closes,50);
    const rsi14=rsi(closes,14);
    const lookback=Math.min(6,closes.length-1);
    const momentum=lookback>0 ? (price/closes[closes.length-1-lookback]-1)*100 : 0;
    const recent=candles.slice(-24);
    const recentReturns=[];
    for(let i=Math.max(1,closes.length-24);i<closes.length;i++){
      recentReturns.push((closes[i]/closes[i-1]-1)*100);
    }
    const volatility=std(recentReturns);
    const rangeHigh=Math.max(...recent.map(c=>c.high));
    const rangeLow=Math.min(...recent.map(c=>c.low));

    let score=0;
    const reasons=[];
    if(Number.isFinite(sma20)){
      if(price>=sma20){ score+=1; reasons.push("價格位於 SMA20 上方：短線結構偏強。"); }
      else { score-=1; reasons.push("價格位於 SMA20 下方：短線結構偏弱。"); }
    }
    if(Number.isFinite(sma20) && Number.isFinite(sma50)){
      if(sma20>=sma50){ score+=1; reasons.push("SMA20 高於 SMA50：中短期趨勢偏多。"); }
      else { score-=1; reasons.push("SMA20 低於 SMA50：中短期趨勢偏空。"); }
    }
    if(Number.isFinite(rsi14)){
      if(rsi14<=30){ score+=1; reasons.push("RSI 進入超賣區：存在反彈條件，但不是買進保證。"); }
      else if(rsi14>=70){ score-=1; reasons.push("RSI 進入超買區：追價風險提高。"); }
      else { reasons.push("RSI 位於中性區，沒有極端超買或超賣訊號。"); }
    }
    if(momentum>=1){ score+=1; reasons.push("最近 6 根 K 動能為正且超過 1%。"); }
    else if(momentum<=-1){ score-=1; reasons.push("最近 6 根 K 動能為負且低於 -1%。"); }
    else { reasons.push("最近 6 根 K 動能幅度有限。"); }

    let bias="中性";
    if(score>=2) bias="多方偏向";
    if(score<=-2) bias="空方偏向";

    return {price,sma20,sma50,rsi14,momentum,volatility,rangeHigh,rangeLow,score,bias,reasons};
  }

  async function fetchJson(url,timeoutMs=9000){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),timeoutMs);
    try{
      const res=await fetch(url,{signal:controller.signal,cache:"no-store"});
      if(!res.ok) throw new Error("HTTP "+res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchBinance(interval,limit=200){
    const safeLimit=Math.max(50,Math.min(1000,Number(limit)||200));
    const base=CLOUD_FUTURES_MODE?"https://fapi.binance.com/fapi/v1/klines":"https://api.binance.com/api/v3/klines";
    const url=base+"?symbol=BTCUSDT&interval="+encodeURIComponent(interval)+"&limit="+safeLimit;
    const data=await fetchJson(url);
    if(!Array.isArray(data) || data.length<50) throw new Error("Binance 資料不足");
    return data.map(k=>({
      t:Number(k[0]),open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[5]),closedAt:Number(k[6])
    }));
  }

  async function fetchKraken(interval,limit=200){
    const map={"5m":5,"15m":15,"1h":60,"4h":240,"1d":1440};
    const url="https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval="+map[interval];
    const data=await fetchJson(url);
    if(data.error && data.error.length) throw new Error(data.error.join(", "));
    const keys=Object.keys(data.result || {}).filter(k=>k!=="last");
    if(!keys.length) throw new Error("Kraken 無資料");
    const rows=data.result[keys[0]].slice(-Math.max(50,Number(limit)||200));
    if(rows.length<50) throw new Error("Kraken 資料不足");
    return rows.map(k=>({
      t:Number(k[0])*1000,open:Number(k[1]),high:Number(k[2]),low:Number(k[3]),close:Number(k[4]),volume:Number(k[6]),closedAt:(Number(k[0])+map[interval]*60)*1000
    }));
  }

  async function fetchMarket(interval){
    try{
      const candles=await fetchBinance(interval);
      return {candles,source:CLOUD_FUTURES_MODE?"Binance BTCUSDT 永續合約公開 API":"Binance 公開 API"};
    }catch(binanceError){
      if(CLOUD_FUTURES_MODE) throw binanceError;
      const candles=await fetchKraken(interval);
      return {candles,source:"Kraken 公開 API（備援）",fallbackReason:String(binanceError.message||binanceError)};
    }
  }

  async function fetchBinanceHistory(target=9000){
    let endTime=Date.now();
    let rows=[];
    while(rows.length<target){
      const limit=Math.min(1000,target-rows.length);
      const base=CLOUD_FUTURES_MODE?"https://fapi.binance.com/fapi/v1/klines":"https://api.binance.com/api/v3/klines";
      const url=base+"?symbol=BTCUSDT&interval=1h&limit="+limit+"&endTime="+endTime;
      const data=await fetchJson(url,12000);
      if(!Array.isArray(data) || !data.length) break;
      const batch=data.map(k=>({
        t:Number(k[0]),
        open:Number(k[1]),
        high:Number(k[2]),
        low:Number(k[3]),
        close:Number(k[4]),
        volume:Number(k[5]),
        closedAt:Number(k[6])
      }));
      rows=batch.concat(rows);
      endTime=batch[0].t-1;
      if(data.length<limit) break;
    }
    const unique=new Map();
    rows.forEach(c=>unique.set(c.t,c));
    return Array.from(unique.values())
      .sort((a,b)=>a.t-b.t)
      .filter(c=>c.closedAt<Date.now())
      .slice(-target);
  }

  async function fetchPredictionHistory(){
    try{
      const candles=await fetchBinanceHistory(9000);
      if(candles.length<700) throw new Error("Binance 完整歷史資料不足");
      const days=(candles.length/24).toFixed(0);
      return {candles,source:(CLOUD_FUTURES_MODE?"Binance BTCUSDT 永續合約 1H":"Binance 1H")+" · "+candles.length+" 根（約 "+days+" 天）"};
    }catch(binanceError){
      if(CLOUD_FUTURES_MODE) throw binanceError;
      const candles=(await fetchKraken("1h",720)).filter(c=>!c.closedAt || c.closedAt<Date.now());
      return {candles,source:"Kraken 1H 備援 · "+candles.length+" 根",fallbackReason:String(binanceError.message||binanceError)};
    }
  }

  function mergeDerivativeRows(localRows,liveRows){
    const map=new Map();
    [...(Array.isArray(localRows)?localRows:[]),...(Array.isArray(liveRows)?liveRows:[])].forEach(row=>{
      const ts=Number(row && (row.timestamp ?? row.fundingTime));
      if(!Number.isFinite(ts)) return;
      map.set(ts,Object.assign({},row,{timestamp:ts}));
    });
    return Array.from(map.values()).sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));
  }

  function persistedDerivativeHistory(){
    const payload=window.BTCLocalDerivativesHistory;
    if(!payload || !payload.feeds) return {feeds:{funding:[],openInterest:[],longShort:[],taker:[]},updatedAt:null,collector:null};
    return {
      feeds:{
        funding:Array.isArray(payload.feeds.funding)?payload.feeds.funding:[],
        openInterest:Array.isArray(payload.feeds.openInterest)?payload.feeds.openInterest:[],
        longShort:Array.isArray(payload.feeds.longShort)?payload.feeds.longShort:[],
        taker:Array.isArray(payload.feeds.taker)?payload.feeds.taker:[]
      },
      updatedAt:payload.updatedAt||null,
      collector:payload.collector||null
    };
  }

  async function fetchDerivativesMarketData(){
    const base="https://fapi.binance.com";
    const requests={
      funding:base+"/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000",
      openInterest:base+"/futures/data/openInterestHist?symbol=BTCUSDT&period=1h&limit=500",
      longShort:base+"/futures/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=1h&limit=500",
      taker:base+"/futures/data/takerlongshortRatio?symbol=BTCUSDT&period=1h&limit=500"
    };

    const persisted=persistedDerivativeHistory();
    const names=Object.keys(requests);
    const settled=await Promise.allSettled(names.map(name=>fetchJson(requests[name],12000)));
    const live={funding:[],openInterest:[],longShort:[],taker:[]};
    const errors=[];

    settled.forEach((result,index)=>{
      const name=names[index];
      if(result.status!=="fulfilled" || !Array.isArray(result.value)){
        errors.push(name);
        return;
      }
      if(name==="funding"){
        live.funding=result.value.map(row=>Object.assign({},row,{timestamp:Number(row.fundingTime)}));
      }else{
        live[name]=result.value.map(row=>Object.assign({},row,{timestamp:Number(row.timestamp)}));
      }
    });

    const feeds={
      funding:mergeDerivativeRows(persisted.feeds.funding,live.funding),
      openInterest:mergeDerivativeRows(persisted.feeds.openInterest,live.openInterest),
      longShort:mergeDerivativeRows(persisted.feeds.longShort,live.longShort),
      taker:mergeDerivativeRows(persisted.feeds.taker,live.taker)
    };

    return {
      feeds,
      errors,
      persistedUpdatedAt:persisted.updatedAt,
      collector:persisted.collector
    };
  }

  function accountMetrics(){
    const price=state.market ? state.market.price : NaN;
    const positionValue=Number.isFinite(price) ? state.account.qty*price : 0;
    const estimatedExit=Number.isFinite(price)
      ? state.account.qty*price*(1-state.settings.slippageRate)*(1-state.settings.feeRate)
      : 0;
    const basis=state.account.qty*state.account.avgEntry;
    const unrealized=estimatedExit-basis;
    const equity=state.account.cash+positionValue;
    return {price,positionValue,unrealized,equity};
  }

  function recordTrade(trade){
    state.account.trades.unshift(Object.assign({id:Date.now()+"-"+Math.random().toString(16).slice(2),ts:nowIso()},trade));
    state.account.trades=state.account.trades.slice(0,200);
  }

  function executeTrade(side,amountUsd,closeAll=false){
    if(!state.market || !Number.isFinite(state.market.price)) throw new Error("行情尚未載入");
    const rawPrice=state.market.price;
    const feeRate=state.settings.feeRate;
    const slip=state.settings.slippageRate;

    if(side==="BUY"){
      if(closeAll) throw new Error("買入不支援全部平倉");
      if(!Number.isFinite(amountUsd) || amountUsd<=0) throw new Error("請輸入有效交易金額");
      const fill=rawPrice*(1+slip);
      const qty=amountUsd/fill;
      const fee=amountUsd*feeRate;
      const total=amountUsd+fee;
      if(total>state.account.cash+1e-8) throw new Error("模擬現金不足（交易金額還需加上手續費）");
      const oldBasis=state.account.qty*state.account.avgEntry;
      state.account.cash-=total;
      state.account.qty+=qty;
      state.account.avgEntry=(oldBasis+total)/state.account.qty;
      recordTrade({side:"BUY",qty,fill,fee,realized:0,notional:amountUsd});
    }else if(side==="SELL"){
      if(state.account.qty<=0) throw new Error("目前沒有 BTC 持倉可賣");
      const fill=rawPrice*(1-slip);
      let qty;
      if(closeAll){
        qty=state.account.qty;
      }else{
        if(!Number.isFinite(amountUsd) || amountUsd<=0) throw new Error("請輸入有效交易金額");
        qty=amountUsd/fill;
        if(qty>state.account.qty+1e-10) throw new Error("欲賣出的金額超過目前 BTC 持倉");
      }
      qty=Math.min(qty,state.account.qty);
      const gross=qty*fill;
      const fee=gross*feeRate;
      const proceeds=gross-fee;
      const cost=qty*state.account.avgEntry;
      const realized=proceeds-cost;
      state.account.cash+=proceeds;
      state.account.qty-=qty;
      state.account.realizedPnl+=realized;
      if(state.account.qty<1e-10){ state.account.qty=0; state.account.avgEntry=0; }
      recordTrade({side:"SELL",qty,fill,fee,realized,notional:gross});
    }else{
      throw new Error("未知交易方向");
    }
    saveAll();
    renderAll();
  }

  function setTradeMessage(text,ok){
    const node=el("tradeMessage");
    node.textContent=text;
    node.className="message "+(ok?"ok":"bad");
  }

  function renderMarket(){
    const m=state.market;
    el("priceValue").textContent=m?fmtUsd(m.price):"--";
    el("marketSource").textContent="資料來源："+state.source;
    el("biasValue").textContent=m?m.bias:"--";
    el("scoreValue").textContent="分數："+(m?String(m.score):"--")+" / 4";
    el("sma20Value").textContent=m?fmtUsd(m.sma20):"--";
    el("sma50Value").textContent=m?fmtUsd(m.sma50):"--";
    el("rsiValue").textContent=m?fmtNum(m.rsi14,1):"--";
    el("momentumValue").textContent=m?fmtPct(m.momentum):"--";
    el("volatilityValue").textContent=m?fmtNum(m.volatility,2)+"%":"--";
    el("rangeValue").textContent=m?fmtUsd(m.rangeLow)+" ～ "+fmtUsd(m.rangeHigh):"--";
    el("updatedAt").textContent=m?"更新："+new Date().toLocaleTimeString("zh-TW"):"--";

    const biasNode=el("biasValue");
    biasNode.className=m?(m.score>=2?"positive":m.score<=-2?"negative":"neutral-text"):"";

    const reasons=el("analysisReasons");
    reasons.innerHTML="";
    (m?m.reasons:[]).forEach(text=>{
      const div=document.createElement("div");
      div.className="reason";
      div.textContent=text;
      reasons.appendChild(div);
    });
  }

  function renderAccount(){
    const x=accountMetrics();
    el("equityValue").textContent=fmtUsd(x.equity);
    el("cashValue").textContent="現金："+fmtUsd(state.account.cash);
    el("unrealizedValue").textContent=fmtUsd(x.unrealized);
    el("realizedValue").textContent="已實現："+fmtUsd(state.account.realizedPnl);
    el("qtyValue").textContent=fmtNum(state.account.qty,8)+" BTC";
    el("avgEntryValue").textContent=state.account.qty>0?fmtUsd(state.account.avgEntry):"--";
    el("positionValue").textContent=fmtUsd(x.positionValue);

    el("unrealizedValue").className=x.unrealized>0?"positive":x.unrealized<0?"negative":"";
    el("realizedValue").className=state.account.realizedPnl>0?"positive":state.account.realizedPnl<0?"negative":"";

    const rows=el("tradeRows");
    rows.innerHTML="";
    if(!state.account.trades.length){
      const tr=document.createElement("tr");
      tr.innerHTML="<td colspan='6' class='muted'>目前沒有交易紀錄</td>";
      rows.appendChild(tr);
    }else{
      state.account.trades.forEach(t=>{
        const tr=document.createElement("tr");
        const pnlClass=t.realized>0?"positive":t.realized<0?"negative":"";
        tr.innerHTML=
          "<td>"+new Date(t.ts).toLocaleString("zh-TW")+"</td>"+
          "<td class='"+(t.side==="BUY"?"positive":"negative")+"'>"+(t.side==="BUY"?"買入":"賣出")+"</td>"+
          "<td>"+fmtNum(t.qty,8)+"</td>"+
          "<td>"+fmtUsd(t.fill)+"</td>"+
          "<td>"+fmtUsd(t.fee)+"</td>"+
          "<td class='"+pnlClass+"'>"+fmtUsd(t.realized)+"</td>";
        rows.appendChild(tr);
      });
    }
  }

  function renderSettings(){
    el("initialBalanceInput").value=state.settings.initialBalance;
    el("feeInput").value=(state.settings.feeRate*100).toFixed(3).replace(/0+$/,"").replace(/\.$/,"");
    el("slippageInput").value=(state.settings.slippageRate*100).toFixed(3).replace(/0+$/,"").replace(/\.$/,"");
    el("intervalSelect").value=state.settings.interval;
  }

  function drawChart(){
    const canvas=el("priceChart");
    const rect=canvas.getBoundingClientRect();
    const ratio=window.devicePixelRatio||1;
    canvas.width=Math.max(300,Math.floor(rect.width*ratio));
    canvas.height=Math.max(220,Math.floor(rect.height*ratio));
    const ctx=canvas.getContext("2d");
    ctx.scale(ratio,ratio);
    const w=rect.width,h=rect.height;
    ctx.clearRect(0,0,w,h);

    if(state.candles.length<2){
      ctx.fillStyle="#8d9aab";
      ctx.font="14px Segoe UI";
      ctx.fillText("等待行情資料…",18,28);
      return;
    }

    const data=state.candles.slice(-120);
    const closes=data.map(c=>c.close);
    const ma20Series=data.map((_,i)=>{
      const src=data.slice(0,i+1).map(c=>c.close);
      return sma(src,20);
    });
    const ma50Series=data.map((_,i)=>{
      const src=data.slice(0,i+1).map(c=>c.close);
      return sma(src,50);
    });
    const all=closes.concat(ma20Series.filter(Number.isFinite),ma50Series.filter(Number.isFinite));
    let min=Math.min(...all),max=Math.max(...all);
    const pad=(max-min)*0.08 || max*0.01;
    min-=pad;max+=pad;

    const left=12,right=12,top=18,bottom=26;
    const x=i=>left+(w-left-right)*(i/(data.length-1));
    const y=v=>top+(h-top-bottom)*(1-(v-min)/(max-min));

    ctx.strokeStyle="#1d2838";
    ctx.lineWidth=1;
    for(let i=0;i<4;i++){
      const yy=top+(h-top-bottom)*(i/3);
      ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();
    }

    function line(series,color,width){
      ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();
      let started=false;
      series.forEach((v,i)=>{
        if(!Number.isFinite(v)) return;
        if(!started){ctx.moveTo(x(i),y(v));started=true;}else{ctx.lineTo(x(i),y(v));}
      });
      ctx.stroke();
    }
    line(closes,"#f3f6fb",2);
    line(ma20Series,"#5fa8ff",1.5);
    line(ma50Series,"#f4b942",1.5);

    ctx.fillStyle="#8d9aab";
    ctx.font="11px Segoe UI";
    ctx.fillText(fmtUsd(max),left,11);
    ctx.fillText(fmtUsd(min),left,h-7);
  }

  function signalLabel(action){
    if(action==="LONG") return "做多";
    if(action==="SHORT") return "做空";
    return "觀望";
  }

  function signalClass(action){
    if(action==="LONG") return "long";
    if(action==="SHORT") return "short";
    return "neutral";
  }

  function regimeLabel(regime){
    if(regime==="UP") return "多頭";
    if(regime==="DOWN") return "空頭";
    return "震盪";
  }

  function renderPredictions(){
    const cards=el("predictionCards");
    const rows=el("backtestRows");
    const meta=el("predictionMeta");
    if(!cards || !rows || !meta) return;

    cards.innerHTML="";
    rows.innerHTML="";
    if(!state.predictions){
      cards.innerHTML='<div class="prediction-placeholder">正在抓取長期 1H 歷史並進行多模型驗證…</div>';
      rows.innerHTML='<tr><td colspan="11" class="muted">等待模型完成 walk-forward 驗證</td></tr>';
      meta.textContent="--";
      return;
    }

    const result=state.predictions;
    const validationRule=el("validationRule");
    if(validationRule) validationRule.textContent="驗證門檻："+result.validationRule;
    meta.textContent=
      state.predictionSource+
      " · 當前盤勢 "+regimeLabel(result.currentRegime)+
      " · 雙邊估計成本 "+result.roundTripCostPct.toFixed(2)+"%"+
      " · 更新 "+new Date(result.generatedAt).toLocaleTimeString("zh-TW");

    const netText=(metric)=>{
      if(!metric || !metric.signals) return "--";
      return (metric.avgNetMove>=0?"+":"")+metric.avgNetMove.toFixed(3)+"%";
    };
    const netClass=(metric)=>metric && metric.signals && metric.avgNetMove>=0?"positive":"negative";

    [["1h","1H"],["4h","4H"],["24h","24H"]].forEach(([key,label])=>{
      const h=result.horizons[key];
      const modelsHtml=h.models.map(model=>{
        const action=model.current.action;
        const probability=(model.current.probabilityUp*100).toFixed(1);
        const gate=model.validation.passed?"PASS":"FAIL";
        const gateClass=model.validation.passed?"gate-pass":"gate-fail";
        const failReason=model.validation.passed?"已通過完整驗證":model.validation.reasons.join("、");
        return '<div class="model-box">'+
          '<div class="model-title"><span>'+model.label+'</span><b class="'+gateClass+'">'+gate+'</b></div>'+
          '<strong class="'+(action==="LONG"?"positive":action==="SHORT"?"negative":"neutral-text")+'">原始訊號：'+signalLabel(action)+' · '+model.current.confidence.toFixed(0)+'%</strong>'+
          '<div class="model-detail">上漲機率 '+probability+'% · WF '+model.metrics.positiveFolds+'/'+model.metrics.totalFolds+' 折為正</div>'+
          '<div class="model-detail validation-reason">'+failReason+'</div>'+
        '</div>';
      }).join("");

      const card=document.createElement("div");
      card.className="prediction-card";
      card.innerHTML=
        '<div class="prediction-card-head">'+
          '<div><div class="prediction-horizon">'+label+'</div><div class="prediction-confidence">'+
            (h.consensus.validated?'模型信心 '+h.consensus.confidence.toFixed(0)+'%':'驗證狀態：未通過')+
          '</div></div>'+
          '<span class="signal-badge '+signalClass(h.consensus.action)+'">'+signalLabel(h.consensus.action)+'</span>'+
        '</div>'+
        '<div class="model-grid">'+modelsHtml+'</div>'+
        '<div class="model-detail consensus-reason">'+h.consensus.reason+'</div>';
      cards.appendChild(card);

      h.models.forEach(model=>{
        const b=model.metrics;
        const tr=document.createElement("tr");
        const pf=Number.isFinite(b.profitFactor)?b.profitFactor:0;
        tr.innerHTML=
          "<td>"+label+"</td>"+
          "<td>"+model.label+"</td>"+
          "<td class='"+(model.validation.passed?"positive":"negative")+"'>"+(model.validation.passed?"PASS":"FAIL")+"</td>"+
          "<td>"+b.signals+"</td>"+
          "<td>"+(b.signals?(b.winRate*100).toFixed(1)+"%":"--")+"</td>"+
          "<td class='"+netClass(b)+"'>"+netText(b)+"</td>"+
          "<td>"+(b.signals?pf.toFixed(2):"--")+"</td>"+
          "<td>"+b.positiveFolds+"/"+b.totalFolds+"</td>"+
          "<td class='"+netClass(b.regimes.UP)+"'>"+netText(b.regimes.UP)+"</td>"+
          "<td class='"+netClass(b.regimes.DOWN)+"'>"+netText(b.regimes.DOWN)+"</td>"+
          "<td class='"+netClass(b.regimes.RANGE)+"'>"+netText(b.regimes.RANGE)+"</td>";
        rows.appendChild(tr);
      });
    });
  }

  function derivativeCoverageText(item){
    if(!item || !item.count) return "無資料";
    return item.count+" 筆 / 約 "+item.days.toFixed(1)+" 天";
  }

  function renderDerivatives(){
    const status=el("derivativesStatus");
    const coverageNode=el("derivativesCoverage");
    const snapshotNode=el("derivativesSnapshot");
    const cards=el("derivativesCards");
    if(!status || !coverageNode || !snapshotNode || !cards) return;

    const result=state.derivatives;
    if(!result){
      status.className="status neutral";
      status.textContent=state.derivativesError?"衍生品資料失敗，已降級":"等待資料";
      coverageNode.textContent=state.derivativesError?"衍生品增強層暫時停用："+state.derivativesError:"尚未載入";
      snapshotNode.innerHTML="";
      cards.innerHTML='<div class="prediction-placeholder">OHLCV 主模型仍可正常使用。</div>';
      return;
    }

    const c=result.coverage;
    coverageNode.textContent=
      "Funding "+derivativeCoverageText(c.funding)+
      " · OI "+derivativeCoverageText(c.openInterest)+
      " · 多空比 "+derivativeCoverageText(c.longShort)+
      " · Taker "+derivativeCoverageText(c.taker)+
      " · 可對齊 1H 樣本 "+result.alignedCount+" 根"+
      (state.derivativesPersistedAt?" · 本機收集器 "+new Date(state.derivativesPersistedAt).toLocaleString("zh-TW"):"");

    if(!result.available){
      status.className="status neutral";
      status.textContent="資料不足，已降級";
      snapshotNode.innerHTML="";
      cards.innerHTML='<div class="prediction-placeholder">'+(result.reason||"衍生品樣本不足")+'；主 OHLCV 模型不受影響。</div>';
      return;
    }

    status.className="status ok";
    status.textContent="短期驗證完成";

    const snap=result.latestSnapshot;
    if(snap){
      const pct=(n,d=3)=>(Number(n)>=0?"+":"")+Number(n).toFixed(d)+"%";
      snapshotNode.innerHTML=
        '<div class="model-box"><span>Funding Rate</span><strong>'+pct(snap.funding,4)+'</strong></div>'+
        '<div class="model-box"><span>Open Interest</span><strong>'+fmtNum(snap.oiNow,0)+' BTC</strong><div class="model-detail">4H '+pct(snap.oiChg4,2)+'</div></div>'+
        '<div class="model-box"><span>Global Long / Short</span><strong>'+fmtNum(snap.longShort,3)+'</strong></div>'+
        '<div class="model-box"><span>Taker Buy / Sell</span><strong>'+fmtNum(snap.takerRatio,3)+'</strong><div class="model-detail">imbalance '+pct(snap.imbalance*100,1)+'</div></div>';
    }else{
      snapshotNode.innerHTML="";
    }

    cards.innerHTML="";
    [["1h","1H"],["4h","4H"],["24h","24H"]].forEach(([key,label])=>{
      const h=result.horizons[key];
      const card=document.createElement("div");
      card.className="prediction-card";
      if(!h || !h.available){
        card.innerHTML='<div class="prediction-horizon">'+label+'</div><div class="model-detail">'+((h&&h.reason)||"有效樣本不足")+'</div>';
        cards.appendChild(card);
        return;
      }

      const models=h.models.map(model=>{
        const b=model.metrics;
        const action=model.current.action;
        const gate=model.validation.passed?"PASS":"FAIL";
        const reason=model.validation.passed?"短期完整驗證通過":model.validation.reasons.join("、");
        const pf=b.signals?b.profitFactor.toFixed(2):"--";
        const avg=b.signals?(b.avgNetMove>=0?"+":"")+b.avgNetMove.toFixed(3)+"%":"--";
        return '<div class="model-box">'+
          '<div class="model-title"><span>'+model.label+'</span><b class="'+(model.validation.passed?'gate-pass':'gate-fail')+'">'+gate+'</b></div>'+
          '<strong class="'+(action==="LONG"?"positive":action==="SHORT"?"negative":"neutral-text")+'">原始訊號：'+signalLabel(action)+' · '+model.current.confidence.toFixed(0)+'%</strong>'+
          '<div class="model-detail">上漲機率 '+(model.current.probabilityUp*100).toFixed(1)+'% · '+b.signals+' 訊號 · PF '+pf+' · 平均 '+avg+'</div>'+
          '<div class="model-detail validation-reason">'+reason+'</div>'+
        '</div>';
      }).join("");

      card.innerHTML=
        '<div class="prediction-card-head">'+
          '<div><div class="prediction-horizon">'+label+'</div><div class="prediction-confidence">短期樣本 '+h.sampleCount+' 根 · '+h.folds+' 折</div></div>'+
          '<span class="signal-badge '+signalClass(h.consensus.action)+'">'+signalLabel(h.consensus.action)+'</span>'+
        '</div>'+
        '<div class="model-grid">'+models+'</div>'+
        '<div class="model-detail consensus-reason">'+h.consensus.reason+'</div>';
      cards.appendChild(card);
    });
  }

  function autoPaperLedger(){
    return state.autoPaper || window.BTCAutoPaper || null;
  }

  function autoPaperMetrics(){
    const ledger=autoPaperLedger();
    const account=ledger&&ledger.account?ledger.account:null;
    const settings=ledger&&ledger.settingsSnapshot?ledger.settingsSnapshot:{feeRate:0.001,slippageRate:0.0005};
    if(!account) return {cash:0,qty:0,avgEntry:0,price:NaN,equity:0,unrealized:0,realized:0};
    const history=Array.isArray(account.equityHistory)?account.equityHistory:[];
    const lastPoint=history.length?history[history.length-1]:null;
    const price=state.market&&Number.isFinite(state.market.price)?state.market.price:(lastPoint?Number(lastPoint.price):NaN);
    const cash=Number(account.cash)||0;
    const qty=Number(account.qty)||0;
    const avgEntry=Number(account.avgEntry)||0;
    const futures=Number(ledger.version)>=2;
    const side=account.positionSide||null;
    const leverage=Number(account.leverage)||1;
    const marginUsed=Number(account.marginUsed)||0;
    const direction=side==="SHORT"?-1:1;
    const value=Number.isFinite(price)?qty*price:0;
    const exitFee=Number.isFinite(price)?value*(Number(settings.feeRate)||0):0;
    const futuresUnrealized=qty>0&&Number.isFinite(price)?(price-avgEntry)*qty*direction-exitFee:0;
    const exitValue=Number.isFinite(price)?qty*price*(1-(Number(settings.slippageRate)||0))*(1-(Number(settings.feeRate)||0)):0;
    const unrealized=futures?futuresUnrealized:(qty>0?exitValue-qty*avgEntry:0);
    return {
      cash,qty,avgEntry,price,side,leverage,marginUsed,
      stopPrice:Number(account.stopPrice)||0,
      takeProfitPrice:Number(account.takeProfitPrice)||0,
      equity:futures?cash+unrealized:cash+value,
      freeCash:futures?cash-marginUsed:cash,
      unrealized,
      realized:Number(account.realizedPnl)||0
    };
  }

  function autoSignalLabel(signal){
    if(signal==="OPEN_LONG") return "OPEN LONG";
    if(signal==="OPEN_SHORT") return "OPEN SHORT";
    if(signal==="CLOSE_LONG"||signal==="CLOSE_SHORT") return "CLOSE";
    if(signal==="BUY") return "BUY";
    if(signal==="SELL") return "SELL / EXIT";
    if(signal==="DISABLED") return "OFF";
    return "HOLD";
  }

  function renderAutoPaper(){
    const ledger=autoPaperLedger();
    const status=el("autoPaperStatus");
    if(!ledger || !ledger.account){
      if(status){status.className="status neutral";status.textContent="等待第一次執行";}
      return;
    }
    const m=autoPaperMetrics();
    const enabled=Boolean(ledger.settingsSnapshot&&ledger.settingsSnapshot.enabled);
    if(status){
      status.className="status "+(ledger.lastError?"bad":enabled?"ok":"neutral");
      status.textContent=ledger.lastError?"AUTO ERROR":enabled?"AUTO ON":"AUTO OFF";
    }
    if(el("autoEquityValue")) el("autoEquityValue").textContent=fmtUsd(m.equity);
    if(el("autoCashValue")) el("autoCashValue").textContent=(m.side?"可用保證金：":"現金：")+fmtUsd(m.side?m.freeCash:m.cash);
    if(el("autoQtyValue")) el("autoQtyValue").textContent=(m.side?m.side+" "+m.leverage+"x · ":"")+fmtNum(m.qty,8)+" BTC";
    if(el("autoEntryValue")) el("autoEntryValue").textContent=m.qty>0?("進場："+fmtUsd(m.avgEntry)+" · SL "+fmtUsd(m.stopPrice)+" · TP "+fmtUsd(m.takeProfitPrice)):"進場：--";
    if(el("autoUnrealizedValue")){
      el("autoUnrealizedValue").textContent=fmtUsd(m.unrealized);
      el("autoUnrealizedValue").className=m.unrealized>0?"positive":m.unrealized<0?"negative":"";
    }
    if(el("autoRealizedValue")) el("autoRealizedValue").textContent="累計已實現："+fmtUsd(m.realized);

    const d=ledger.lastDecision||{};
    if(el("autoDecisionValue")){
      el("autoDecisionValue").textContent=autoSignalLabel(d.executed||d.signal||"HOLD");
      el("autoDecisionValue").className=(String(d.executed).includes("LONG")||d.signal==="BUY")?"positive":(String(d.executed).includes("SHORT")||d.signal==="SELL")?"negative":"neutral-text";
    }
    if(el("autoDecisionMeta")){
      const at=d.at||ledger.lastSuccessAt||ledger.lastRunAt;
      el("autoDecisionMeta").textContent=(d.mode||"--")+(at?" · "+new Date(at).toLocaleString("zh-TW"):"");
    }
    if(el("autoDecisionReason")) el("autoDecisionReason").textContent=ledger.lastError?("背景錯誤："+ledger.lastError):(d.reason||"等待背景引擎第一次完成判斷。");

    const rows=el("autoTradeRows");
    if(rows){
      rows.innerHTML="";
      const trades=Array.isArray(ledger.account.trades)?ledger.account.trades.slice(0,20):[];
      if(!trades.length){
        rows.innerHTML='<tr><td colspan="7" class="muted">目前沒有 AUTO 交易紀錄</td></tr>';
      }else{
        trades.forEach(t=>{
          const tr=document.createElement("tr");
          const modeClass=t.mode==="validated"?"validated":"experimental";
          const pnl=Number(t.realized)||0;
          tr.innerHTML=
            "<td>"+new Date(t.ts).toLocaleString("zh-TW")+"</td>"+
            "<td class='"+(String(t.side).includes("LONG")?"positive":String(t.side).includes("SHORT")?"negative":"")+"'>"+t.side+(t.leverage?" · "+t.leverage+"x":"")+"</td>"+
            "<td><span class='mode-tag "+modeClass+"'>"+(t.mode||"--")+"</span></td>"+
            "<td>"+fmtNum(Number(t.qty),8)+"</td>"+
            "<td>"+fmtUsd(Number(t.fill))+"</td>"+
            "<td class='"+(pnl>0?"positive":pnl<0?"negative":"")+"'>"+fmtUsd(pnl)+"</td>"+
            "<td>"+String(t.reason||"--")+"</td>";
          rows.appendChild(tr);
        });
      }
    }
  }

  function reloadAutoPaperData(){
    return new Promise(resolve=>{
      const script=document.createElement("script");
      script.src="data/auto-paper.js?t="+Date.now();
      script.onload=()=>{
        state.autoPaper=window.BTCAutoPaper||state.autoPaper;
        script.remove();
        resolve(true);
      };
      script.onerror=()=>{
        script.remove();
        resolve(false);
      };
      document.head.appendChild(script);
    });
  }

  function setPage(page){
    state.currentPage=page==="data"?"data":"overview";
    const overview=el("overviewPage");
    const data=el("dataCenterPage");
    const navOverview=el("navOverview");
    const navData=el("navDataCenter");
    if(overview) overview.classList.toggle("active",state.currentPage==="overview");
    if(data) data.classList.toggle("active",state.currentPage==="data");
    if(navOverview) navOverview.classList.toggle("active",state.currentPage==="overview");
    if(navData) navData.classList.toggle("active",state.currentPage==="data");
    if(state.currentPage==="data"){
      renderDataCenter();
      requestAnimationFrame(drawDataCenterCharts);
    }else{
      requestAnimationFrame(drawChart);
    }
  }

  function monthWindow(date=new Date()){
    const start=new Date(date.getFullYear(),date.getMonth(),1);
    const end=new Date(date.getFullYear(),date.getMonth()+1,1);
    return {start,end};
  }

  function monthlyPerformance(){
    const {start,end}=monthWindow();
    const ledger=autoPaperLedger();
    const allTrades=ledger&&ledger.account&&Array.isArray(ledger.account.trades)?ledger.account.trades:[];
    const trades=allTrades.filter(t=>{
      const d=new Date(t.ts);
      return d>=start && d<end;
    });
    const closes=trades.filter(t=>t.side==="SELL");
    const realized=closes.reduce((sum,t)=>sum+(Number(t.realized)||0),0);
    const fees=trades.reduce((sum,t)=>sum+(Number(t.fee)||0),0);
    const wins=closes.filter(t=>(Number(t.realized)||0)>0).length;
    const best=closes.length?Math.max(...closes.map(t=>Number(t.realized)||0)):NaN;
    const worst=closes.length?Math.min(...closes.map(t=>Number(t.realized)||0)):NaN;
    const winRate=closes.length?wins/closes.length:NaN;
    const initial=Number(ledger&&ledger.settingsSnapshot&&ledger.settingsSnapshot.initialBalance)||10000;
    const returnPct=initial>0?realized/initial*100:NaN;

    const now=new Date();
    const lastDay=(now.getFullYear()===start.getFullYear() && now.getMonth()===start.getMonth())
      ? now.getDate()
      : new Date(start.getFullYear(),start.getMonth()+1,0).getDate();
    const daily=[];
    let cumulative=0;
    for(let day=1;day<=lastDay;day++){
      let dayPnl=0;
      for(const t of closes){
        const d=new Date(t.ts);
        if(d.getFullYear()===start.getFullYear() && d.getMonth()===start.getMonth() && d.getDate()===day){
          dayPnl+=Number(t.realized)||0;
        }
      }
      cumulative+=dayPnl;
      daily.push({label:String(day),value:cumulative});
    }
    return {start,end,trades,closes,realized,fees,wins,best,worst,winRate,returnPct,daily};
  }

  function derivativeFeedsForCenter(){
    if(state.derivativeFeeds) return state.derivativeFeeds;
    const persisted=persistedDerivativeHistory();
    return persisted.feeds;
  }

  function selectedDataRangeHours(){
    const node=el("dataRangeSelect");
    if(!node || node.value==="all") return Infinity;
    const value=Number(node.value);
    return Number.isFinite(value)?value:168;
  }

  function filterFeedByRange(rows){
    const list=Array.isArray(rows)?rows.slice().sort((a,b)=>Number(a.timestamp)-Number(b.timestamp)):[];
    const hours=selectedDataRangeHours();
    if(!Number.isFinite(hours) || !list.length) return list;
    const end=Number(list[list.length-1].timestamp);
    const minTs=end-hours*3600000;
    return list.filter(r=>Number(r.timestamp)>=minTs);
  }

  function prepareCanvas(canvas){
    if(!canvas) return null;
    const rect=canvas.getBoundingClientRect();
    if(rect.width<20 || rect.height<20) return null;
    const ratio=window.devicePixelRatio||1;
    canvas.width=Math.max(300,Math.floor(rect.width*ratio));
    canvas.height=Math.max(160,Math.floor(rect.height*ratio));
    const ctx=canvas.getContext("2d");
    ctx.setTransform(ratio,0,0,ratio,0,0);
    ctx.clearRect(0,0,rect.width,rect.height);
    return {ctx,w:rect.width,h:rect.height};
  }

  function drawSeriesChart(canvasId,points,options={}){
    const canvas=el(canvasId);
    const prepared=prepareCanvas(canvas);
    if(!prepared) return;
    const {ctx,w,h}=prepared;
    const data=(points||[]).filter(p=>Number.isFinite(p.value));
    if(!data.length){
      ctx.fillStyle="#8d9aab";
      ctx.font="13px Segoe UI";
      ctx.fillText("目前沒有可繪製的資料",16,26);
      return;
    }

    const left=54,right=14,top=18,bottom=30;
    let min=Math.min(...data.map(p=>p.value));
    let max=Math.max(...data.map(p=>p.value));
    if(Number.isFinite(options.reference)){
      min=Math.min(min,options.reference);
      max=Math.max(max,options.reference);
    }
    if(Math.abs(max-min)<1e-12){
      const pad=Math.abs(max)*0.05 || 1;
      min-=pad;max+=pad;
    }else{
      const pad=(max-min)*0.10;
      min-=pad;max+=pad;
    }

    const x=i=>left+(w-left-right)*(data.length===1?0.5:i/(data.length-1));
    const y=v=>top+(h-top-bottom)*(1-(v-min)/(max-min));

    ctx.strokeStyle="#1d2838";
    ctx.lineWidth=1;
    for(let i=0;i<4;i++){
      const yy=top+(h-top-bottom)*(i/3);
      ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(w-right,yy);ctx.stroke();
      const val=max-(max-min)*(i/3);
      ctx.fillStyle="#718095";
      ctx.font="10px Segoe UI";
      const label=options.formatY?options.formatY(val):fmtNum(val,2);
      ctx.fillText(label,4,yy+3);
    }

    if(Number.isFinite(options.reference)){
      const ry=y(options.reference);
      ctx.save();
      ctx.setLineDash([4,4]);
      ctx.strokeStyle="#526176";
      ctx.beginPath();ctx.moveTo(left,ry);ctx.lineTo(w-right,ry);ctx.stroke();
      ctx.restore();
    }

    if(options.zeroFill){
      const zeroY=y(0);
      ctx.beginPath();
      ctx.moveTo(x(0),zeroY);
      data.forEach((p,i)=>ctx.lineTo(x(i),y(p.value)));
      ctx.lineTo(x(data.length-1),zeroY);
      ctx.closePath();
      ctx.fillStyle="rgba(95,168,255,.10)";
      ctx.fill();
    }

    ctx.strokeStyle=options.stroke||"#f3f6fb";
    ctx.lineWidth=2;
    ctx.beginPath();
    data.forEach((p,i)=>{
      if(i===0) ctx.moveTo(x(i),y(p.value));
      else ctx.lineTo(x(i),y(p.value));
    });
    ctx.stroke();

    const first=data[0],last=data[data.length-1];
    ctx.fillStyle="#718095";
    ctx.font="10px Segoe UI";
    const firstLabel=first.label||"";
    const lastLabel=last.label||"";
    ctx.fillText(firstLabel,left,h-8);
    const lastWidth=ctx.measureText(lastLabel).width;
    ctx.fillText(lastLabel,w-right-lastWidth,h-8);
  }

  function feedTimeLabel(ts){
    const d=new Date(Number(ts));
    return (d.getMonth()+1)+"/"+d.getDate()+" "+String(d.getHours()).padStart(2,"0")+":00";
  }

  function drawDataCenterCharts(){
    const perf=monthlyPerformance();
    drawSeriesChart("monthlyPnlChart",perf.daily,{
      reference:0,
      zeroFill:true,
      formatY:v=>fmtUsd(v)
    });

    const feeds=derivativeFeedsForCenter();
    const funding=filterFeedByRange(feeds.funding).map(r=>({label:feedTimeLabel(r.timestamp),value:Number(r.fundingRate)*100}));
    const oi=filterFeedByRange(feeds.openInterest).map(r=>({label:feedTimeLabel(r.timestamp),value:Number(r.sumOpenInterest)}));
    const ls=filterFeedByRange(feeds.longShort).map(r=>({label:feedTimeLabel(r.timestamp),value:Number(r.longShortRatio)}));
    const taker=filterFeedByRange(feeds.taker).map(r=>({label:feedTimeLabel(r.timestamp),value:Number(r.buySellRatio)}));

    drawSeriesChart("fundingChart",funding,{reference:0,formatY:v=>v.toFixed(4)+"%"});
    drawSeriesChart("oiChart",oi,{formatY:v=>fmtNum(v,0)});
    drawSeriesChart("longShortChart",ls,{reference:1,formatY:v=>v.toFixed(2)});
    drawSeriesChart("takerChart",taker,{reference:1,formatY:v=>v.toFixed(2)});
  }

  function renderCollectorDetails(){
    const payload=window.BTCLocalDerivativesHistory || {};
    const collector=payload.collector || {};
    const counts=collector.counts || {};
    const badge=el("dcCollectorBadge");
    const details=el("dcCollectorDetails");
    if(!badge || !details) return;

    const lastSuccess=collector.lastSuccessAt || payload.updatedAt || state.derivativesPersistedAt;
    const hasError=Boolean(collector.lastError);
    badge.className="status "+(hasError?"bad":lastSuccess?"ok":"neutral");
    badge.textContent=hasError?"最近收集有錯誤":lastSuccess?"背景收集正常":"尚未有狀態";

    const pills=[
      ["最後成功",lastSuccess?new Date(lastSuccess).toLocaleString("zh-TW"):"--"],
      ["Funding",String(counts.funding ?? (payload.feeds?.funding?.length||0))+" 筆"],
      ["Open Interest",String(counts.openInterest ?? (payload.feeds?.openInterest?.length||0))+" 筆"],
      ["Long/Short · Taker",String(counts.longShort ?? (payload.feeds?.longShort?.length||0))+" / "+String(counts.taker ?? (payload.feeds?.taker?.length||0))+" 筆"]
    ];
    details.innerHTML=pills.map(([label,value])=>'<div class="collector-pill"><span>'+label+'</span><strong>'+value+'</strong></div>').join("");
    if(hasError){
      details.innerHTML+='<div class="collector-pill"><span>最近錯誤</span><strong class="negative">'+String(collector.lastError)+'</strong></div>';
    }
  }

  function renderDataCenter(){
    const perf=monthlyPerformance();
    const metrics=autoPaperMetrics();

    const realizedNode=el("monthRealizedValue");
    const unrealizedNode=el("monthUnrealizedValue");
    if(realizedNode){
      realizedNode.textContent=fmtUsd(perf.realized);
      realizedNode.className=perf.realized>0?"positive":perf.realized<0?"negative":"";
    }
    if(unrealizedNode){
      unrealizedNode.textContent=fmtUsd(metrics.unrealized);
      unrealizedNode.className=metrics.unrealized>0?"positive":metrics.unrealized<0?"negative":"";
    }
    if(el("monthReturnValue")) el("monthReturnValue").textContent="相對初始資金："+fmtPct(perf.returnPct);
    if(el("monthClosedTradesValue")) el("monthClosedTradesValue").textContent=String(perf.closes.length);
    if(el("monthWinRateValue")) el("monthWinRateValue").textContent="勝率："+(Number.isFinite(perf.winRate)?(perf.winRate*100).toFixed(1)+"%":"--");
    if(el("monthFeesValue")) el("monthFeesValue").textContent=fmtUsd(perf.fees);
    if(el("monthBestTradeValue")){
      el("monthBestTradeValue").textContent="最佳單："+(Number.isFinite(perf.best)?fmtUsd(perf.best):"--")+(Number.isFinite(perf.worst)?" · 最差 "+fmtUsd(perf.worst):"");
    }
    if(el("monthPeriodLabel")){
      el("monthPeriodLabel").textContent=(perf.start.getFullYear())+" 年 "+(perf.start.getMonth()+1)+" 月";
    }

    const feeds=derivativeFeedsForCenter();
    const latest=(rows)=>Array.isArray(rows)&&rows.length?rows[rows.length-1]:null;
    const f=latest(feeds.funding),oi=latest(feeds.openInterest),ls=latest(feeds.longShort),tk=latest(feeds.taker);
    if(el("dcFundingNow")) el("dcFundingNow").textContent=f?fmtPct(Number(f.fundingRate)*100,4):"--";
    if(el("dcOiNow")) el("dcOiNow").textContent=oi?fmtNum(Number(oi.sumOpenInterest),0)+" BTC":"--";
    if(el("dcLongShortNow")) el("dcLongShortNow").textContent=ls?fmtNum(Number(ls.longShortRatio),3):"--";
    if(el("dcTakerNow")) el("dcTakerNow").textContent=tk?fmtNum(Number(tk.buySellRatio),3):"--";

    renderCollectorDetails();
    if(state.currentPage==="data") requestAnimationFrame(drawDataCenterCharts);
  }

  async function refreshPredictions(force=false){
    if(state.predictionRefreshing) return;
    if(!force && state.predictions && Date.now()-state.predictionUpdatedAt<5*60*1000) return;
    const status=el("predictionStatus");
    state.predictionRefreshing=true;
    if(status){ status.className="status neutral"; status.textContent="抓歷史 / 多模型驗證中…"; }
    try{
      if(!window.BTCPredictor) throw new Error("預測模組未載入");
      const history=await fetchPredictionHistory();
      state.predictions=window.BTCPredictor.run(history.candles,{
        feeRate:state.settings.feeRate,
        slippageRate:state.settings.slippageRate
      });

      state.derivatives=null;
      state.derivativesError=null;
      try{
        if(!window.BTCDerivatives) throw new Error("衍生品模型模組未載入");
        const derivativeData=await fetchDerivativesMarketData();
        state.derivatives=window.BTCDerivatives.run(history.candles,derivativeData.feeds,{
          feeRate:state.settings.feeRate,
          slippageRate:state.settings.slippageRate
        });
        state.derivativeFeeds=derivativeData.feeds;
        state.derivativesPersistedAt=derivativeData.persistedUpdatedAt||null;
        if(derivativeData.errors.length){
          state.derivativesError="部分來源失敗："+derivativeData.errors.join(", ");
        }
      }catch(derivativeError){
        state.derivatives=null;
        state.derivativesError=String(derivativeError.message||derivativeError);
      }

      state.predictionSource=history.source;
      state.predictionUpdatedAt=Date.now();
      if(status){ status.className="status ok"; status.textContent="模型已更新"; }
      renderPredictions();
      renderDerivatives();
    }catch(err){
      if(status){ status.className="status bad"; status.textContent="模型失敗"; }
      if(el("predictionMeta")) el("predictionMeta").textContent="預測錯誤："+String(err.message||err);
    }finally{
      state.predictionRefreshing=false;
    }
  }

  function renderAll(){
    renderMarket();
    renderAccount();
    renderPredictions();
    renderDerivatives();
    renderAutoPaper();
    renderDataCenter();
    drawChart();
  }

  async function refresh(){
    if(state.refreshing) return;
    state.refreshing=true;
    el("refreshBtn").disabled=true;
    const status=el("connectionStatus");
    status.className="status neutral";
    status.textContent="更新中…";
    try{
      const result=await fetchMarket(state.settings.interval);
      state.candles=result.candles;
      state.source=result.source;
      state.market=analyze(result.candles);
      await reloadAutoPaperData();
      await refreshPredictions(false);
      status.className="status ok";
      status.textContent="行情已連線";
      renderAll();
    }catch(err){
      status.className="status bad";
      status.textContent="行情連線失敗";
      state.source="連線失敗";
      setTradeMessage("行情載入失敗："+String(err.message||err),false);
      renderMarket();
    }finally{
      state.refreshing=false;
      el("refreshBtn").disabled=false;
    }
  }

  function saveSettingsFromForm(){
    const next=normalizeSettings({
      initialBalance:Number(el("initialBalanceInput").value),
      feeRate:Number(el("feeInput").value)/100,
      slippageRate:Number(el("slippageInput").value)/100,
      interval:el("intervalSelect").value
    });
    const costsChanged=state.settings.feeRate!==next.feeRate || state.settings.slippageRate!==next.slippageRate;
    state.settings=next;
    saveAll();
    if(costsChanged) state.predictionUpdatedAt=0;
    renderSettings();
    setTradeMessage("設定已儲存。初始資金要在重置模擬盤後才會套用。",true);
  }

  function exportBackup(){
    const payload={
      app:"BTC Local Lab",
      version:1,
      exportedAt:nowIso(),
      settings:state.settings,
      account:state.account
    };
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;
    a.download="btc-local-lab-backup-"+new Date().toISOString().slice(0,10)+".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function importBackup(file){
    const text=await file.text();
    const payload=JSON.parse(text);
    if(!payload || payload.app!=="BTC Local Lab" || !payload.settings || !payload.account) throw new Error("不是有效的 BTC Local Lab 備份");
    state.settings=normalizeSettings(payload.settings);
    const a=payload.account;
    if(!Number.isFinite(Number(a.cash)) || !Array.isArray(a.trades)) throw new Error("備份中的模擬盤資料格式錯誤");
    state.account={
      cash:Number(a.cash),
      qty:Math.max(0,Number(a.qty)||0),
      avgEntry:Math.max(0,Number(a.avgEntry)||0),
      realizedPnl:Number(a.realizedPnl)||0,
      trades:a.trades.slice(0,200)
    };
    saveAll();
    renderSettings();
    renderAll();
  }

  el("navOverview").addEventListener("click",()=>setPage("overview"));
  el("navDataCenter").addEventListener("click",()=>setPage("data"));
  el("dataRangeSelect").addEventListener("change",()=>{
    renderDataCenter();
    requestAnimationFrame(drawDataCenterCharts);
  });
  el("refreshBtn").addEventListener("click",refresh);
  el("intervalSelect").addEventListener("change",()=>{
    state.settings.interval=el("intervalSelect").value;
    saveAll();
    refresh();
  });
  el("buyBtn").addEventListener("click",()=>{
    try{
      executeTrade("BUY",Number(el("orderAmount").value),false);
      setTradeMessage("模擬買入完成。",true);
    }catch(err){ setTradeMessage(String(err.message||err),false); }
  });
  el("sellBtn").addEventListener("click",()=>{
    try{
      executeTrade("SELL",Number(el("orderAmount").value),false);
      setTradeMessage("模擬賣出完成。",true);
    }catch(err){ setTradeMessage(String(err.message||err),false); }
  });
  el("closeBtn").addEventListener("click",()=>{
    try{
      executeTrade("SELL",0,true);
      setTradeMessage("模擬持倉已全部平倉。",true);
    }catch(err){ setTradeMessage(String(err.message||err),false); }
  });
  el("saveSettingsBtn").addEventListener("click",saveSettingsFromForm);
  el("resetBtn").addEventListener("click",()=>{
    if(!confirm("確定要清除目前持倉、損益與交易紀錄，重新以初始資金開始嗎？")) return;
    state.account=freshAccount(state.settings.initialBalance);
    saveAll();
    renderAll();
    setTradeMessage("模擬盤已重置。",true);
  });
  el("exportBtn").addEventListener("click",exportBackup);
  el("importInput").addEventListener("change",async ev=>{
    const file=ev.target.files && ev.target.files[0];
    if(!file) return;
    try{
      await importBackup(file);
      setTradeMessage("備份已匯入。",true);
    }catch(err){ setTradeMessage(String(err.message||err),false); }
    ev.target.value="";
  });
  window.addEventListener("resize",()=>{
    drawChart();
    if(state.currentPage==="data") drawDataCenterCharts();
  });

  renderSettings();
  state.autoPaper=window.BTCAutoPaper||state.autoPaper;
  setPage("overview");
  renderAll();
  refresh();
  setInterval(refresh,15000);
})();
