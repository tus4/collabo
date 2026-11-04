'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const A = require('../template/platform/alternative.js');
const near = (a, b, tol = 1e-11) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
const parse = (rows, options = {}) => A.parseRows([['date','value'], ...rows], {frequency:'monthly', ...options});

test('annual arithmetic mean and sample deviation match a direct closed-form example', () => {
  const series = parse([['2024-01-31', 1], ['2024-02-29', 2], ['2024-03-31', 3]], {kind:'return', unit:'percent'});
  const result = A.estimate(series);
  near(result.mu, .24); near(result.vol, .01 * Math.sqrt(12));
  assert.equal(result.count, 3); assert.equal(result.start, '2024-01-31');
  assert.equal(result.end, '2024-03-31');
});

test('positive price levels become simple returns; unsorted input is sorted', () => {
  const s = parse([['2024-04-30', 103.9888], ['2024-01-31', 100], ['2024-03-31', 100.96], ['2024-02-29', 104]]);
  const r = A.estimate(s);
  near(r.mu, (.04 - .02923076923076923 + .03) / 3 * 12);
  assert.equal(r.count, 3);
  assert.throws(() => parse([['2024-01-31', 0]]), /0보다/);
  assert.throws(() => parse([['2024-01-31', -2]]), /0보다/);
});

test('Excel 1900/1904 dates and date strings are deterministic', () => {
  assert.equal(A.isoDate(1), '1900-01-01');
  assert.equal(A.isoDate(59), '1900-02-28');
  assert.throws(() => A.isoDate(60), /유효하지/);
  assert.equal(A.isoDate(61), '1900-03-01');
  assert.equal(A.isoDate(45292), '2024-01-01');
  assert.equal(A.isoDate(0, true), '1904-01-01');
  assert.equal(A.isoDate(20240229), '2024-02-29');
  assert.equal(A.isoDate('2024/2/29'), '2024-02-29');
  assert.equal(A.isoDate(new Date('2024-02-29T00:00:00Z')), '2024-02-29');
  for (const invalid of ['2023-02-29', '2024-02-30', '02/01/2024', '2024-13-01']) assert.throws(() => A.isoDate(invalid));
});

test('malformed data and duplicate dates are rejected instead of coerced to zero', () => {
  assert.throws(() => parse([['2024-01-01', 1], ['2024-01-01', 2]]), /중복/);
  for (const value of ['text', '=1+2', '1,23', Infinity, true, {}, 'NaN']) assert.throws(() => parse([['2024-01-01', value]]));
  assert.throws(() => parse([['', 10]]), /날짜/);
  assert.throws(() => parse([['2024-01-01', '-101%']], {kind:'return', unit:'percent'}), /-100%/);
  assert.throws(() => parse([['2024-01-01', '2%']], {kind:'return', unit:'decimal'}), /단위/);
  near(parse([['2024-01-01', '2%']], {kind:'return', unit:'percent'}).points[0].value, .02);
  near(parse([['2024-01-01', '1,000.25']]).points[0].value, 1000.25);
});

test('missing levels are not filled and intervening missing periods are not single-period returns', () => {
  const s = parse([['2024-01-31', 100], ['2024-02-29', ''], ['2024-03-31', 110], ['2024-05-31', 120], ['2024-06-30', 123]]);
  const r = A.toReturns(s);
  assert.equal(r.returns.length, 1); near(r.returns[0].value, .025);
  assert.equal(r.quality.skippedGaps, 1); assert.equal(r.quality.skippedMissing, 2);
  assert.throws(() => A.estimate(s), /3개/);
});

test('monthly and quarterly level sampling uses the final observation in each period', () => {
  const s = parse([['2024-01-01', 90], ['2024-01-31', 100], ['2024-02-29', 102], ['2024-03-28', 101], ['2024-04-30', 104]]);
  const r = A.toReturns(s); assert.equal(r.returns.length, 3); near(r.returns[0].value, .02);
  const q = parse([['2023-12-29',100], ['2024-03-29',102], ['2024-06-28',101], ['2024-09-30',105]], {frequency:'quarterly'});
  const qr = A.estimate(q); assert.equal(qr.periodsPerYear,4); assert.equal(qr.count,3);
  assert.throws(() => A.toReturns(parse([['2024-01-01',1],['2024-01-31',2]],{kind:'return',unit:'percent'})), /빈도/);
});

test('correlations align identical periods, respect sign, and keep undefined values absent', () => {
  const s = parse([['2024-01-31',1],['2024-02-29',2],['2024-03-31',3],['2024-04-30',4]], {kind:'return',unit:'percent'});
  const negative = parse([['2024-01-30',-2],['2024-02-28',-4],['2024-03-28',-6],['2024-04-29',-8]], {kind:'return',unit:'percent'});
  near(A.correlation(s,s).value,1); near(A.correlation(s,negative).value,-1);
  assert.equal(A.correlation(s,negative).count,4);
  const constant = parse([['2024-01-31',2],['2024-02-29',2],['2024-03-31',2]], {kind:'return',unit:'percent'});
  assert.equal(A.correlation(s,constant).value,null); assert.match(A.correlation(s,constant).reason,/변동성 0/);
  const short = parse([['2024-03-31',1],['2024-04-30',2]],{kind:'return'});
  assert.equal(A.correlation(s,short).value,null); assert.equal(A.correlation(s,short).count,2);
  assert.throws(() => A.correlation(s,{...s,frequency:'quarterly'}), /빈도/);
});

test('daily correlations require the same start and end dates rather than just an end-date match', () => {
  const a = parse([['2024-01-01',100],['2024-01-02',101],['2024-01-03',103],['2024-01-04',102],['2024-01-05',104]],{frequency:'daily'});
  const b = parse([['2024-01-01',100],['2024-01-03',103],['2024-01-04',102],['2024-01-05',104]],{frequency:'daily'});
  assert.equal(A.correlation(a,b).count,2); assert.equal(A.correlation(a,b).value,null);
  const gap = A.toReturns(parse([['2024-01-01',100],['2024-01-08',110],['2024-01-09',111]],{frequency:'daily'}));
  assert.equal(gap.quality.skippedGaps,1); assert.equal(gap.returns.length,1);
  const missingWeekday = A.toReturns(parse([['2024-01-01',100],['2024-01-03',110],['2024-01-04',111]],{frequency:'daily'}));
  assert.equal(missingWeekday.quality.skippedGaps,1); assert.equal(missingWeekday.returns.length,1);
  const weekend = A.toReturns(parse([['2024-01-05',100],['2024-01-08',110]],{frequency:'daily'}));
  assert.equal(weekend.returns.length,1);
});

test('delimited parser preserves quoted commas and escaped quotes', () => {
  assert.deepEqual(A.parseDelimited('\ufeffdate,"asset, A"\r\n2024-01-31,"1,234"\r\n'), [['date','asset, A'],['2024-01-31','1,234']]);
  assert.deepEqual(A.parseDelimited('date\tvalue\n2024-01-31\t1\n'), [['date','value'],['2024-01-31','1']]);
  assert.deepEqual(A.parseDelimited('a,"double "" quote"'), [['a','double " quote']]);
  assert.throws(() => A.parseDelimited('a,"unterminated'), /따옴표/);
});
