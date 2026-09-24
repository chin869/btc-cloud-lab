(() => {
  "use strict";
  const HORIZONS=[{key:"1h",steps:1,label:"1H"},{key:"4h",steps:4,label:"4H"},{key:"24h",steps:24,label:"24H"}];
  const MODELS=["derivLogistic","derivRidge"];
  const LABELS={derivLogistic:"Derivatives Logistic",derivRidge:"Derivatives Ridge"};

  function clamp(n,min,max){return Math.min(max,Math.max(min,n));}
  function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
  function std(a){if(a.length<2)return 1;const m=mean(a);const v=a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1);const o=Math.sqrt(v);return o>1e-9?o:1;}
  function sigmoid(z){if(z>=0){const e=Math.exp(-z);return 1/(1+e);}const e=Math.exp(z);return e/(1+e);}
  function pct(a,b){return b!==0?(a/b-1)*100:0;}
  function sortedFeed(rows){return (Array.isArray(rows)?rows:[]).filter(r=>Number.isFinite(Number(r.timestamp))).slice().sort((a,b)=>Number(a.timestamp)-Number(b.timestamp));}

  function lastAtOrBefore(rows,ts,maxAgeMs){
    let lo=0,hi=rows.length-1,ans=-1;
    while(lo<=hi){const mid=(lo+hi)>>1;if(Number(rows[mid].timestamp)<=ts){ans=mid;lo=mid+1;}else hi=mid-1;}
    if(ans<0)return null;
    const row=rows[ans];
    if(Number.isFinite(maxAgeMs)&&ts-Number(row.timestamp)>maxAgeMs)return null;
    return row;
  }

  function simpleRsi(candles,i,period=14){
    if(i<period)return 50;
    let gains=0,losses=0;
    for(let j=i-period+1;j<=i;j++){const d=candles[j].close-candles[j-1].close;if(d>=0)gains+=d;else losses-=d;}
    if(losses===0)return 100;
    const rs=(gains/period)/(losses/period);return 100-(100/(1+rs));
  }

  function regimeAt(candles,i){
    if(i<72)return "RANGE";
    const r24=pct(candles[i].close,candles[i-24].close),r72=pct(candles[i].close,candles[i-72].close);
    if(r24>0.8&&r72>1.2)return "UP";
    if(r24<-0.8&&r72<-1.2)return "DOWN";
    return "RANGE";
  }

  function coverage(rows){
    if(!rows.length)return {count:0,hours:0,days:0,start:null,end:null};
    const start=Number(rows[0].timestamp),end=Number(rows[rows.length-1].timestamp);
    const hours=Math.max(0,(end-start)/3600000);
    return {count:rows.length,hours,days:hours/24,start,end};
  }

  function normalizeFeeds(raw){
    return {
      funding:sortedFeed(raw&&raw.funding),
      openInterest:sortedFeed(raw&&raw.openInterest),
      longShort:sortedFeed(raw&&raw.longShort),
      taker:sortedFeed(raw&&raw.taker)
    };
  }

  function buildAlignedRows(candles,rawFeeds){
    const feeds=normalizeFeeds(rawFeeds),rows=[];
    for(let i=72;i<candles.length;i++){
      const c=candles[i],closeTs=Number(c.closedAt||(c.t+3600000-1));
      const oi=lastAtOrBefore(feeds.openInterest,closeTs,3*3600000);
      const ls=lastAtOrBefore(feeds.longShort,closeTs,3*3600000);
      const tk=lastAtOrBefore(feeds.taker,closeTs,3*3600000);
      const fr=lastAtOrBefore(feeds.funding,closeTs,12*3600000);
      if(!oi||!ls||!tk||!fr)continue;

      const prevOi=lastAtOrBefore(feeds.openInterest,closeTs-3600000,4*3600000);
      const prevOi4=lastAtOrBefore(feeds.openInterest,closeTs-4*3600000,6*3600000);
      const prevLs4=lastAtOrBefore(feeds.longShort,closeTs-4*3600000,6*3600000);
      const prevTk4=lastAtOrBefore(feeds.taker,closeTs-4*3600000,6*3600000);
      const prevFunding=lastAtOrBefore(feeds.funding,closeTs-8*3600000,20*3600000);
      if(!prevOi||!prevOi4||!prevLs4||!prevTk4||!prevFunding)continue;

      const oiNow=Number(oi.sumOpenInterest),oi1=Number(prevOi.sumOpenInterest),oi4=Number(prevOi4.sumOpenInterest);
      const oiValue=Number(oi.sumOpenInterestValue);
      const funding=Number(fr.fundingRate)*100,fundingPrev=Number(prevFunding.fundingRate)*100;
      const longShort=Number(ls.longShortRatio),longShort4=Number(prevLs4.longShortRatio);
      const takerRatio=Number(tk.buySellRatio),takerRatio4=Number(prevTk4.buySellRatio);
      const buyVol=Number(tk.buyVol),sellVol=Number(tk.sellVol);
      const ret1=pct(c.close,candles[i-1].close),ret4=pct(c.close,candles[i-4].close),ret24=pct(c.close,candles[i-24].close);
      const oiChg1=pct(oiNow,oi1),oiChg4=pct(oiNow,oi4);
      const lsLog=Math.log(Math.max(longShort,1e-6)),lsChg4=pct(longShort,longShort4);
      const takerLog=Math.log(Math.max(takerRatio,1e-6)),takerChg4=pct(takerRatio,takerRatio4);
      const imbalance=(buyVol-sellVol)/Math.max(1e-9,buyVol+sellVol);
      const rsi=(simpleRsi(candles,i)-50)/10;

      const vector=[ret1,ret4,ret24,rsi,funding,funding-fundingPrev,oiChg1,oiChg4,Math.log(Math.max(oiValue,1))/10,lsLog,lsChg4,takerLog,takerChg4,imbalance,ret4*oiChg4,ret4*takerLog,funding*oiChg4];
      if(vector.some(v=>!Number.isFinite(v)))continue;
      rows.push({candleIndex:i,timestamp:closeTs,regime:regimeAt(candles,i),vector,price:c.close,snapshot:{funding,oiNow,oiChg4,longShort,takerRatio,imbalance}});
    }
    return {rows,coverage:{funding:coverage(feeds.funding),openInterest:coverage(feeds.openInterest),longShort:coverage(feeds.longShort),taker:coverage(feeds.taker)}};
  }

  function buildSamples(candles,aligned,horizon){
    const out=[];
    for(const row of aligned){
      const futureIndex=row.candleIndex+horizon;
      if(futureIndex>=candles.length)continue;
      const futureReturn=pct(candles[futureIndex].close,candles[row.candleIndex].close);
      out.push({index:row.candleIndex,vector:row.vector,regime:row.regime,y:futureReturn>0?1:0,futureReturn});
    }
    return out;
  }

  function scaler(samples){
    const dim=samples[0].vector.length,means=[],scales=[];
    for(let d=0;d<dim;d++){const col=samples.map(s=>s.vector[d]);means.push(mean(col));scales.push(std(col));}
    return {means,scales};
  }
  function zvec(v,s){return v.map((x,d)=>(x-s.means[d])/s.scales[d]);}

  function trainLogistic(samples){
    if(samples.length<120)return null;
    const sc=scaler(samples),dim=samples[0].vector.length,w=new Array(dim+1).fill(0),lr=0.04,lambda=0.004;
    for(let epoch=0;epoch<52;epoch++){
      const grad=new Array(dim+1).fill(0);
      for(const sample of samples){
        const x=zvec(sample.vector,sc);let pred=w[0];for(let d=0;d<dim;d++)pred+=w[d+1]*x[d];
        const err=sigmoid(pred)-sample.y;grad[0]+=err;for(let d=0;d<dim;d++)grad[d+1]+=err*x[d];
      }
      w[0]-=lr*grad[0]/samples.length;for(let d=0;d<dim;d++)w[d+1]-=lr*(grad[d+1]/samples.length+lambda*w[d+1]);
    }
    return {w,sc};
  }
  function logisticProbability(model,v){if(!model)return 0.5;const x=zvec(v,model.sc);let z=model.w[0];for(let d=0;d<x.length;d++)z+=model.w[d+1]*x[d];return sigmoid(z);}

  function trainRidge(samples){
    if(samples.length<120)return null;
    const sc=scaler(samples),targets=samples.map(s=>s.futureReturn),targetMean=mean(targets),targetScale=std(targets),dim=samples[0].vector.length,w=new Array(dim+1).fill(0),lr=0.03,lambda=0.005;
    for(let epoch=0;epoch<50;epoch++){
      const grad=new Array(dim+1).fill(0);
      for(const sample of samples){
        const x=zvec(sample.vector,sc);let pred=w[0];for(let d=0;d<dim;d++)pred+=w[d+1]*x[d];
        const y=(sample.futureReturn-targetMean)/targetScale,err=pred-y;grad[0]+=err;for(let d=0;d<dim;d++)grad[d+1]+=err*x[d];
      }
      w[0]-=lr*grad[0]/samples.length;for(let d=0;d<dim;d++)w[d+1]-=lr*(grad[d+1]/samples.length+lambda*w[d+1]);
    }
    return {w,sc,targetMean,targetScale};
  }
  function ridgeExpected(model,v){if(!model)return 0;const x=zvec(v,model.sc);let p=model.w[0];for(let d=0;d<x.length;d++)p+=model.w[d+1]*x[d];return model.targetMean+p*model.targetScale;}
  function ridgeProbability(model,v,horizon){const expected=ridgeExpected(model,v),scale=horizon===1?0.30:horizon===4?0.65:1.5;return sigmoid(expected/scale);}

  function trainModels(samples){return {derivLogistic:trainLogistic(samples),derivRidge:trainRidge(samples)};}
  function probabilityFor(key,models,sample,horizon){return key==="derivLogistic"?logisticProbability(models.derivLogistic,sample.vector):ridgeProbability(models.derivRidge,sample.vector,horizon);}

  function chooseEdge(rows,costPct){
    const grid=[0.04,0.06,0.08,0.10,0.13,0.16,0.20,0.25],minSignals=Math.max(12,Math.floor(rows.length*0.06));let best=null;
    for(const edge of grid){
      let signals=0,sum=0,gain=0,loss=0;
      for(const r of rows){const action=r.p>=0.5+edge?"LONG":r.p<=0.5-edge?"SHORT":"NEUTRAL";if(action==="NEUTRAL")continue;signals++;const net=(action==="LONG"?r.futureReturn:-r.futureReturn)-costPct;sum+=net;if(net>0)gain+=net;else loss+=Math.abs(net);}
      if(signals<minSignals)continue;
      const avg=sum/signals,pf=loss>0?gain/loss:(gain>0?99:0);
      if(avg<=0||pf<1)continue;
      const score=avg*Math.sqrt(signals);if(!best||score>best.score)best={edge,signals,avg,pf,score};
    }
    return best||{edge:0.30,signals:0,avg:0,pf:0,score:0};
  }

  function evaluate(records,costPct,totalTested,totalFolds){
    let signals=0,wins=0,sum=0,gain=0,loss=0;const folds={},regimes={UP:{signals:0,sum:0},DOWN:{signals:0,sum:0},RANGE:{signals:0,sum:0}};
    for(const r of records){
      if(r.action==="NEUTRAL")continue;signals++;const net=(r.action==="LONG"?r.futureReturn:-r.futureReturn)-costPct;sum+=net;if(net>0){wins++;gain+=net;}else loss+=Math.abs(net);
      if(!folds[r.fold])folds[r.fold]={signals:0,sum:0};folds[r.fold].signals++;folds[r.fold].sum+=net;
      const rg=regimes[r.regime]||regimes.RANGE;rg.signals++;rg.sum+=net;
    }
    let positiveFolds=0;for(let i=0;i<totalFolds;i++){const f=folds[i];if(f&&f.signals&&f.sum/f.signals>0)positiveFolds++;}
    const regimeStats={};for(const key of ["UP","DOWN","RANGE"]){const r=regimes[key];regimeStats[key]={signals:r.signals,avgNetMove:r.signals?r.sum/r.signals:0};}
    return {tested:totalTested,signals,coverage:totalTested?signals/totalTested:0,winRate:signals?wins/signals:0,avgNetMove:signals?sum/signals:0,profitFactor:loss>0?gain/loss:(gain>0?99:0),positiveFolds,totalFolds,regimes:regimeStats};
  }

  function validate(metric){
    const qualified=Object.values(metric.regimes).filter(r=>r.signals>=10),positive=qualified.filter(r=>r.avgNetMove>0),reasons=[];
    const enough=metric.signals>=40,profitable=metric.avgNetMove>0,pfOk=metric.profitFactor>=1.05,foldOk=metric.totalFolds>=3&&metric.positiveFolds>=2,regimeOk=qualified.length>=2&&positive.length>=2;
    if(!enough)reasons.push("短期訊號樣本不足");if(!profitable)reasons.push("扣成本後平均淨變動≤0");if(!pfOk)reasons.push("Profit Factor 未達 1.05");if(!foldOk)reasons.push("短期 walk-forward 穩定性不足");if(!regimeOk)reasons.push("短期跨盤勢穩定性不足");
    return {passed:enough&&profitable&&pfOk&&foldOk&&regimeOk,reasons};
  }

  function walkForward(samples,horizon,costPct){
    if(samples.length<220)return null;
    const folds=3,firstTest=Math.max(160,Math.floor(samples.length*0.55)),remain=samples.length-firstTest,foldSize=Math.max(1,Math.floor(remain/folds));
    const records={derivLogistic:[],derivRidge:[]};let actualFolds=0,tested=0;
    for(let fold=0;fold<folds;fold++){
      const start=firstTest+fold*foldSize,end=fold===folds-1?samples.length:Math.min(samples.length,start+foldSize);
      if(start>=samples.length||end<=start)continue;
      const train=samples.slice(0,start);if(train.length<150)continue;
      const calStart=Math.max(120,Math.floor(train.length*0.78)),fit=train.slice(0,calStart),calibration=train.slice(calStart);
      if(fit.length<120||calibration.length<30)continue;
      const fitModels=trainModels(fit),edges={};
      for(const key of MODELS){const rows=calibration.map(s=>({p:probabilityFor(key,fitModels,s,horizon),futureReturn:s.futureReturn}));edges[key]=chooseEdge(rows,costPct).edge;}
      const foldId=actualFolds++;tested+=end-start;
      for(let j=start;j<end;j++){const sample=samples[j];for(const key of MODELS){const prob=probabilityFor(key,fitModels,sample,horizon),e=edges[key],action=prob>=0.5+e?"LONG":prob<=0.5-e?"SHORT":"NEUTRAL";records[key].push({fold:foldId,regime:sample.regime,futureReturn:sample.futureReturn,action});}}
    }
    const metrics={};for(const key of MODELS){metrics[key]=evaluate(records[key],costPct,tested,actualFolds);metrics[key].validation=validate(metrics[key]);}
    return {folds:actualFolds,tested,metrics};
  }

  function currentModel(key,models,latest,horizon,edge){
    const p=key==="derivLogistic"?logisticProbability(models.derivLogistic,latest.vector):ridgeProbability(models.derivRidge,latest.vector,horizon);
    const action=p>=0.5+edge?"LONG":p<=0.5-edge?"SHORT":"NEUTRAL";
    return {probabilityUp:p,confidence:clamp(50+Math.abs(p-0.5)*100,50,95),action,edge};
  }

  function run(candles,rawFeeds,options={}){
    const alignedResult=buildAlignedRows(candles,rawFeeds),aligned=alignedResult.rows,fee=Number(options.feeRate)||0,slip=Number(options.slippageRate)||0,costPct=2*(fee+slip)*100;
    const output={available:false,coverage:alignedResult.coverage,alignedCount:aligned.length,generatedAt:new Date().toISOString(),horizons:{},latestSnapshot:aligned.length?aligned[aligned.length-1].snapshot:null,note:"衍生品增強模型只在公開衍生品資料實際覆蓋的短期區間驗證，不把短期結果當成長期證明。"};
    if(aligned.length<260){output.reason="可對齊的衍生品 1H 樣本不足 260 根";return output;}

    for(const h of HORIZONS){
      const samples=buildSamples(candles,aligned,h.steps);
      if(samples.length<220){output.horizons[h.key]={available:false,reason:"該週期有效樣本不足",models:[]};continue;}
      const wf=walkForward(samples,h.steps,costPct);
      if(!wf){output.horizons[h.key]={available:false,reason:"無法完成短期 walk-forward",models:[]};continue;}

      const calStart=Math.max(150,Math.floor(samples.length*0.80)),fit=samples.slice(0,calStart),calibration=samples.slice(calStart),fitModels=trainModels(fit),finalEdges={};
      for(const key of MODELS){const rows=calibration.map(s=>({p:probabilityFor(key,fitModels,s,h.steps),futureReturn:s.futureReturn}));finalEdges[key]=chooseEdge(rows,costPct).edge;}
      const trained=trainModels(samples),latest=aligned[aligned.length-1];
      const models=MODELS.map(key=>({key,label:LABELS[key],current:currentModel(key,trained,latest,h.steps,finalEdges[key]),metrics:wf.metrics[key],validation:wf.metrics[key].validation}));
      const passed=models.filter(m=>m.validation.passed&&m.current.action!=="NEUTRAL");

      let consensus={action:"NEUTRAL",validated:false,confidence:50,reason:"沒有衍生品模型通過短期完整驗證"};
      if(passed.length){let score=0;for(const m of passed)score+=(m.current.action==="LONG"?1:-1)*m.current.confidence;const action=Math.abs(score)<10?"NEUTRAL":score>0?"LONG":"SHORT";consensus={action,validated:action!=="NEUTRAL",confidence:clamp(50+Math.abs(score)/passed.length*0.22,50,80),reason:action==="NEUTRAL"?"通過驗證的衍生品模型方向分歧":"只整合通過短期完整驗證的衍生品模型"};}
      output.horizons[h.key]={available:true,models,consensus,sampleCount:samples.length,folds:wf.folds};
    }
    output.available=true;return output;
  }

  window.BTCDerivatives={run};
})();