'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const M = require('../template/platform/models.js');
const FX = require('../template/platform/fx.js');
function near(a,b,tolerance=1e-10) { assert.ok(Math.abs(a-b)<=tolerance,`${a} != ${b}`); }
const base={localReturn:0.05,fxReturn:0.03,premium:-0.02,assetVol:0.08,fxVol:0.10,correlation:-0.4,hedgeRatio:0.5,confirmed:true,currency:'USD'};
function estimate({spot=1000,drift=0.03,vol=0.15}={}) {
  return {spot,annualDrift:drift,annualVol:vol,months:12,asof:'2026-07-31',
    rows:Array.from({length:13},(_,h)=>({horizon:h,date:new Date(Date.UTC(2026,7+h,0)).toISOString().slice(0,10)}))};
}

test('browser/CommonJS API works without other project dependencies',()=>{
  const context={CollaboFX:FX};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../template/platform/models.js'),'utf8'),context);
  assert.deepEqual(Object.keys(context.CollaboModels).sort(),Object.keys(M).sort());
  near(context.CollaboModels.hedge(base,{model:'C'}).ratio,M.hedge(base,{model:'C'}).ratio);
});

test('CIP equals independent domestic/foreign cash-and-carry replication',()=>{
  for(const months of [3,6,9,12]) {
    const t=months/12, spot=1400,rd=0.025,rf=0.045;
    const c=M.cip({domesticRate:rd,foreignRate:rf,months,spot});
    // KRW deposit and hedged foreign deposit have the same terminal value.
    near((100/spot)*(1+rf*t)*c.forward,100*(1+rd*t));
    near(c.annualPremium,(c.forward/spot-1)/t);
    assert.ok(c.annualPremium<0);
    const gap=M.cip({domesticRate:rd,foreignRate:rf,months,observedPremium:c.annualPremium+0.001,observedPremiumConfirmed:true}).gap;
    near(gap,0.001);
  }
  assert.equal(M.cip({domesticRate:0.03,foreignRate:0.03}).annualPremium,0);
  assert.throws(()=>M.cip({domesticRate:0.03,foreignRate:0.04,observedPremium:0.02}),/단위/);
  assert.throws(()=>M.cip({domesticRate:null,foreignRate:0.04}));
  assert.throws(()=>M.cip({domesticRate:0.03,foreignRate:-1}));
  assert.throws(()=>M.cip({domesticRate:1.01,foreignRate:0.03}));
  assert.throws(()=>M.cip({domesticRate:0.03,foreignRate:1.01}));
});

test('hedge expectation matches cash flows integrated over independent two-point shocks',()=>{
  const cost=0.004;
  for(const hedgeRatio of [0,0.25,0.5,1]) {
    const input={...base,hedgeRatio};
    const result=M.hedge(input,{cost});
    let expected=0;
    for(const a of [-1,1]) for(const b of [-1,1]) {
      const r=input.localReturn+a*input.assetVol;
      const x=input.fxReturn+input.fxVol*(input.correlation*a+Math.sqrt(1-input.correlation**2)*b);
      const spot=1300,notionalKRW=100000,units=notionalKRW/spot,forward=spot*(1+input.premium);
      const terminal=units*(1+r)*spot*(1+x)+hedgeRatio*units*(forward-spot*(1+x))-notionalKRW*hedgeRatio*cost;
      expected+=(terminal/notionalKRW-1)/4;
    }
    near(result.annual.mean,expected);
    near(result.annual.scenarioReturn,FX.scenario(input).krwReturn-hedgeRatio*cost);
    near(result.annual.mean-result.annual.scenarioReturn,input.correlation*input.assetVol*input.fxVol);
    const before=M.hedge(input);
    near(before.annual.mean-result.annual.mean,hedgeRatio*cost);
  }
});

test('B optimum agrees with exhaustive objective and C minimizes variance',()=>{
  for(const correlation of [-1,-0.4,0,1]) for(const premium of [-0.08,-0.02,0.04,0.12]) {
    const input={...base,correlation,premium},cost=0.002,gamma=5;
    const b=M.hedge(input,{model:'B',cost,riskAversion:gamma});
    const c=M.hedge(input,{model:'C',cost,riskAversion:gamma});
    const objective=r=>r.mean-gamma*r.variance/2;
    for(let i=0;i<=1000;i++) {
      const candidate=M.hedge({...input,hedgeRatio:i/1000},{cost}).annual;
      assert.ok(objective(b.annual)>=objective(candidate)-1e-12);
      assert.ok(c.annual.variance<=candidate.variance+1e-12);
    }
    assert.ok(b.ratio>=0&&b.ratio<=1&&c.ratio>=0&&c.ratio<=1);
  }
});

test('boundary cases: no FX risk, perfect offset, costs, and full initial-notional hedge',()=>{
  assert.equal(M.hedge({...base,fxVol:0},{model:'C'}).ratio,0);
  assert.equal(M.hedge({...base,fxVol:0,premium:0.1},{model:'B'}).ratio,1);
  assert.equal(M.hedge({...base,fxVol:0,premium:-0.1},{model:'B'}).ratio,0);
  const offset=M.hedge({...base,assetVol:0.04,fxVol:0.1,correlation:-1},{model:'C'});
  near(offset.ratio,0.6); near(offset.annual.approxVol,0,1e-9);
  const full=M.hedge({...base,hedgeRatio:1,correlation:0});
  near(full.annual.scenarioReturn,base.localReturn+base.premium+base.localReturn*base.fxReturn);
  near(full.annual.approxVol,base.assetVol);
  const lowCost=M.hedge({...base,premium:0.04},{model:'B',cost:0});
  const highCost=M.hedge({...base,premium:0.04},{model:'B',cost:0.05});
  assert.ok(highCost.ratio<=lowCost.ratio);
});

test('quarter horizons preserve annual units, signs, and return/interval alignment',()=>{
  const r=M.hedge(base,{model:'A',cost:0.008});
  assert.deepEqual(r.rows.map(x=>x.horizon),[3,6,9,12]);
  r.rows.forEach(row=>{
    const t=row.horizon/12;
    near(Math.pow(1+row.localReturn,1/t)-1,base.localReturn);
    near(Math.pow(1+row.fxReturn,1/t)-1,base.fxReturn);
    near(row.cost,0.008*t); near(row.premium,(base.premium-0.008)*t);
    near(row.variance,r.annual.variance*t);
    assert.ok(row.lower95<=row.lower68&&row.lower68<=row.mean&&row.mean<=row.upper68&&row.upper68<=row.upper95);
    near(row.var975,Math.max(0,-row.lower95));
  });
});

test('missing, unconfirmed, nonfinite and invalid hedge inputs fail closed',()=>{
  for(const change of [{confirmed:false},{localReturn:null},{fxReturn:NaN},{premium:undefined},{assetVol:Infinity},{fxVol:-0.1},{correlation:1.1},{hedgeRatio:-0.1}]) {
    assert.throws(()=>M.hedge({...base,...change}));
  }
  for(const options of [{model:'B',riskAversion:0},{model:'B',riskAversion:.001},{model:'B',riskAversion:1001},{model:'B',riskAversion:null},{model:'B',riskAversion:NaN},{cost:-0.1},{cost:null},{model:'D'}]) assert.throws(()=>M.hedge(base,options));
});

test('invalid B risk aversion does not suppress independent A/C results',()=>{
  for(const model of ['A','C']) for(const riskAversion of [0,null,NaN,Infinity,'']) {
    const expected=M.hedge(base,{model});
    const actual=M.hedge(base,{model,riskAversion});
    assert.deepEqual(actual,expected);
    assert.equal(actual.riskAversion,null);
  }
});

test('seeded 20000-path 252-step MC matches independent lognormal moments/quantiles',()=>{
  const fc=estimate(),start=performance.now(),r=M.simulateForecast(fc),last=r.rows.at(-1);
  const elapsed=performance.now()-start;
  const mean=fc.spot*Math.exp(fc.annualDrift+fc.annualVol**2/2);
  const median=fc.spot*Math.exp(fc.annualDrift),q025=fc.spot*Math.exp(fc.annualDrift-1.959963984540054*fc.annualVol);
  near(last.mean,mean,5); near(last.median,median,5); near(last.lower95,q025,7);
  near(last.var975,Math.max(0,1-last.lower95/fc.spot));
  assert.equal(r.paths,20000); assert.equal(r.steps,252); assert.equal(r.rows.length,13);
  assert.deepEqual(r.quarterly.map(x=>x.horizon),[3,6,9,12]);
  assert.equal(r.samplePaths.length,12); assert.equal(r.samplePaths[0].length,13);
  assert.equal(r.parameterUncertaintyIncluded,false);
  console.log('MC benchmark: '+elapsed.toFixed(0)+' ms for 20,000 × 252 steps');
});

test('simulation is reproducible; zero volatility equals deterministic compounding',()=>{
  const f=estimate();
  assert.deepEqual(M.simulateForecast(f,{paths:1000,seed:7}),M.simulateForecast(f,{paths:1000,seed:7}));
  assert.notEqual(M.simulateForecast(f,{paths:1000,seed:7}).rows[12].mean,M.simulateForecast(f,{paths:1000,seed:8}).rows[12].mean);
  const r=M.simulateForecast(estimate({drift:-0.05,vol:0}),{paths:100});
  r.rows.forEach(row=>{
    const exact=r.spot*Math.exp(-0.05*row.horizon/12);
    for(const key of ['mean','median','lower68','upper68','lower95','upper95']) near(row[key],exact,1e-8);
    near(row.var975,1-Math.exp(-0.05*row.horizon/12),1e-10);
  });
});

test('historical estimator is reused and invalid simulation options reject',()=>{
  let level=1000;
  const history=Array.from({length:60},(_,i)=>{
    level*=Math.exp(0.01*Math.sin(i));
    return {date:new Date(Date.UTC(2020,i+1,0)).toISOString().slice(0,10),value:level};
  });
  const f=FX.forecast(history,{lookback:36,method:'historical'});
  const mc=M.monteCarlo(history,{lookback:36,method:'historical',paths:100});
  near(mc.annualDrift,f.annualDrift);near(mc.annualVol,f.annualVol);
  assert.deepEqual(mc.estimation,f.estimation);assert.deepEqual(mc.quality,f.quality);
  for(const options of [{paths:0},{paths:1.5},{seed:-1},{samplePathCount:100}]) assert.throws(()=>M.simulateForecast(estimate(),options));
  assert.throws(()=>M.simulateForecast({...estimate(),annualVol:NaN}));
});
