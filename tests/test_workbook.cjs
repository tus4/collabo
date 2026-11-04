'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('../template/platform/vendor/xlsx.full.min.js');
const W = require('../template/platform/workbook.js');

function bytes(sheets, bookType = 'xlsx', date1904 = false) {
  const workbook = {SheetNames: Object.keys(sheets), Sheets: sheets, Workbook: {WBProps: {date1904}}};
  return XLSX.write(workbook, {bookType, type: 'buffer', compression: true});
}
function sheet(rows) { return XLSX.utils.aoa_to_sheet(rows); }

test('reads actual XLSX bytes, all sheet names, blanks, Korean labels and cached formulas', async () => {
  const prices = sheet([['일자', '사모대출'], [45292, 100], [45323, null], [45352, 103]]);
  prices.A2.z = prices.A3.z = prices.A4.z = 'yyyy-mm-dd';
  prices.B4.f = '100+3';
  const result = await W.read(bytes({'대체 자산': prices, '비교 자산': sheet([['일자', '국내주식'], ['2024-01-31', 100]])}));
  assert.deepEqual(result.sheets.map(s => s.name), ['대체 자산', '비교 자산']);
  assert.deepEqual(result.sheets[0].rows, [['일자', '사모대출'], ['2024-01-01', 100], ['2024-02-01', null], ['2024-03-01', 103]]);
  assert.equal(result.date1904, false);
});

test('reads XLS binary and converts 1904 dates without a four-year shift', async () => {
  const s = sheet([['Date', 'NAV'], [43830, 120.25]]);
  s.A2.z = 'yyyy-mm-dd';
  for (const format of ['xlsx', 'xls']) {
    const result = await W.read(bytes({NAV: s}, format, true));
    assert.equal(result.date1904, true);
    assert.equal(result.sheets[0].rows[1][0], '2024-01-01');
    assert.equal(result.sheets[0].rows[1][1], 120.25);
  }
});

test('keeps numeric returns as decimals and does not round or evaluate strings', async () => {
  const result = await W.read(bytes({Returns: sheet([['Date','Return'],['2024-01-31',0.0123456789],['2024-02-29','=1+2']])}));
  assert.equal(result.sheets[0].rows[1][1], 0.0123456789);
  assert.equal(result.sheets[0].rows[2][1], '=1+2');
});

test('rejects formulas without cached values and explicit Excel error cells', async () => {
  const uncached = sheet([['Date','NAV'],['2024-01-31',100]]);
  uncached.B2 = {t: 'n', f: '10*10'};
  await assert.rejects(W.read(bytes({NAV:uncached})), /수식 계산 결과/);
  const errors = sheet([['Date','NAV'],['2024-01-31',100]]);
  errors.B2 = {t: 'e', v: 7};
  await assert.rejects(W.read(bytes({NAV:errors})), /오류값/);
});

test('rejects oversized dimensions without silently truncating rows', async () => {
  const tall = {A1:{t:'s',v:'Date'}, A20001:{t:'n',v:100}, '!ref':'A1:A20001'};
  await assert.rejects(W.read(bytes({Tall:tall})), /20,000행/);
  const wide = {A1:{t:'s',v:'Date'}, CW1:{t:'n',v:100}, '!ref':'A1:CW1'};
  await assert.rejects(W.read(bytes({Wide:wide})), /100열/);
  const sheets = Object.fromEntries(Array.from({length:21}, (_,i)=>['Sheet'+i,sheet([['Date',100]])]));
  await assert.rejects(W.read(bytes(sheets)), /1~20개/);
});

test('rejects non-Excel, empty, damaged, oversized and empty-workbook input', async () => {
  await assert.rejects(W.read(new Uint8Array()), /10MB/);
  await assert.rejects(W.read(new Uint8Array(W.limits.bytes+1)), /10MB/);
  await assert.rejects(W.read(Buffer.from('<html><script>alert(1)</script></html>')), /XLSX 또는 XLS/);
  const damaged = bytes({NAV:sheet([['Date','Value'],['2024-01-01',100]])});
  await assert.rejects(W.read(damaged.subarray(0, damaged.length - 1)), /압축 구조/);
  await assert.rejects(W.read(bytes({Empty:sheet([])})), /데이터가 있는/);
});

test('rejects ZIP directory expansion beyond the memory budget before parsing', async () => {
  const b = Buffer.from(bytes({NAV:sheet([['Date','Value'],['2024-01-01',100]])}));
  const end = b.length-22, offset = b.readUInt32LE(end+16);
  b.writeUInt32LE(W.limits.expandedBytes+1, offset+24);
  await assert.rejects(W.read(b), /40MB/);
});

test('rejects impossible Excel leap day 1900-02-29', async () => {
  const s = sheet([['Date','NAV'],[60,100]]);s.A2.z='yyyy-mm-dd';
  await assert.rejects(W.read(bytes({NAV:s})), /엑셀 날짜/);
});
