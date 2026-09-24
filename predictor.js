(() => {
  "use strict";

  const HORIZONS = [
    { key:"1h", steps:1, label:"1H" },
    { key:"4h", steps:4, label:"4H" },
    { key:"24h", steps:24, label:"24H" }
  ];
  const MIN_HISTORY = 180;
  const MODEL_ORDER = ["rules","logistic","ridgeReturn","naiveBayes","stumps"];

  function clamp(n,min,max){ return Math.min(max,Math.max(min,n)); }
  function sigmoid(z){
    if(z >= 0){
      const e=Math.exp(-z);
      return 1/(1+e);
    }
    const e=Math.exp(z);
    return e/(1+e);
  }
  function mean(values){
    return values.length ? values.reduce((a,b)=>a+b,0)/values.length : 0;
  }
  function std(values){
    if(values.length < 2) return 1;
    const m=mean(values);
    const v=values.reduce((a,b)=>a+(b-m)*(b-m),0)/(values.length-1);
    const s=Math.sqrt(v);
    return s > 1e-9 ? s : 1;
  }
  function sma(values,period){
    if(values.length < period) return NaN;
    let sum=0;
    for(let i=values.length-period;i<values.length;i++) sum+=values[i];
    return sum/period;
  }
  function ema(values,period){
    if(!values.length) return NaN;
    const alpha=2/(period+1);
    let out=values[0];
    for(let i=1;i<values.length;i++) out=alpha*values[i]+(1-alpha)*out;
    return out;
  }
  function rsi(values,period=14){
    if(values.length <= period) return NaN;
    let gains=0,losses=0;
    for(let i=values.length-period;i<values.length;i++){
      const d=values[i]-values[i-1];
      if(d>=0) gains+=d;
      else losses-=d;
    }
    if(losses===0) return 100;
    const rs=(gains/period)/(losses/period);
    return 100-(100/(1+rs));
  }
  function atr(candles,endIndex,period=14){
    if(endIndex < period) return NaN;
    let sum=0;
    for(let i=endIndex-period+1;i<=endIndex;i++){
      const prevClose=i>0?candles[i-1].close:candles[i].close;
      const tr=Math.max(
        candles[i].high-candles[i].low,
        Math.abs(candles[i].high-prevClose),
        Math.abs(candles[i].low-prevClose)
      );
      sum+=tr;
    }
    return sum/period;
  }

  function featureAt(candles,i){
    if(i < MIN_HISTORY || i >= candles.length) return null;
    const start=Math.max(0,i-200);
    const subset=candles.slice(start,i+1);
    const closes=subset.map(c=>c.close);
    const volumes=subset.map(c=>c.volume);
    const price=candles[i].close;

    const close1=candles[i-1].close;
    const close4=candles[i-4].close;
    const close12=candles[i-12].close;
    const close24=candles[i-24].close;
    const close72=candles[i-72].close;

    const s10=sma(closes,10);
    const s20=sma(closes,20);
    const s50=sma(closes,50);
    const s100=sma(closes,100);
    const prev20=sma(closes.slice(0,-12),20);
    const r14=rsi(closes,14);
    const e12=ema(closes.slice(-100),12);
    const e26=ema(closes.slice(-100),26);
    const a14=atr(candles,i,14);
    const atrPct=Number.isFinite(a14)?a14/price*100:0;

    const returns=(period)=>{
      const out=[];
      for(let j=Math.max(1,i-period+1);j<=i;j++){
        out.push((candles[j].close/candles[j-1].close-1)*100);
      }
      return out;
    };
    const vol6=std(returns(6));
    const vol24=std(returns(24));
    const vol72=std(returns(72));

    const recent24=candles.slice(i-23,i+1);
    const recent72=candles.slice(i-71,i+1);
    const high24=Math.max(...recent24.map(c=>c.high));
    const low24=Math.min(...recent24.map(c=>c.low));
    const high72=Math.max(...recent72.map(c=>c.high));
    const low72=Math.min(...recent72.map(c=>c.low));
    const range24=Math.max(1e-9,high24-low24);
    const range72=Math.max(1e-9,high72-low72);

    const avgVol20=mean(volumes.slice(-20));
    const avgVol72=mean(volumes.slice(-72));
    const bbStd=std(closes.slice(-20));
    const bbZ=bbStd>0?(price-s20)/bbStd:0;
    const candleRange=Math.max(1e-9,candles[i].high-candles[i].low);
    const bodyRatio=(candles[i].close-candles[i].open)/candleRange;
    const trendGap=(s20/s100-1)*100;
    const trendSlope=Number.isFinite(prev20)?(s20/prev20-1)*100:0;

    const ret1=(price/close1-1)*100;
    const ret4=(price/close4-1)*100;
    const ret12=(price/close12-1)*100;
    const ret24=(price/close24-1)*100;
    const ret72=(price/close72-1)*100;

    let regime="RANGE";
    const regimeThreshold=Math.max(0.45,atrPct*0.65);
    if(trendGap>regimeThreshold && ret72>0 && trendSlope>=0) regime="UP";
    else if(trendGap<-regimeThreshold && ret72<0 && trendSlope<=0) regime="DOWN";

    const hour=new Date(candles[i].t).getUTCHours();
    const hourSin=Math.sin(2*Math.PI*hour/24);
    const hourCos=Math.cos(2*Math.PI*hour/24);

    const obj={
      ret1,ret4,ret12,ret24,ret72,
      sma10Dist:(price/s10-1)*100,
      sma20Dist:(price/s20-1)*100,
      sma50Dist:(price/s50-1)*100,
      sma100Dist:(price/s100-1)*100,
      rsi:r14,
      emaDiff:(e12/e26-1)*100,
      atrPct,
      vol6,vol24,vol72,
      volume20:avgVol20>0?candles[i].volume/avgVol20-1:0,
      volume72:avgVol72>0?candles[i].volume/avgVol72-1:0,
      range24:((price-low24)/range24)*2-1,
      range72:((price-low72)/range72)*2-1,
      bbZ,
      bodyRatio,
      trendSlope,
      hourSin,
      hourCos,
      regime
    };
    obj.vector=[
      obj.ret1,obj.ret4,obj.ret12,obj.ret24,obj.ret72,
      obj.sma10Dist,obj.sma20Dist,obj.sma50Dist,obj.sma100Dist,
      obj.emaDiff,(obj.rsi-50)/10,obj.atrPct,
      obj.vol6,obj.vol24,obj.vol72,
      obj.volume20,obj.volume72,obj.range24,obj.range72,
      obj.bbZ,obj.bodyRatio,obj.trendSlope,obj.hourSin,obj.hourCos
    ];
    if(obj.vector.some(v=>!Number.isFinite(v))) return null;
    return obj;
  }

  function neutralEdge(horizon){
    if(horizon===1) return 0.095;
    if(horizon===4) return 0.075;
    return 0.055;
  }

  function actionFromProbability(p,horizon,edgeOverride){
    const edge=Number.isFinite(edgeOverride)?edgeOverride:neutralEdge(horizon);
    if(p>=0.5+edge) return "LONG";
    if(p<=0.5-edge) return "SHORT";
    return "NEUTRAL";
  }

  function probabilityConfidence(p){
    return clamp(50+Math.abs(p-0.5)*100,50,97);
  }

  function rulePredict(f,horizon){
    let score=0,total=0;
    const vote=(condition,weight)=>{
      total+=Math.abs(weight);
      if(condition>0) score+=weight;
      else if(condition<0) score-=weight;
    };

    if(horizon===1){
      vote(Math.sign(f.ret4),1.0);
      vote(Math.sign(f.sma10Dist),0.9);
      vote(Math.sign(f.emaDiff),1.0);
      vote(f.rsi>57?1:f.rsi<43?-1:0,0.7);
      vote(Math.sign(f.range24),0.5);
      vote(Math.sign(f.bodyRatio),0.4);
      vote(f.bbZ>1?-1:f.bbZ<-1?1:0,0.45);
    }else if(horizon===4){
      vote(Math.sign(f.ret12),0.9);
      vote(Math.sign(f.ret24),0.8);
      vote(Math.sign(f.sma20Dist),1.0);
      vote(Math.sign(f.sma50Dist),1.0);
      vote(Math.sign(f.emaDiff),1.0);
      vote(Math.sign(f.trendSlope),0.7);
      vote(f.rsi>55?1:f.rsi<45?-1:0,0.6);
    }else{
      vote(Math.sign(f.ret24),0.7);
      vote(Math.sign(f.ret72),1.1);
      vote(Math.sign(f.sma20Dist),0.8);
      vote(Math.sign(f.sma50Dist),1.0);
      vote(Math.sign(f.sma100Dist),1.2);
      vote(Math.sign(f.trendSlope),0.9);
      vote(f.regime==="UP"?1:f.regime==="DOWN"?-1:0,1.0);
    }

    const normalized=total?score/total:0;
    const probabilityUp=clamp(0.5+normalized*0.42,0.03,0.97);
    return {
      action:actionFromProbability(probabilityUp,horizon),
      confidence:probabilityConfidence(probabilityUp),
      probabilityUp,
      score:normalized
    };
  }

  function buildSamples(candles,horizon){
    const out=[];
    for(let i=MIN_HISTORY;i<candles.length-horizon;i++){
      const f=featureAt(candles,i);
      if(!f) continue;
      const futureReturn=(candles[i+horizon].close/candles[i].close-1)*100;
      out.push({
        index:i,
        x:f.vector,
        features:f,
        regime:f.regime,
        y:futureReturn>0?1:0,
        futureReturn
      });
    }
    return out;
  }

  function trainLogistic(samples,epochs=120,learningRate=0.055){
    if(samples.length<180) return null;
    const dim=samples[0].x.length;
    const means=[];
    const scales=[];
    for(let d=0;d<dim;d++){
      const col=samples.map(s=>s.x[d]);
      means.push(mean(col));
      scales.push(std(col));
    }
    const w=new Array(dim+1).fill(0);
    const lambda=0.002;

    for(let epoch=0;epoch<epochs;epoch++){
      const grad=new Array(dim+1).fill(0);
      for(const sample of samples){
        let z=w[0];
        for(let d=0;d<dim;d++) z+=w[d+1]*((sample.x[d]-means[d])/scales[d]);
        const p=sigmoid(z);
        const err=p-sample.y;
        grad[0]+=err;
        for(let d=0;d<dim;d++) grad[d+1]+=err*((sample.x[d]-means[d])/scales[d]);
      }
      const n=samples.length;
      w[0]-=learningRate*(grad[0]/n);
      for(let d=0;d<dim;d++){
        const regularized=grad[d+1]/n+lambda*w[d+1];
        w[d+1]-=learningRate*regularized;
      }
    }
    return {w,means,scales};
  }

  function probability(model,x){
    if(!model) return 0.5;
    let z=model.w[0];
    for(let d=0;d<x.length;d++) z+=model.w[d+1]*((x[d]-model.means[d])/model.scales[d]);
    return sigmoid(z);
  }

  function trainRidgeReturn(samples,epochs=48,learningRate=0.035){
    if(samples.length<180) return null;
    const dim=samples[0].x.length;
    const means=[],scales=[];
    for(let d=0;d<dim;d++){
      const col=samples.map(s=>s.x[d]);
      means.push(mean(col));
      scales.push(std(col));
    }
    const targets=samples.map(s=>s.futureReturn);
    const targetMean=mean(targets);
    const targetScale=std(targets);
    const w=new Array(dim+1).fill(0);
    const lambda=0.004;

    for(let epoch=0;epoch<epochs;epoch++){
      const grad=new Array(dim+1).fill(0);
      for(const sample of samples){
        let pred=w[0];
        for(let d=0;d<dim;d++) pred+=w[d+1]*((sample.x[d]-means[d])/scales[d]);
        const y=(sample.futureReturn-targetMean)/targetScale;
        const err=pred-y;
        grad[0]+=err;
        for(let d=0;d<dim;d++) grad[d+1]+=err*((sample.x[d]-means[d])/scales[d]);
      }
      w[0]-=learningRate*grad[0]/samples.length;
      for(let d=0;d<dim;d++){
        w[d+1]-=learningRate*(grad[d+1]/samples.length+lambda*w[d+1]);
      }
    }
    return {w,means,scales,targetMean,targetScale};
  }

  function predictRidgeReturn(model,x){
    if(!model) return 0;
    let pred=model.w[0];
    for(let d=0;d<x.length;d++) pred+=model.w[d+1]*((x[d]-model.means[d])/model.scales[d]);
    return model.targetMean+pred*model.targetScale;
  }

  function ridgeProbability(model,x,horizon){
    const expected=predictRidgeReturn(model,x);
    const scale=horizon===1?0.35:horizon===4?0.75:1.8;
    return sigmoid(expected/scale);
  }

  function trainNaiveBayes(samples){
    if(samples.length<180) return null;
    const dim=samples[0].x.length;
    const groups=[samples.filter(s=>s.y===0),samples.filter(s=>s.y===1)];
    if(groups[0].length<40 || groups[1].length<40) return null;
    const means=[new Array(dim),new Array(dim)];
    const variances=[new Array(dim),new Array(dim)];
    for(let c=0;c<2;c++){
      for(let d=0;d<dim;d++){
        const col=groups[c].map(s=>s.x[d]);
        means[c][d]=mean(col);
        const sd=std(col);
        variances[c][d]=Math.max(sd*sd,1e-5);
      }
    }
    return {
      means,
      variances,
      priors:[groups[0].length/samples.length,groups[1].length/samples.length]
    };
  }

  function probabilityNaiveBayes(model,x){
    if(!model) return 0.5;
    const logp=[Math.log(model.priors[0]),Math.log(model.priors[1])];
    for(let c=0;c<2;c++){
      for(let d=0;d<x.length;d++){
        const variance=model.variances[c][d];
        const diff=x[d]-model.means[c][d];
        logp[c]+=-0.5*Math.log(2*Math.PI*variance)-(diff*diff)/(2*variance);
      }
    }
    const m=Math.max(logp[0],logp[1]);
    const p0=Math.exp(logp[0]-m);
    const p1=Math.exp(logp[1]-m);
    return p1/(p0+p1);
  }

  function quantile(sorted,q){
    if(!sorted.length) return 0;
    const pos=(sorted.length-1)*q;
    const lo=Math.floor(pos),hi=Math.ceil(pos);
    if(lo===hi) return sorted[lo];
    const t=pos-lo;
    return sorted[lo]*(1-t)+sorted[hi]*t;
  }

  function trainStumps(samples){
    if(samples.length<180) return null;
    const dim=samples[0].x.length;
    const candidates=[];
    const qs=[0.15,0.30,0.50,0.70,0.85];
    for(let d=0;d<dim;d++){
      const values=samples.map(s=>s.x[d]).sort((a,b)=>a-b);
      for(const q of qs){
        const threshold=quantile(values,q);
        let correctUp=0,correctDown=0;
        for(const sample of samples){
          const above=sample.x[d]>=threshold?1:0;
          if(above===sample.y) correctUp++;
          if((1-above)===sample.y) correctDown++;
        }
        const upAcc=correctUp/samples.length;
        const downAcc=correctDown/samples.length;
        const orientation=upAcc>=downAcc?1:-1;
        const accuracy=Math.max(upAcc,downAcc);
        const edge=accuracy-0.5;
        if(edge>0.008) candidates.push({d,threshold,orientation,weight:edge});
      }
    }
    candidates.sort((a,b)=>b.weight-a.weight);
    const selected=[];
    const perFeature={};
    for(const candidate of candidates){
      perFeature[candidate.d]=perFeature[candidate.d]||0;
      if(perFeature[candidate.d]>=2) continue;
      selected.push(candidate);
      perFeature[candidate.d]++;
      if(selected.length>=16) break;
    }
    return {stumps:selected};
  }

  function probabilityStumps(model,x){
    if(!model || !model.stumps.length) return 0.5;
    let vote=0,total=0;
    for(const stump of model.stumps){
      const side=x[stump.d]>=stump.threshold?1:-1;
      vote+=side*stump.orientation*stump.weight;
      total+=stump.weight;
    }
    return clamp(0.5+(vote/Math.max(total,1e-9))*0.38,0.05,0.95);
  }

  const MODEL_LABELS={
    rules:"規則基準",
    logistic:"Logistic",
    ridgeReturn:"Ridge Return",
    naiveBayes:"Naive Bayes",
    stumps:"Stump Ensemble"
  };

  function trainModels(samples){
    return {
      logistic:trainLogistic(samples,58,0.045),
      ridgeReturn:trainRidgeReturn(samples),
      naiveBayes:trainNaiveBayes(samples),
      stumps:trainStumps(samples)
    };
  }

  function modelProbability(key,trained,sample,horizon){
    if(key==="rules") return rulePredict(sample.features,horizon).probabilityUp;
    if(key==="logistic") return probability(trained.logistic,sample.x);
    if(key==="ridgeReturn") return ridgeProbability(trained.ridgeReturn,sample.x,horizon);
    if(key==="naiveBayes") return probabilityNaiveBayes(trained.naiveBayes,sample.x);
    if(key==="stumps") return probabilityStumps(trained.stumps,sample.x);
    return 0.5;
  }

  function mlAction(p,horizon){
    return actionFromProbability(p,horizon);
  }

  function mlConfidence(p){
    return probabilityConfidence(p);
  }

  function emptyRegimes(){
    return {
      UP:{signals:0,wins:0,sumNet:0,grossWin:0,grossLoss:0},
      DOWN:{signals:0,wins:0,sumNet:0,grossWin:0,grossLoss:0},
      RANGE:{signals:0,wins:0,sumNet:0,grossWin:0,grossLoss:0}
    };
  }

  function evaluateRecords(records,costPct,tested,foldCount){
    let signals=0,wins=0,sumNet=0,grossWin=0,grossLoss=0;
    const folds={};
    const rawRegimes=emptyRegimes();

    for(const rec of records){
      if(rec.action==="NEUTRAL") continue;
      signals++;
      const directional=rec.action==="LONG"?rec.futureReturn:-rec.futureReturn;
      const net=directional-costPct;
      sumNet+=net;
      if(net>0){ wins++; grossWin+=net; }
      else grossLoss+=Math.abs(net);

      if(!folds[rec.fold]) folds[rec.fold]={signals:0,sumNet:0};
      folds[rec.fold].signals++;
      folds[rec.fold].sumNet+=net;

      const regime=rawRegimes[rec.regime]||rawRegimes.RANGE;
      regime.signals++;
      regime.sumNet+=net;
      if(net>0){ regime.wins++; regime.grossWin+=net; }
      else regime.grossLoss+=Math.abs(net);
    }

    let positiveFolds=0,activeFolds=0;
    for(let fold=0;fold<foldCount;fold++){
      const f=folds[fold];
      if(!f || !f.signals) continue;
      activeFolds++;
      if(f.sumNet/f.signals>0) positiveFolds++;
    }

    const regimes={};
    for(const key of ["UP","DOWN","RANGE"]){
      const x=rawRegimes[key];
      regimes[key]={
        signals:x.signals,
        winRate:x.signals?x.wins/x.signals:0,
        avgNetMove:x.signals?x.sumNet/x.signals:0,
        profitFactor:x.grossLoss>0?x.grossWin/x.grossLoss:(x.grossWin>0?99:0)
      };
    }

    return {
      tested,
      signals,
      coverage:tested?signals/tested:0,
      winRate:signals?wins/signals:0,
      avgNetMove:signals?sumNet/signals:0,
      profitFactor:grossLoss>0?grossWin/grossLoss:(grossWin>0?99:0),
      positiveFolds,
      activeFolds,
      totalFolds:foldCount,
      regimes
    };
  }

  function validateMetrics(metrics){
    const reasons=[];
    const enoughSignals=metrics.signals>=80;
    const profitable=metrics.avgNetMove>0;
    const pfOk=metrics.profitFactor>=1.05;
    const foldOk=metrics.activeFolds>=4 && metrics.positiveFolds>=Math.ceil(metrics.activeFolds*0.60);

    const qualified=Object.values(metrics.regimes).filter(r=>r.signals>=24);
    const positive=qualified.filter(r=>r.avgNetMove>0);
    const severeNegative=qualified.some(r=>r.avgNetMove<-0.12);
    const regimeOk=qualified.length>=2 && positive.length>=2 && !severeNegative;

    if(!enoughSignals) reasons.push("訊號樣本不足");
    if(!profitable) reasons.push("扣成本後平均淨變動≤0");
    if(!pfOk) reasons.push("Profit Factor 未達 1.05");
    if(!foldOk) reasons.push("跨時間折數一致性不足");
    if(!regimeOk) reasons.push("跨盤勢穩定性不足");

    const foldRatio=metrics.activeFolds?metrics.positiveFolds/metrics.activeFolds:0;
    const regimeRatio=qualified.length?positive.length/qualified.length:0;
    const score=clamp(
      45+
      (metrics.winRate-0.5)*70+
      Math.min(12,metrics.avgNetMove*20)+
      Math.min(10,Math.max(0,metrics.profitFactor-1)*10)+
      foldRatio*8+
      regimeRatio*7,
      0,90
    );

    return {
      passed:enoughSignals && profitable && pfOk && foldOk && regimeOk,
      score,
      reasons
    };
  }

  function chooseEdge(rows,horizon,costPct){
    if(!rows.length) return {edge:neutralEdge(horizon),signals:0,avgNetMove:0};
    const grid=[0.03,0.05,0.07,0.09,0.12,0.15,0.18,0.22,0.28];
    const minSignals=Math.max(20,Math.floor(rows.length*0.04));
    let best=null;

    for(const edge of grid){
      let signals=0,sumNet=0,grossWin=0,grossLoss=0;
      for(const row of rows){
        const action=actionFromProbability(row.probabilityUp,horizon,edge);
        if(action==="NEUTRAL") continue;
        signals++;
        const directional=action==="LONG"?row.futureReturn:-row.futureReturn;
        const net=directional-costPct;
        sumNet+=net;
        if(net>0) grossWin+=net;
        else grossLoss+=Math.abs(net);
      }
      if(signals<minSignals) continue;
      const avgNetMove=sumNet/signals;
      const profitFactor=grossLoss>0?grossWin/grossLoss:(grossWin>0?99:0);
      if(avgNetMove<=0 || profitFactor<1) continue;
      const score=avgNetMove*Math.sqrt(signals)*(0.8+Math.min(2,profitFactor)*0.1);
      if(!best || score>best.score) best={edge,signals,avgNetMove,profitFactor,score};
    }

    if(!best) return {edge:0.32,signals:0,avgNetMove:0,profitFactor:0};
    return best;
  }

  function calibrateEdges(calibration,trained,horizon,costPct){
    const edges={};
    for(const key of MODEL_ORDER){
      const rows=calibration.map(sample=>({
        probabilityUp:modelProbability(key,trained,sample,horizon),
        futureReturn:sample.futureReturn
      }));
      edges[key]=chooseEdge(rows,horizon,costPct);
    }
    return edges;
  }

  function walkForward(samples,horizon,costPct){
    const requestedFolds=5;
    const firstTest=Math.max(360,Math.floor(samples.length*0.50));
    const remaining=samples.length-firstTest;
    const foldSize=Math.max(1,Math.floor(remaining/requestedFolds));
    const records={};
    const edgeTrack={};
    for(const key of MODEL_ORDER){ records[key]=[]; edgeTrack[key]=[]; }
    let actualFolds=0;
    let tested=0;

    for(let fold=0;fold<requestedFolds;fold++){
      const start=firstTest+fold*foldSize;
      const end=fold===requestedFolds-1?samples.length:Math.min(samples.length,start+foldSize);
      if(start>=samples.length || end<=start) continue;

      const cutoffIndex=samples[start].index;
      const train=samples.slice(0,start).filter(sample=>sample.index+horizon<=cutoffIndex);
      if(train.length<420) continue;

      const calibrationStart=Math.max(300,Math.floor(train.length*0.80));
      const calibration=train.slice(calibrationStart);
      if(calibration.length<80) continue;
      const calibrationCutoff=calibration[0].index;
      const fit=train.slice(0,calibrationStart).filter(sample=>sample.index+horizon<=calibrationCutoff);
      if(fit.length<300) continue;

      const trained=trainModels(fit);
      const edges=calibrateEdges(calibration,trained,horizon,costPct);
      const foldId=actualFolds++;

      for(const key of MODEL_ORDER) edgeTrack[key].push(edges[key].edge);

      for(let j=start;j<end;j++){
        const sample=samples[j];
        tested++;
        for(const key of MODEL_ORDER){
          const probabilityUp=modelProbability(key,trained,sample,horizon);
          records[key].push({
            fold:foldId,
            regime:sample.regime,
            futureReturn:sample.futureReturn,
            probabilityUp,
            action:actionFromProbability(probabilityUp,horizon,edges[key].edge)
          });
        }
      }
    }

    const metrics={};
    for(const key of MODEL_ORDER){
      metrics[key]=evaluateRecords(records[key],costPct,tested,actualFolds);
      metrics[key].avgEdge=edgeTrack[key].length?mean(edgeTrack[key]):neutralEdge(horizon);
      metrics[key].validation=validateMetrics(metrics[key]);
    }
    return {folds:actualFolds,tested,metrics};
  }

  function currentPrediction(key,trained,features,horizon,edge){
    let probabilityUp=0.5;
    let rawScore=null;
    if(key==="rules"){
      const rule=rulePredict(features,horizon);
      probabilityUp=rule.probabilityUp;
      rawScore=rule.score;
    }else if(key==="logistic"){
      probabilityUp=probability(trained.logistic,features.vector);
    }else if(key==="ridgeReturn"){
      probabilityUp=ridgeProbability(trained.ridgeReturn,features.vector,horizon);
    }else if(key==="naiveBayes"){
      probabilityUp=probabilityNaiveBayes(trained.naiveBayes,features.vector);
    }else if(key==="stumps"){
      probabilityUp=probabilityStumps(trained.stumps,features.vector);
    }
    return {
      probabilityUp,
      action:actionFromProbability(probabilityUp,horizon,edge),
      confidence:probabilityConfidence(probabilityUp),
      edge,
      rawScore
    };
  }

  function consensus(models){
    const eligible=models.filter(model=>model.validation.passed && model.current.action!=="NEUTRAL");
    if(!eligible.length){
      return {
        action:"NEUTRAL",
        confidence:50,
        validated:false,
        reason:"目前沒有模型同時通過跨時間與跨盤勢驗證",
        selected:[]
      };
    }

    let signed=0,total=0;
    for(const model of eligible){
      const direction=model.current.action==="LONG"?1:-1;
      const currentStrength=0.5+Math.abs(model.current.probabilityUp-0.5);
      const weight=Math.max(1,model.validation.score)*currentStrength;
      signed+=direction*weight;
      total+=weight;
    }
    const agreement=total?Math.abs(signed)/total:0;
    if(agreement<0.34){
      return {
        action:"NEUTRAL",
        confidence:clamp(50+agreement*20,50,60),
        validated:false,
        reason:"通過驗證的模型目前方向分歧",
        selected:eligible.map(model=>model.key)
      };
    }

    const avgValidation=mean(eligible.map(model=>model.validation.score));
    return {
      action:signed>0?"LONG":"SHORT",
      confidence:clamp(50+agreement*18+(avgValidation-50)*0.30,50,82),
      validated:true,
      reason:"僅整合通過跨時間與跨盤勢驗證的模型",
      selected:eligible.map(model=>model.key)
    };
  }

  function run(candles,options={}){
    if(!Array.isArray(candles) || candles.length<700){
      throw new Error("第三階段預測至少需要 700 根完整 1H K 線");
    }
    const feeRate=Number(options.feeRate)||0;
    const slippageRate=Number(options.slippageRate)||0;
    const roundTripCostPct=2*(feeRate+slippageRate)*100;
    const latestIndex=candles.length-1;
    const currentFeatures=featureAt(candles,latestIndex);
    if(!currentFeatures) throw new Error("無法建立目前市場特徵");

    const horizons={};
    for(const h of HORIZONS){
      const samples=buildSamples(candles,h.steps);
      const backtest=walkForward(samples,h.steps,roundTripCostPct);

      const calibrationStart=Math.max(300,Math.floor(samples.length*0.80));
      const calibration=samples.slice(calibrationStart);
      const calibrationCutoff=calibration.length?calibration[0].index:Infinity;
      const fit=samples.slice(0,calibrationStart).filter(sample=>sample.index+h.steps<=calibrationCutoff);
      const calibrationModels=trainModels(fit);
      const finalEdges=calibrateEdges(calibration,calibrationModels,h.steps,roundTripCostPct);
      const trained=trainModels(samples);

      const models=MODEL_ORDER.map(key=>{
        const current=currentPrediction(key,trained,currentFeatures,h.steps,finalEdges[key].edge);
        const metrics=backtest.metrics[key];
        return {
          key,
          label:MODEL_LABELS[key],
          current,
          metrics,
          validation:metrics.validation
        };
      });

      horizons[h.key]={
        label:h.label,
        steps:h.steps,
        currentRegime:currentFeatures.regime,
        models,
        consensus:consensus(models),
        testedSamples:backtest.tested,
        folds:backtest.folds,
        sampleCount:samples.length
      };
    }

    return {
      version:3,
      generatedAt:new Date().toISOString(),
      candleCount:candles.length,
      roundTripCostPct,
      currentRegime:currentFeatures.regime,
      horizons,
      validationRule:"≥80 個訊號、扣成本後平均淨變動>0、Profit Factor≥1.05、至少 60% 有效時間折為正、至少兩種盤勢為正且無明顯負盤勢。",
      note:"最終訊號只整合通過時間順序 walk-forward 與跨盤勢驗證的模型；信心是模型整合分數，不是保證勝率。"
    };
  }

  window.BTCPredictor={run};
})();