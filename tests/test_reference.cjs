'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const R = require('../template/platform/reference.js');

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}
function fixture(months = 140) {
  let equity = 100, bond = 100, fx = 1200;
  const observations = [];
  for (let i = 0; i <= months; i++) {
    const date = new Date(Date.UTC(2010, i + 1, 0));
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
    equity *= 1 + 0.007 + 0.035 * Math.sin(i * 0.7);
    bond *= 1 + 0.002 + 0.008 * Math.cos(i * 0.8);
    fx *= 1 + 0.001 + 0.02 * Math.sin(i * 0.3);
    observations.push([date.toISOString().slice(0, 10), equity, bond, fx]);
  }
  return {observations};
}

test('historical portfolio mean and sample risk match independent covariance identities', () => {
  const data = fixture(), result = R.calculate(data);
  assert.equal(result.observations, 120);
  const e = result.assetStats[0], b = result.assetStats[1], rho = result.correlation[0][1];
  near(result.expectedReturn, 0.6 * e.expectedReturn + 0.4 * b.expectedReturn);
  near(result.annualVol ** 2, 0.36 * e.annualVol ** 2 + 0.16 * b.annualVol ** 2 + 0.48 * e.annualVol * b.annualVol * rho);
  for (let i = 0; i < 3; i++) {
    near(result.correlation[i][i], 1);
    for (let j = 0; j < 3; j++) near(result.correlation[i][j], result.correlation[j][i]);
  }
  const wealth = result.rows.reduce((value, row) => value * (1 + row.reference), 1);
  near(result.cagr, wealth ** (12 / result.observations) - 1);
  near(result.rows.at(-1).cumulative, wealth - 1);
});

test('100:0 and 0:100 reproduce constituent returns, volatilities and correlations', () => {
  for (const equityWeight of [0, 1]) {
    const result = R.calculate(fixture(), {equityWeight, lookback: 60});
    const index = equityWeight === 1 ? 0 : 1;
    near(result.expectedReturn, result.assetStats[index].expectedReturn);
    near(result.annualVol, result.assetStats[index].annualVol);
    near(result.correlation[index][2], 1);
    assert.deepEqual(result.weights, [equityWeight, 1 - equityWeight]);
  }
});

test('KRW conversion includes the asset and FX cross term on shared dates', () => {
  const data = fixture(30), local = R.calculate(data, {lookback: 0}), krw = R.calculate(data, {basis: 'krw', lookback: 0});
  assert.equal(krw.observations, local.observations);
  krw.rows.forEach((row, i) => {
    const fxReturn = data.observations[i + 1][3] / data.observations[i][3] - 1;
    near(row.equity, (1 + local.rows[i].equity) * (1 + fxReturn) - 1);
    near(row.bond, local.rows[i].bond);
  });
});

test('incomplete source month is excluded; final Friday before weekend is complete', () => {
  const data = fixture(35), before = R.calculate(data, {lookback: 0});
  data.observations.push(['2013-01-15', 200, 140, 1500]);
  const partial = R.calculate(data, {lookback: 0});
  assert.equal(partial.endDate, before.endDate);
  assert.equal(partial.sourceAsOf, '2013-01-15');
  data.observations.push(['2013-01-31', 210, 141, 1490]);
  assert.equal(R.calculate(data, {lookback: 0}).endDate, '2013-01-31');
  assert.equal(R.calculate(fixture(34), {lookback: 0}).endDate, '2012-11-30');
  assert.equal(R.calculate(fixture(32), {lookback: 0}).endDate, '2012-09-28');
});

test('missing months are not treated as one-month returns or continuous realized wealth', () => {
  const data = fixture(60);
  data.observations.splice(35, 1);
  const result = R.calculate(data, {lookback: 0});
  assert.equal(result.observations, 58);
  assert.equal(result.gaps, 1);
  assert.equal(result.cagr, null);
  assert.equal(result.rows.at(-1).cumulative, null);
  const removedDate = '2012-12';
  assert.equal(result.rows.some(row => row.date.startsWith(removedDate)), false);
});

test('lookback stays within the requested calendar window when observations are missing', () => {
  const data = fixture(140), complete = R.calculate(data, {lookback: 60});
  data.observations.splice(100, 1);
  const result = R.calculate(data, {lookback: 60});
  assert.equal(result.startDate, complete.startDate);
  assert.equal(result.endDate, complete.endDate);
  assert.equal(result.observations, 58);
  assert.equal(result.gapCount, 1);
});

test('common date intersection precedes monthly selection and never forward fills', () => {
  const data = fixture(40);
  const date = data.observations[29][0];
  const earlier = date.slice(0, 8) + '15';
  const original = data.observations[29].slice();
  data.observations.splice(29, 0, [earlier, original[1], original[2], original[3]]);
  data.observations[30][2] = null;
  const result = R.calculate(data, {lookback: 0});
  assert.equal(result.rows.some(row => row.date === date), false);
  assert.equal(result.rows.some(row => row.date === earlier), true);
  const data2 = fixture(40);
  data2.observations[29][3] = null;
  assert.equal(R.calculate(data2, {lookback: 0}).observations, 40);
  assert.equal(R.calculate(data2, {lookback: 0, basis: 'krw'}).observations, 38);
});

test('constant returns expose undefined correlations without fabricating a diagonal', () => {
  const data = fixture(30);
  data.observations.forEach(row => {row[1] = 100; row[2] = 100;});
  const result = R.calculate(data);
  assert.equal(result.annualVol, 0);
  assert.equal(result.expectedReturn, 0);
  assert.deepEqual(result.correlation, [[null, null, null], [null, null, null], [null, null, null]]);
});

test('invalid weights, options, data and insufficient samples fail explicitly', () => {
  for (const equityWeight of [-0.01, 1.01, NaN, Infinity, '0.6']) assert.throws(() => R.calculate(fixture(), {equityWeight}));
  for (const lookback of [-1, 1, 24, 61, '120', NaN]) assert.throws(() => R.calculate(fixture(), {lookback}));
  assert.throws(() => R.calculate(fixture(), {basis: 'usd'}));
  assert.throws(() => R.calculate(fixture(23)), /24/);
  for (const badValue of [0, -1, Infinity, NaN, '100']) {
    const data = fixture(); data.observations[10][1] = badValue;
    assert.throws(() => R.calculate(data));
  }
  const duplicate = fixture(); duplicate.observations.push(duplicate.observations[0]);
  assert.throws(() => R.calculate(duplicate), /중복/);
  const badDate = fixture(); badDate.observations[0][0] = '2010-02-30';
  assert.throws(() => R.calculate(badDate), /관측일/);
  assert.throws(() => R.calculate({...fixture(), source: {asOf: '2009-12-31'}}), /기준일/);
});

test('published source matches independently calculated Python statistics', () => {
  // Snapshot baseline: direct OOXML daily cells + pandas sample statistics,
  // independent of the production openpyxl exporter and JS calculator.
  // Refresh this baseline with an independent calculation when this source changes.
  const data = require('../template/platform/reference-data.json');
  assert.equal(data.source.sha256, 'a8bb9c01041baa4da150063895e447406c02d6caaecff89e049e3b9823b8a44e');
  assert.deepEqual(data.source.series.equity, {label:'ACWI_TR', ticker:'ACWI INDEX', field:'TOT_RETURN_INDEX_GROSS_DVDS', currency:'USD', column:'GA'});
  for (const [basis, mu, vol] of [
    ['local', 0.08358640395575156, 0.09863176411227352],
    ['krw', 0.09160425059353727, 0.08499064661051356]
  ]) {
    const result = R.calculate(data, {basis});
    near(result.expectedReturn, mu);
    near(result.annualVol, vol);
    assert.equal(result.observations, 120);
    assert.equal(result.gapCount, 0);
    assert.equal(result.startDate, '2016-10-31');
    assert.equal(result.endDate, '2026-10-30');
    assert.equal(result.sourceAsOf, '2026-11-05');
  }
});
