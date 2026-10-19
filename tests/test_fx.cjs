'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const FX = require('../template/platform/fx.js');

function near(a, b, tolerance = 1e-10) { assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`); }
function sample(count = 84, logReturn = i => 0.002 + 0.018 * Math.sin(i * 1.2)) {
  let value = 1000;
  return Array.from({ length: count }, (_, i) => {
    if (i) value *= Math.exp(logReturn(i));
    return { date: new Date(Date.UTC(2018, i + 1, 0)).toISOString().slice(0, 10), value };
  });
}
const base = { localReturn: 0.05, fxReturn: 0.1, premium: -0.02, hedgeRatio: 0, assetVol: 0.08, fxVol: 0.1, correlation: 0.25 };

test('CommonJS and browser expose the same public API', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../template/platform/fx.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.CollaboFX).sort(), Object.keys(FX).sort());
});

test('offset alignment, finite numeric observations, dates, sort and deduplication', () => {
  assert.deepEqual(FX.points(['2020-01-01','2020-01-03','2020-01-02','2020-02-30','2020-01-03','2020-01-06','2020-01-07'],
    { start: 1, values: [3, 2, 9, 4, null, '5', 10] }), [{ date: '2020-01-02', value: 2 },{ date: '2020-01-03', value: 4 }]);
  assert.deepEqual(FX.points(['2020-01-01'], { start: 0, values: [-0.02] }), [{date:'2020-01-01',value:-0.02}]);
  assert.throws(() => FX.points([], { start: -1, values: [] }));
  assert.throws(() => FX.points([], {}));
  assert.deepEqual(FX.monthly([{ date:'2020-01-03', value:2 },{ date:'2020-01-31', value:3 },{ date:'2020-02-28', value:4 },{ date:'2020-03-31', value:0 }]),
    [{ date:'2020-01-31', value:3 },{ date:'2020-02-28', value:4 }]);
});

test('known log drift, annual volatility and lognormal distribution identities', () => {
  const values = sample(60, i => i % 2 ? 0.02 : -0.01);
  const r = values.slice(1).map((p,i) => Math.log(p.value / values[i].value));
  const mean = r.reduce((a,b) => a+b,0) / r.length;
  const variance = r.reduce((a,b) => a+(b-mean)**2,0) / (r.length-1);
  const f = FX.forecast(values, { months:12, lookback:120, method:'historical' });
  near(f.annualDrift, 12*mean);
  near(f.annualVol**2, 12*variance);
  const end = f.rows.at(-1);
  near(end.median, f.spot * Math.exp(mean*12));
  near(end.mean/end.median, Math.exp(variance*12/2));
  near(Math.log(end.upper95/end.median), Math.log(end.median/end.lower95));
  assert.ok(end.lower95 < end.lower68 && end.lower68 < end.median && end.median < end.upper68 && end.upper68 < end.upper95);
  assert.equal(f.rows.length,13);
  assert.equal(f.rows[0].median,f.spot);
  assert.equal(f.estimation.parameterUncertaintyIncluded,false);
});

test('RW median is spot, mean includes Jensen term; user drift is annual log drift', () => {
  const rw = FX.forecast(sample(), { method:'random-walk', months:12 });
  rw.rows.forEach(row => near(row.median,rw.spot));
  assert.ok(rw.rows[12].mean > rw.spot);
  const scenario = FX.forecast(sample(), {method:'scenario', annualDrift:-0.05, months:12});
  near(scenario.rows[12].median/scenario.spot,Math.exp(-0.05));
  const deterministic = FX.forecast(sample(49, () => 0.01), {method:'historical',months:1});
  near(deterministic.annualDrift,0.12);
  near(deterministic.annualVol,0,1e-12);
  near(deterministic.rows[1].median,deterministic.spot*Math.exp(0.01));
});

test('sampling ignores daily frequency, excludes partial final month and does not bridge missing months', () => {
  const values = sample(60);
  const withDaily = values.flatMap(p => [{date:p.date.slice(0,8)+'05',value:p.value*0.99},p]);
  near(FX.forecast(values).annualVol,FX.forecast(withDaily).annualVol);
  const partial = values.concat({date:'2023-01-15',value:1400});
  const f = FX.forecast(partial,{months:2});
  assert.equal(f.asof,'2023-01-15');
  assert.equal(f.spot,1400);
  assert.equal(f.estimation.partialLatestMonthExcluded,true);
  near(f.annualVol,FX.forecast(values).annualVol);
  assert.equal(f.rows[1].date,'2023-02-15');
  const gap = FX.forecast(values.filter((_,i)=>i!==35));
  assert.equal(gap.observations,57);
  assert.equal(gap.estimation.skippedGaps,1);
  assert.equal(FX.forecast(sample(60),{lookback:24}).observations,24);
  assert.throws(()=>FX.forecast(values.filter((_,i)=>i!==50),{lookback:24}), /最低|最小|24/);
});

test('calendar month horizons are anchored, clamped and strictly increasing', () => {
  const history = sample(61); // 2023-01-31
  const f = FX.forecast(history,{months:3});
  assert.deepEqual(f.rows.map(r=>r.date),['2023-01-31','2023-02-28','2023-03-31','2023-04-30']);
});

test('minimum data, invalid methods and invalid options are rejected', () => {
  assert.throws(()=>FX.forecast([]),/환율/);
  assert.throws(()=>FX.forecast(sample(24)),/24/);
  assert.throws(()=>FX.forecast(sample(),{method:'magic'}),/방식/);
  assert.throws(()=>FX.forecast(sample(),{months:0}));
  assert.throws(()=>FX.forecast(sample(),{lookback:12}));
  assert.throws(()=>FX.forecast(sample(),{method:'scenario',annualDrift:NaN}));
  assert.throws(()=>FX.forecast(sample(),{months:Infinity}));
});

test('unchanged tail is diagnosed without inventing or removing observations', () => {
  const history = sample(60);
  history.slice(-7).forEach(p=>{p.value=1400;});
  const f = FX.forecast(history);
  assert.equal(f.quality.trailingUnchangedObservations,7);
  assert.equal(f.quality.unchangedSince,history.at(-7).date);
  assert.equal(f.quality.sourceVintageVerified,false);
  assert.equal(f.observations,59);
  assert.ok(f.warnings.some(w=>w.includes('7개 유효 관측값')));
});

test('OOS expanding estimates exclude the target and all future observations', () => {
  const history = sample();
  const before = FX.evaluate(history,{testMonths:120});
  const split = 55;
  const altered = history.map((p,i)=>i>=split?{...p,value:p.value*(1+i-split)*3}:p);
  const after = FX.evaluate(altered,{testMonths:120});
  before.rows.filter(r=>r.date<history[split].date).forEach(row=>assert.deepEqual(row,after.rows.find(r=>r.date===row.date)));
  const target = before.rows.find(r=>r.date===history[split].date);
  const targetAfter = after.rows.find(r=>r.date===target.date);
  assert.deepEqual(target.randomWalk,targetAfter.randomWalk);
  assert.deepEqual(target.historical,targetAfter.historical);
  assert.notEqual(target.actual,targetAfter.actual);
  const independent = FX.forecast(history.slice(0,split),{method:'historical',lookback:120,months:1});
  near(target.historical.median,independent.rows[1].median);
  assert.equal(target.trainingReturns,split-1);
});

test('OOS metrics use median-level errors and report coverage fractions', () => {
  const result = FX.evaluate(sample(),{testMonths:24});
  assert.equal(result.rows.length,24);
  const manual = Math.sqrt(result.rows.reduce((s,r)=>s+(r.actual-r.randomWalk.median)**2,0)/24);
  near(result.randomWalk.rmse,manual);
  for (const m of [result.randomWalk,result.historical]) {
    assert.ok(m.coverage68>=0 && m.coverage68<=1);
    assert.ok(m.coverage95>=m.coverage68 && m.coverage95<=1);
  }
  const none = FX.evaluate(sample(25));
  assert.equal(none.observations,0);
  assert.equal(none.randomWalk.rmse,null);
});

test('optional OOS rolling window matches the selected forecast estimator', () => {
  const history = sample(100);
  const result = FX.evaluate(history,{lookback:36,testMonths:24});
  assert.equal(result.fitting,'rolling');
  assert.equal(result.lookbackMonths,36);
  assert.equal(result.rows.length,24);
  result.rows.forEach(row=>{
    const fit = FX.forecast(history.filter(p=>p.date<=row.asof),{lookback:36,method:'historical',months:1});
    assert.equal(row.trainingReturns,36);
    near(row.historical.median,fit.rows[1].median);
    near(row.historical.upper95,fit.rows[1].upper95);
  });
  assert.equal(FX.evaluate(history).fitting,'expanding');
});

test('fixed initial notional return matches direct foreign asset plus forward cash flows', () => {
  for (const h of [0,0.5,1]) {
    const result = FX.scenario({...base,hedgeRatio:h});
    const initialKRW = 100000, spot = 1000;
    const units = initialKRW/spot;
    const futureSpot = spot*(1+base.fxReturn), forward = spot*(1+base.premium);
    const payoff = units*(1+base.localReturn)*futureSpot + h*units*(forward-futureSpot);
    near(result.krwReturn,payoff/initialKRW-1);
  }
  near(FX.scenario(base).krwReturn,0.155);
  near(FX.scenario({...base,hedgeRatio:1}).krwReturn,0.035);
  near(FX.scenario({...base,hedgeRatio:1}).approxVol,base.assetVol);
  near(FX.scenario({...base,localReturn:0,hedgeRatio:1}).krwReturn,base.premium);
  near(FX.scenario({...base,fxReturn:-0.1,hedgeRatio:1}).krwReturn,0.025);
});

test('hedge premium sign, covariance endpoints and invalid input protections', () => {
  const gain = FX.scenario({...base,hedgeRatio:0.75,premium:0.03});
  const loss = FX.scenario({...base,hedgeRatio:0.75,premium:-0.03});
  near(gain.krwReturn-loss.krwReturn,0.75*0.06);
  near(FX.scenario({...base,assetVol:0.1,fxVol:0.1,correlation:-1}).approxVol,0);
  near(FX.scenario({...base,assetVol:0.1,fxVol:0.1,correlation:1}).approxVol,0.2);
  for (const change of [{hedgeRatio:1.1},{hedgeRatio:-0.1},{correlation:1.01},{assetVol:-0.01},{fxReturn:-1},{premium:NaN},{localReturn:'0.05'}]) {
    assert.throws(()=>FX.scenario({...base,...change}));
  }
});
