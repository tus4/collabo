/* Historical reference portfolio. All returns, risks and weights are fractions. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollaboReference = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const positive = value => finite(value) && value > 0;
  const fail = message => { throw new Error(message); };
  function dateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('레퍼런스 관측일 형식을 확인하십시오.');
    const date = new Date(value + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('레퍼런스 관측일을 확인하십시오.');
    return value;
  }
  function monthNumber(value) {
    return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1;
  }
  function finalWeekday(value) {
    const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0));
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
  function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
  function covariance(a, b) {
    const ma = mean(a), mb = mean(b);
    return a.reduce((sum, value, index) => sum + (value - ma) * (b[index] - mb), 0) / (a.length - 1);
  }
  function correlation(a, b) {
    const va = covariance(a, a), vb = covariance(b, b);
    // Constant observations have no defined correlation, including the diagonal.
    if (!(va > 0) || !(vb > 0)) return null;
    return Math.max(-1, Math.min(1, covariance(a, b) / Math.sqrt(va * vb)));
  }
  function monthlyLevels(data, basis) {
    if (!data || !Array.isArray(data.observations) || !data.observations.length) fail('레퍼런스 원자료가 없습니다.');
    const rows = data.observations.map(row => {
      if (!Array.isArray(row) || row.length < 3) fail('레퍼런스 원자료 형식을 확인하십시오.');
      const date = dateKey(row[0]);
      [row[1], row[2], row[3]].forEach(value => {
        if (value !== null && value !== undefined && !positive(value)) fail('레퍼런스 지수·환율은 양의 유한한 숫자여야 합니다.');
      });
      return [date, row[1], row[2], row[3]];
    }).sort((a, b) => a[0].localeCompare(b[0]));
    for (let i = 1; i < rows.length; i++) if (rows[i][0] === rows[i - 1][0]) fail('레퍼런스 관측일이 중복되었습니다.');
    const sourceAsOf = dateKey(data.source?.asOf || rows[rows.length - 1][0]);
    if (sourceAsOf < rows[rows.length - 1][0]) fail('레퍼런스 기준일이 관측일보다 빠릅니다.');
    const lastCompleteMonth = monthNumber(sourceAsOf) - (sourceAsOf < finalWeekday(sourceAsOf) ? 1 : 0);
    const months = new Map();
    for (const [date, equity, bond, fx] of rows) {
      if (monthNumber(date) > lastCompleteMonth || !positive(equity) || !positive(bond) || (basis === 'krw' && !positive(fx))) continue;
      const equityLevel = basis === 'krw' ? equity * fx : equity;
      if (!positive(equityLevel)) fail('레퍼런스 환산 지수의 범위를 확인하십시오.');
      // Intersect daily observations before picking monthly endpoints; never fill gaps.
      months.set(monthNumber(date), {date, month: monthNumber(date), equity: equityLevel, bond});
    }
    return {sourceAsOf, lastCompleteMonth, levels: Array.from(months.values())};
  }
  function calculate(data, options = {}) {
    const equityWeight = options.equityWeight === undefined ? 0.6 : options.equityWeight;
    const lookback = options.lookback === undefined ? 120 : options.lookback;
    const basis = options.basis === undefined ? 'local' : options.basis;
    if (!finite(equityWeight) || equityWeight < 0 || equityWeight > 1) fail('해외주식 비중은 0–100% 범위여야 합니다.');
    if (![0, 60, 120].includes(lookback)) fail('레퍼런스 추정 기간을 확인하십시오.');
    if (!['local', 'krw'].includes(basis)) fail('레퍼런스 환율 기준을 확인하십시오.');
    const prepared = monthlyLevels(data, basis), levels = prepared.levels;
    let rows = [];
    for (let i = 1; i < levels.length; i++) {
      const previous = levels[i - 1], current = levels[i];
      if (current.month - previous.month !== 1) continue;
      const equity = current.equity / previous.equity - 1, bond = current.bond / previous.bond - 1;
      const reference = equityWeight * equity + (1 - equityWeight) * bond;
      if (![equity, bond, reference].every(finite)) fail('레퍼런스 수익률 계산 범위를 확인하십시오.');
      rows.push({date: current.date, startDate: previous.date, equity, bond, reference});
    }
    // The selector is a calendar window, not a quota of non-missing observations.
    if (lookback) rows = rows.filter(row => monthNumber(row.date) >= prepared.lastCompleteMonth - lookback + 1);
    if (rows.length < 24) fail('레퍼런스 산출에는 공통 월간 수익률 24개 이상이 필요합니다.');
    const series = ['equity', 'bond', 'reference'].map(key => rows.map(row => row[key]));
    const stats = series.map(values => ({expectedReturn: mean(values) * 12, annualVol: Math.sqrt(Math.max(0, covariance(values, values)) * 12)}));
    if (stats.some(stat => !finite(stat.expectedReturn) || !finite(stat.annualVol))) fail('레퍼런스 통계량 계산 범위를 확인하십시오.');
    let wealth = 1, gaps = 0;
    rows = rows.map((row, i) => {
      if (i && row.startDate !== rows[i - 1].date) gaps++;
      wealth *= 1 + row.reference;
      if (!finite(wealth)) fail('레퍼런스 누적 수익률 계산 범위를 확인하십시오.');
      return {...row, cumulative: gaps ? null : wealth - 1};
    });
    return {
      weights: [equityWeight, 1 - equityWeight], basis, lookback,
      observations: rows.length, startDate: rows[0].startDate, endDate: rows[rows.length - 1].date,
      sourceAsOf: prepared.sourceAsOf, expectedReturn: stats[2].expectedReturn, annualVol: stats[2].annualVol,
      cagr: gaps ? null : Math.expm1(series[2].reduce((sum, value) => sum + Math.log1p(value), 0) * 12 / rows.length),
      assetStats: stats.slice(0, 2), correlation: series.map(a => series.map(b => correlation(a, b))),
      gaps, gapCount: gaps, rows
    };
  }
  return {calculate};
}));
