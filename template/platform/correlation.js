/* Paired daily index levels and trailing simple-return correlations. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollaboCorrelation = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const fail = message => { throw new Error(message); };
  function dateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('시계열 관측일 형식을 확인하십시오.');
    const stamp = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(stamp.getTime()) || stamp.toISOString().slice(0, 10) !== value) fail('시계열 관측일을 확인하십시오.');
    return value;
  }
  function prepare(series, sourceAsOf) {
    if (!Array.isArray(series.observations) || !series.observations.length) fail('선택한 지수의 원자료가 없습니다.');
    const values = new Map();
    for (const row of series.observations) {
      if (!Array.isArray(row) || row.length !== 2) fail('시계열 원자료 형식을 확인하십시오.');
      const date = dateKey(row[0]), value = row[1];
      if (values.has(date)) fail('시계열 관측일이 중복되었습니다.');
      if (date > sourceAsOf) fail('시계열 기준일이 관측일보다 빠릅니다.');
      if (value !== null && (!finite(value) || value <= 0)) fail('시계열 지수는 양의 유한한 숫자 또는 결측값이어야 합니다.');
      values.set(date, value);
    }
    return values;
  }
  function metadata(series) {
    const {observations, ...result} = series;
    return result;
  }
  function pearson(a, b) {
    if (a.length < 2) return null;
    const meanA = a.reduce((sum, value) => sum + value / a.length, 0);
    const meanB = b.reduce((sum, value) => sum + value / b.length, 0);
    const centeredA = a.map(value => value - meanA), centeredB = b.map(value => value - meanB);
    const scaleA = centeredA.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    const scaleB = centeredB.reduce((largest, value) => Math.max(largest, Math.abs(value)), 0);
    // Division of equal-growth levels may introduce round-off-sized dispersion.
    const toleranceA = 32 * Number.EPSILON * a.reduce((largest, value) => Math.max(largest, Math.abs(value)), 1);
    const toleranceB = 32 * Number.EPSILON * b.reduce((largest, value) => Math.max(largest, Math.abs(value)), 1);
    if (scaleA <= toleranceA || scaleB <= toleranceB) return null;
    let cross = 0, squareA = 0, squareB = 0;
    for (let i = 0; i < a.length; i++) {
      const x = centeredA[i] / scaleA, y = centeredB[i] / scaleB;
      cross += x * y; squareA += x * x; squareB += y * y;
    }
    return Math.max(-1, Math.min(1, cross / Math.sqrt(squareA * squareB)));
  }
  function calculate(data, options = {}) {
    if (!data || data.schemaVersion !== 1 || !Array.isArray(data.series) || !data.series.length) fail('시계열 원자료 버전과 형식을 확인하십시오.');
    const sourceAsOf = dateKey(data.source?.asOf);
    const ids = new Set();
    data.series.forEach(series => {
      if (!series || typeof series.id !== 'string' || !series.id || ids.has(series.id)) fail('시계열 지수 ID가 없거나 중복되었습니다.');
      ids.add(series.id);
    });
    const firstId = options.first === undefined ? 'ACWI_TR' : options.first;
    const secondId = options.second === undefined ? 'LEGATRUU' : options.second;
    const first = data.series.find(series => series.id === firstId), second = data.series.find(series => series.id === secondId);
    if (!first || !second) fail('비교할 지수 두 개를 선택하십시오.');
    const window = options.window === undefined ? 60 : options.window;
    if (!Number.isInteger(window) || window < 2 || window > 252) fail('이동상관 관측 수는 2–252 범위의 정수여야 합니다.');
    const a = prepare(first, sourceAsOf), b = first === second ? a : prepare(second, sourceAsOf);
    const dates = Array.from(new Set([...a.keys(), ...b.keys()])).sort();
    const start = options.start === undefined ? dates[0] : dateKey(options.start);
    const end = options.end === undefined ? dates[dates.length - 1] : dateKey(options.end);
    if (start > end) fail('시작일은 종료일보다 늦을 수 없습니다.');
    const rows = [], allA = [], allB = [];
    let previous = null, base = null, trailingA = [], trailingB = [], missingCount = 0, pendingGap = false;
    for (const date of dates) {
      // Slice levels first: no return or trailing window may use a pre-start level.
      if (date < start || date > end) continue;
      const firstValue = a.get(date), secondValue = b.get(date);
      if (!finite(firstValue) || !finite(secondValue)) {
        missingCount++; previous = null; trailingA = []; trailingB = []; pendingGap = true;
        continue;
      }
      if (previous && (Date.parse(date) - Date.parse(previous.date)) / 86400000 > 7) {
        missingCount++; previous = null; trailingA = []; trailingB = []; pendingGap = true;
      }
      if (!base) base = [firstValue, secondValue];
      const row = {date, first: firstValue, second: secondValue,
        first100: firstValue / base[0] * 100, second100: secondValue / base[1] * 100,
        firstReturn: null, secondReturn: null, rolling: null, gapBefore: pendingGap};
      if (!finite(row.first100) || !finite(row.second100)) fail('시계열 지수 계산 범위를 확인하십시오.');
      if (previous) {
        row.firstReturn = firstValue / previous.first - 1;
        row.secondReturn = secondValue / previous.second - 1;
        if (!finite(row.firstReturn) || !finite(row.secondReturn)) fail('시계열 수익률 계산 범위를 확인하십시오.');
        allA.push(row.firstReturn); allB.push(row.secondReturn);
        trailingA.push(row.firstReturn); trailingB.push(row.secondReturn);
        if (trailingA.length > window) { trailingA.shift(); trailingB.shift(); }
        if (trailingA.length === window) row.rolling = pearson(trailingA, trailingB);
      }
      rows.push(row); previous = row; pendingGap = false;
    }
    if (rows.length < 2) fail('선택 기간에 공통 지수 관측값이 2개 이상 필요합니다.');
    return {first: metadata(first), second: metadata(second), sourceAsOf,
      startDate: rows[0].date, endDate: rows[rows.length - 1].date, window,
      correlation: pearson(allA, allB), observations: allA.length, rows, missingCount};
  }
  return {calculate};
}));
