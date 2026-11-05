'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const C = require('../template/platform/correlation.js');

function near(actual, expected, tolerance = 1e-12) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
}
function fixture(firstReturns = [.01, -.02, .03, -.01, .04], secondReturns = firstReturns) {
  const dates = Array.from({length:firstReturns.length + 1}, (_, i) => new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10));
  const build = (id, returns, initial) => {
    let level = initial;
    return {id, label:id, currency:'USD', observations:dates.map((date, i) => {
      if (i) level *= 1 + returns[i - 1];
      return [date, level];
    })};
  };
  return {schemaVersion:1, source:{asOf:dates.at(-1)}, series:[build('ACWI_TR', firstReturns, 100), build('LEGATRUU', secondReturns, 200)]};
}

test('analytic positive and negative return relations produce +/-1 correlations', () => {
  const returns = [.01, -.02, .03, -.01, .04];
  for (const sign of [1, -1]) {
    const result = C.calculate(fixture(returns, returns.map(value => sign * value)), {window:3});
    near(result.correlation, sign);
    assert.equal(result.observations, returns.length);
    assert.equal(result.rows[2].rolling, null);
    result.rows.slice(3).forEach(row => near(row.rolling, sign));
    near(result.rows[0].first100, 100); near(result.rows[0].second100, 100);
  }
});

test('Pearson agrees with a separate dot-product identity for nontrivial returns', () => {
  const a = [.01, .04, -.02, .03, -.03], b = [-.02, .01, .04, -.01, .02];
  const n = a.length, sumA = a.reduce((s, v) => s + v, 0), sumB = b.reduce((s, v) => s + v, 0);
  const cross = a.reduce((s, v, i) => s + v * b[i], 0), aa = a.reduce((s, v) => s + v * v, 0), bb = b.reduce((s, v) => s + v * v, 0);
  const expected = (n * cross - sumA * sumB) / Math.sqrt((n * aa - sumA ** 2) * (n * bb - sumB ** 2));
  const result = C.calculate(fixture(a, b), {window:n});
  near(result.correlation, expected); near(result.rows.at(-1).rolling, expected);
});

test('constant levels and constant growth report undefined correlation', () => {
  for (const returns of [Array(80).fill(0), Array(80).fill(.01)]) {
    const varying = returns.map((_, i) => .01 * Math.sin(i));
    const result = C.calculate(fixture(returns, varying));
    assert.equal(result.correlation, null);
    assert.ok(result.rows.every(row => row.rolling === null));
  }
});

test('range endpoints are inclusive and discard all pre-start returns and warmup', () => {
  const data = fixture(), result = C.calculate(data, {start:'2026-01-03', end:'2026-01-05', window:2});
  assert.deepEqual(result.rows.map(row => row.date), ['2026-01-03', '2026-01-04', '2026-01-05']);
  assert.equal(result.observations, 2);
  assert.equal(result.rows[0].firstReturn, null);
  assert.equal(result.rows[1].rolling, null);
  near(result.rows[2].rolling, 1);
  near(result.rows[0].first100, 100);
  const changed = structuredClone(data);
  changed.series[0].observations[0][1] = 999;
  changed.series[0].observations.at(-1)[1] = 777;
  assert.deepEqual(C.calculate(changed, {start:'2026-01-03', end:'2026-01-05', window:2}), result);
});

test('missing union dates break returns and reset the trailing window without filling', () => {
  for (const missingKind of ['null', 'absent']) {
    const data = fixture(Array.from({length:10}, (_, i) => .01 * Math.sin(i)));
    if (missingKind === 'null') data.series[1].observations[4][1] = null;
    else data.series[1].observations.splice(4, 1);
    const result = C.calculate(data, {window:3});
    assert.equal(result.missingCount, 1);
    assert.equal(result.observations, 8);
    assert.equal(result.rows.some(row => row.date === '2026-01-05'), false);
    const resumed = result.rows.findIndex(row => row.date === '2026-01-06');
    assert.equal(result.rows[resumed].gapBefore, true);
    assert.equal(result.rows[resumed].firstReturn, null);
    assert.ok(result.rows.slice(resumed, resumed + 3).every(row => row.rolling === null));
    near(result.rows[resumed + 3].rolling, 1);
  }
});

test('ordinary weekends preserve intervals while gaps beyond seven days reset windows', () => {
  const data = fixture();
  const dates = ['2026-01-01', '2026-01-02', '2026-01-05', '2026-01-06', '2026-01-16', '2026-01-19'];
  data.source.asOf = dates.at(-1);
  data.series.forEach(series => series.observations.forEach((row, i) => {row[0] = dates[i];}));
  const result = C.calculate(data, {window:2});
  assert.equal(result.missingCount, 1); assert.equal(result.observations, 4);
  near(result.rows[2].rolling, 1);
  assert.equal(result.rows[4].gapBefore, true);
  assert.equal(result.rows[4].firstReturn, null);
  assert.equal(result.rows[5].rolling, null);
});

test('short samples keep rebased levels but do not invent a rolling estimate', () => {
  const result = C.calculate(fixture([.01], [.02]));
  assert.equal(result.rows.length, 2); assert.equal(result.observations, 1);
  assert.equal(result.correlation, null);
  assert.ok(result.rows.every(row => row.rolling === null));
});

test('switching pair order swaps levels and preserves correlation; same index is valid', () => {
  const data = fixture([.01, -.02, .03, -.01, .04], [.03, .02, -.01, .01, -.02]);
  const forward = C.calculate(data, {window:2}), reverse = C.calculate(data, {first:'LEGATRUU', second:'ACWI_TR', window:2});
  near(reverse.correlation, forward.correlation);
  reverse.rows.forEach((row, i) => {near(row.first, forward.rows[i].second); near(row.second, forward.rows[i].first);});
  near(C.calculate(data, {first:'ACWI_TR', second:'ACWI_TR'}).correlation, 1);
});

test('future return changes cannot alter earlier trailing correlations', () => {
  const data = fixture(Array.from({length:80}, (_, i) => .01 * Math.sin(i)), Array.from({length:80}, (_, i) => .02 * Math.cos(i)));
  const before = C.calculate(data), changed = structuredClone(data);
  changed.series[1].observations.at(-1)[1] *= 4;
  const after = C.calculate(changed);
  assert.deepEqual(after.rows.slice(0, -1), before.rows.slice(0, -1));
  assert.notEqual(after.rows.at(-1).rolling, before.rows.at(-1).rolling);
});

test('unsorted valid observations sort deterministically and inputs remain unchanged', () => {
  const data = fixture(), expected = C.calculate(data), original = structuredClone(data);
  data.series.forEach(series => series.observations.reverse());
  const reversed = structuredClone(data);
  assert.deepEqual(C.calculate(data), expected);
  assert.deepEqual(data, reversed);
  assert.notDeepEqual(data, original);
});

test('invalid data, duplicate dates, out-of-range options and empty overlap fail explicitly', () => {
  for (const badValue of [0, -1, NaN, Infinity, '100', undefined]) {
    const data = fixture(); data.series[0].observations[1][1] = badValue;
    assert.throws(() => C.calculate(data), /지수/);
  }
  for (const date of ['2026-02-30', '2026-1-01', 'no-date']) {
    const data = fixture(); data.series[0].observations[0][0] = date;
    assert.throws(() => C.calculate(data), /관측일/);
  }
  const duplicate = fixture(); duplicate.series[0].observations.push(duplicate.series[0].observations[0]);
  assert.throws(() => C.calculate(duplicate), /중복/);
  const badAsOf = fixture(); badAsOf.source.asOf = '2025-12-31';
  assert.throws(() => C.calculate(badAsOf), /기준일/);
  const duplicateId = fixture(); duplicateId.series[1].id = 'ACWI_TR';
  assert.throws(() => C.calculate(duplicateId), /ID/);
  for (const window of [0, 1, 1.5, 253, NaN, '60']) assert.throws(() => C.calculate(fixture(), {window}), /관측 수/);
  assert.throws(() => C.calculate({...fixture(), schemaVersion:2}), /버전/);
  assert.throws(() => C.calculate(fixture(), {first:'MISSING'}), /선택/);
  assert.throws(() => C.calculate(fixture(), {start:'2026-02-01', end:'2026-01-01'}), /시작일/);
  assert.throws(() => C.calculate(fixture(), {start:'2030-01-01'}), /시작일/);
  assert.throws(() => C.calculate(fixture(), {start:'2026-01-06', end:'2026-01-06'}), /2개/);
  const missing = fixture(); missing.series[0].observations.forEach(row => {row[1] = null;});
  assert.throws(() => C.calculate(missing), /2개/);
});
