'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const S = require('../template/platform/simulation.js');

const near = (a, b, tolerance = 1e-11) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function fixture(start = '2015-01-01', end = '2025-12-31') {
  const observations = [];
  let equity = 100, bond = 100, fx = 1000, i = 0;
  for (let stamp = Date.parse(start); stamp <= Date.parse(end); stamp += 86400000) {
    const date = new Date(stamp);
    if ([0, 6].includes(date.getUTCDay())) continue;
    equity *= 1 + 0.0003 + 0.008 * Math.sin(i * 0.67) + 0.005 * Math.cos(i * 0.13);
    bond *= 1 + 0.0001 + 0.002 * Math.cos(i * 0.77) + 0.001 * Math.sin(i * 0.19);
    fx *= 1 + 0.00005 + 0.003 * Math.sin(i * 0.43);
    observations.push([date.toISOString().slice(0, 10), equity, bond, fx]);
    i++;
  }
  return {schemaVersion: 1, source: {asOf: end}, observations};
}
const sample = fixture();
const options = {start: '2016-01-29', end: '2022-12-30', performanceEnd: '2025-12-31'};

test('two-asset minimum variance agrees with exact boundary and zero-covariance identities', () => {
  const means = [0.08, 0.03], vols = [0.2, 0.05];
  const cases = [[-1, 0.2, 0], [0, 1 / 17, Math.sqrt(0.0001 / 0.0425)], [1, 0, 0.05]];
  for (const [rho, weight, risk] of cases) {
    const point = S.optimize(means, vols, rho);
    near(point.weight, weight); near(point.annualVol, risk);
    near(point.expectedReturn, weight * 0.08 + (1 - weight) * 0.03);
  }
  const singular = S.optimize([0.08, 0.03], [0.1, 0.1], 1);
  assert.equal(singular.weight, 1); // Equal minimum risks: prefer higher return.
  const equal = S.optimize([0.03, 0.03], [0.1, 0.1], 1);
  assert.equal(equal.weight, 0.6);
});

test('fixed-mean/volatility correlation changes leave single-asset endpoints invariant', () => {
  for (const weight of [0, 1]) {
    const original = S.portfolioPoint(weight, [0.08, 0.03], [0.2, 0.05], -1);
    for (const rho of [-0.5, 0, 0.5, 1]) assert.deepEqual(S.portfolioPoint(weight, [0.08, 0.03], [0.2, 0.05], rho), original);
  }
});

test('efficient frontier contains only the undominated branch and exact admissible endpoints', () => {
  for (const means of [[0.08, 0.03], [0.01, 0.05], [0.03, 0.03]]) {
    for (const rho of [-1, -0.3, 0, 0.9, 1]) {
      const frontier = S.efficientFrontier(means, [0.2, 0.05], rho);
      near(frontier[0].annualVol, S.optimize(means, [0.2, 0.05], rho).annualVol);
      for (const point of frontier) assert.ok(point.weight >= 0 && point.weight <= 1);
      for (let i = 1; i < frontier.length; i++) {
        assert.ok(frontier[i].expectedReturn >= frontier[i - 1].expectedReturn - 1e-14);
        assert.ok(frontier[i].annualVol >= frontier[i - 1].annualVol - 1e-14);
      }
      if (means[0] === means[1]) assert.equal(frontier.length, 1);
      else assert.equal(frontier.at(-1).weight, Number(means[0] > means[1]));
    }
  }
});

test('maximum Sharpe evaluates stationary points and boundaries for positive and negative premiums', () => {
  for (let k = 0; k < 24; k++) {
    const means = [0.08 * Math.sin(k * 0.7), 0.05 * Math.cos(k * 0.4)];
    const vols = [0.03 + k * 0.006, 0.02 + k * 0.001];
    const rho = -0.95 + k * 1.9 / 23, rf = 0.02;
    const optimum = S.optimize(means, vols, rho, 'maxSharpe', rf);
    let grid = -Infinity;
    for (let j = 0; j <= 10000; j++) grid = Math.max(grid, S.portfolioPoint(j / 10000, means, vols, rho, rf).sharpe);
    assert.ok(optimum.sharpe >= grid - 1e-9, `${k}: ${optimum.sharpe} < ${grid}`);
  }
  const perfectHedge = S.optimize([0.08, 0.03], [0.2, 0.05], -1, 'maxSharpe', 0.02);
  near(perfectHedge.weight, 0.2);
  assert.equal(perfectHedge.annualVol, 0);
  assert.equal(perfectHedge.sharpe, null);
  assert.equal(perfectHedge.sharpeStatus, 'positiveInfinity');
});

test('sampling uses common dates, complete periods, and never crosses missing buckets', () => {
  const data = {source: {asOf: '2024-03-14'}, observations: [
    ['2024-01-30', 100, 100, 1000], ['2024-01-31', 101, null, 1001],
    ['2024-02-01', 102, 101, 1002], ['2024-02-02', 103, 102, 1003],
    ['2024-02-05', 104, 103, 1004], ['2024-02-29', 105, 104, 1005],
    ['2024-03-01', 106, 105, 1006], ['2024-03-14', 107, 106, 1007]
  ]};
  const rows = S.prepareLevels(data).rows;
  const daily = S.resampleReturns(rows, 'daily', '2024-01-01', '2024-03-14');
  assert.equal(daily.some(row => row.date === '2024-02-01'), false);
  assert.equal(daily.some(row => row.date === '2024-02-05'), true);
  assert.equal(daily.some(row => row.date === '2024-02-29'), false);
  const monthly = S.resampleReturns(rows, 'monthly', '2024-01-01', '2024-03-14');
  assert.equal(monthly.length, 1); assert.equal(monthly[0].startDate, '2024-01-30');
  assert.equal(monthly[0].date, '2024-02-29'); near(monthly[0].equity, 0.05);
  const weekly = S.periodLevels(rows, 'weekly', '2024-03-14');
  assert.equal(weekly.at(-1).date, '2024-03-01'); // March 15 week remains incomplete.
  const gap = S.resampleReturns(rows, 'monthly', '2024-02-01', '2024-03-14');
  assert.equal(gap.length, 0); // Never consume a pre-start baseline.
});

test('FX translation includes its cross term and uses shared observations', () => {
  const localRows = S.resampleReturns(S.prepareLevels(sample, 'local').rows, 'monthly', options.start, options.end);
  const krwRows = S.resampleReturns(S.prepareLevels(sample, 'krw').rows, 'monthly', options.start, options.end);
  const fx = new Map(sample.observations.map(row => [row[0], row[3]]));
  localRows.forEach((row, i) => {
    near(krwRows[i].equity, (1 + row.equity) * fx.get(row.date) / fx.get(row.startDate) - 1);
    near(krwRows[i].bond, row.bond);
  });
});

test('correlation-only mode fixes monthly means/vols and full mode reestimates each frequency', () => {
  const fixed = S.calculate(sample, options), full = S.calculate(sample, {...options, mode: 'full'});
  assert.deepEqual(fixed.scenarios.map(row => row.id), ['daily', 'weekly', 'monthly', 'custom-1', 'custom-2', 'custom-3', 'custom-4', 'custom-5']);
  assert.deepEqual(fixed.customRhos, [-1, -0.5, 0, 0.5, 1]);
  for (let i = 0; i < fixed.scenarios.length; i++) {
    assert.equal(fixed.scenarios[i].error, null);
    assert.deepEqual(fixed.scenarios[i].means, fixed.baseline.means);
    assert.deepEqual(fixed.scenarios[i].vols, fixed.baseline.vols);
    assert.equal(fixed.scenarios[i].rho, full.scenarios[i].rho);
  }
  assert.notDeepEqual(full.scenarios[0].vols, fixed.baseline.vols);
  assert.deepEqual(full.scenarios[2].means, full.baseline.means);
  assert.deepEqual(full.scenarios[3].vols, full.baseline.vols);
});

test('holdout uses only post-estimation month-end anchors and is immune to future changes in weights', () => {
  const result = S.calculate(sample, options);
  assert.equal(result.performance.error, null);
  assert.equal(result.performance.startDate, '2022-12-30');
  assert.equal(result.performance.points[1].date, '2023-01-31');
  assert.ok(result.performance.points.slice(1).every(point => point.date > options.end));
  const modified = structuredClone(sample);
  modified.observations.forEach((row, i) => { if (row[0] > options.end) row[1] *= 1 + i / 10000; });
  const future = S.calculate(modified, options);
  assert.deepEqual(future.scenarios, result.scenarios);
  assert.notDeepEqual(future.performance.points, result.performance.points);
});

test('performance follows identical actual monthly returns and fixed scenario weights without a benchmark', () => {
  const initial = S.calculate(sample, options);
  const result = S.calculate(sample, {...options, customRhos: [initial.scenarios[2].rho, -1, -0.5, 0, 0.5, 1]});
  const rows = S.resampleReturns(S.prepareLevels(sample).rows, 'monthly', result.performance.startDate, options.performanceEnd);
  const weights = result.scenarios.map(row => row.optimum.weight);
  assert.deepEqual(result.performance.keys, result.scenarios.map(row => row.id));
  assert.deepEqual(result.performance.labels, result.scenarios.map(row => row.label));
  assert.equal(result.performance.keys.includes('benchmark'), false);
  assert.equal(result.performance.labels.includes('60:40'), false);
  assert.ok(result.performance.points.every(point => point.values.length === weights.length));
  weights.forEach((weight, index) => {
    let wealth = 100;
    rows.forEach((row, i) => {
      wealth *= 1 + weight * row.equity + (1 - weight) * row.bond;
      near(result.performance.points[i + 1].values[index], wealth);
    });
    near(result.performance.stats[index].totalReturn, wealth / 100 - 1);
    near(result.performance.stats[index].cagr, (wealth / 100) ** (12 / rows.length) - 1);
  });
  result.performance.points.forEach(point => near(point.values[2], point.values[3]));
  const within = S.calculate(sample, {...options, evaluation: 'inSample'});
  assert.equal(within.performance.evaluation, 'inSample');
  assert.equal(within.performance.startDate, within.baseline.startDate);
  assert.equal(within.performance.endDate, within.baseline.endDate);
});

test('custom correlation scenarios keep exact values and link their frontier optimum to performance weights', () => {
  const customRhos = [-1, -0.75, -0.125, 0, 0.125, 0.75, 1];
  const result = S.calculate(sample, {...options, customRhos});
  const custom = result.scenarios.slice(3);
  assert.equal(custom.length, 7);
  assert.deepEqual(custom.map(row => row.rho), customRhos);
  assert.deepEqual(custom.map(row => row.id), customRhos.map((_, i) => 'custom-' + (i + 1)));
  assert.equal(custom[0].label, 'Custom 1 · ρ = -1.00');
  assert.equal(custom[3].label, 'Custom 4 · ρ = 0.00');
  assert.equal(custom.at(-1).label, 'Custom 7 · ρ = +1.00');
  const [stockVol, bondVol] = result.baseline.vols;
  near(custom[0].optimum.weight, bondVol / (stockVol + bondVol));
  near(custom[0].optimum.annualVol, 0);
  near(custom.at(-1).optimum.weight, Number(stockVol < bondVol));
  for (const scenario of custom) {
    assert.deepEqual(scenario.means, result.baseline.means);
    assert.deepEqual(scenario.vols, result.baseline.vols);
    assert.deepEqual(scenario.frontier[0], scenario.optimum);
    near(result.performance.stats.find(row => row.id === scenario.id).weight, scenario.optimum.weight);
  }
  // Identical constrained solutions must remain identical, even for different rho.
  const boundary = S.calculate(sample, {...options, customRhos: [0.99, 1]});
  near(boundary.scenarios[3].optimum.weight, boundary.scenarios[4].optimum.weight);
  boundary.performance.points.forEach(point => near(point.values[3], point.values[4]));
  const legacy = S.calculate(sample, {...options, customRho: 0.25});
  assert.deepEqual(legacy.customRhos, [0.25]);
  assert.equal(legacy.scenarios[3].id, 'custom-1');
  assert.equal(legacy.scenarios.length, 4);
  const close = S.calculate(sample, {...options, customRhos: [0.121, 0.124]});
  assert.notEqual(close.scenarios[3].label, close.scenarios[4].label);
  assert.deepEqual(close.scenarios.slice(3).map(row => row.rho), [0.121, 0.124]);
  // Results are snapshots, not references to a subsequently edited input array.
  customRhos[0] = -0.9;
  assert.equal(result.customRhos[0], -1);
  assert.equal(result.scenarios[3].rho, -1);
});

test('invalid, duplicate, empty and oversized custom correlation lists fail explicitly', () => {
  for (const customRhos of [null, 0, '-1,0,1', [], [-1, 0, 1.01], [-1.01], [NaN], [Infinity], ['0.5'], [0, -0],
    [0.25, 0.25], [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 1]]) {
    assert.throws(() => S.calculate(sample, {...options, customRhos}), /Custom/);
  }
});

test('insufficient holdout preserves training output and missing performance months do not silently compound', () => {
  const last = S.calculate(sample, {start: options.start, end: sample.source.asOf});
  assert.ok(last.scenarios.every(row => row.optimum));
  assert.ok(last.performance.error); assert.deepEqual(last.performance.points, []);
  for (const removedMonth of ['2023-01', '2023-02', '2024-06']) {
    const missing = structuredClone(sample);
    missing.observations = missing.observations.filter(row => !row[0].startsWith(removedMonth));
    const result = S.calculate(missing, options);
    assert.match(result.performance.error, /결측/);
    assert.deepEqual(result.performance.points, []);
  }
});

test('monthly-only observations cannot masquerade as daily or weekly data', () => {
  const prepared = S.prepareLevels(sample);
  const monthly = S.periodLevels(prepared.rows, 'monthly', sample.source.asOf);
  const data = {source: sample.source, observations: monthly.map(row => [row.date, row.equity, row.bond, 1000])};
  const result = S.calculate(data, options);
  assert.equal(result.scenarios[0].optimum, null);
  assert.equal(result.scenarios[1].optimum, null);
  assert.ok(result.scenarios[0].error); assert.ok(result.scenarios[1].error);
  assert.ok(result.scenarios[2].optimum);
  assert.ok(result.performance.points.every(point => point.values[0] === null && point.values[1] === null));
});

test('constant or round-off-only dispersion has undefined observed correlation', () => {
  const rows = Array.from({length: 60}, (_, i) => ({date: String(i + 1), startDate: String(i), equity: 1.01 ** (i + 1) / 1.01 ** i - 1, bond: 0.02 + i * 0.0001}));
  const stats = S.statistics(rows, 252);
  assert.equal(stats.rho, null); assert.equal(stats.vols[0], 0);
  const constant = structuredClone(sample);
  constant.observations.forEach(row => { row[1] = 100; row[2] = 100; });
  const result = S.calculate(constant, options);
  assert.ok(result.scenarios.slice(0, 3).every(row => row.error && row.optimum === null));
  assert.equal(result.scenarios[3].optimum.annualVol, 0);
  assert.ok(result.performance.points.every(point => point.values[3] === 100));
});

test('invalid dates, weights, modes, nonfinite inputs and short estimation samples fail explicitly', () => {
  for (const extra of [{mode: 'bad'}, {basis: 'usd'}, {objective: 'return'}, {evaluation: 'future'}, {rf: NaN}, {customRho: 1.01}, {customRho: -1.01}, {start: '2022-02-30'}, {start: '2025-01-01', end: '2024-01-01'}]) {
    assert.throws(() => S.calculate(sample, {...options, ...extra}));
  }
  assert.throws(() => S.calculate(sample, {start: '2020-01-01', end: '2021-01-01'}), /24/);
  for (const bad of [0, -1, Infinity, NaN, '100']) {
    const data = structuredClone(sample); data.observations[5][1] = bad;
    assert.throws(() => S.calculate(data, options));
  }
  const duplicate = structuredClone(sample); duplicate.observations.push(duplicate.observations[0]);
  assert.throws(() => S.calculate(duplicate, options), /중복/);
  assert.throws(() => S.calculate({...sample, source: {asOf: '2000-01-01'}}, options), /기준일/);
});

test('published daily snapshot calculates all scenarios on both currency bases', () => {
  const data = require('../template/platform/simulation-data.json');
  for (const basis of ['local', 'krw']) for (const mode of ['correlation', 'full']) for (const objective of ['minVol', 'maxSharpe']) {
    const result = S.calculate(data, {start: '2013-10-31', end: '2023-10-31', basis, mode, objective, rf: 0.02});
    assert.equal(result.baseline.n, 120);
    assert.ok(result.scenarios.every(row => row.error === null && row.frontier.length > 0));
    assert.equal(result.performance.error, null);
    assert.equal(result.performance.points[0].date, '2023-10-31');
    assert.ok(result.performance.points.slice(1).every(point => point.date > '2023-10-31'));
    assert.equal(result.performance.endDate, '2026-10-30');
  }
});
