/* Two-asset historical correlation scenarios. Returns and weights are fractions. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollaboSimulation = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DAY = 86400000;
  const CONFIG = [
    {id: 'daily', label: '일간', periods: 252, minimum: 60},
    {id: 'weekly', label: '주간', periods: 52, minimum: 26},
    {id: 'monthly', label: '월간', periods: 12, minimum: 24}
  ];
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const positive = value => finite(value) && value > 0;
  const clamp = value => Math.max(0, Math.min(1, value));
  const fail = message => { throw new Error(message); };
  function dateKey(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('시뮬레이션 관측일 형식을 확인하십시오.');
    const date = new Date(value + 'T00:00:00Z');
    if (!finite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('시뮬레이션 관측일을 확인하십시오.');
    return value;
  }
  function dayNumber(value) { return new Date(value + 'T00:00:00Z').getTime() / DAY; }
  function monthNumber(value) { return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1; }
  function finalWeekday(value) {
    const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0));
    while ([0, 6].includes(date.getUTCDay())) date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  }
  function mean(values) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
  function covariance(a, b) {
    const ma = mean(a), mb = mean(b);
    return a.reduce((sum, value, i) => sum + (value - ma) * (b[i] - mb), 0) / (a.length - 1);
  }
  function prepareLevels(data, basis = 'local') {
    if (!['local', 'krw'].includes(basis)) fail('시뮬레이션 환율 기준을 확인하십시오.');
    if (!data || !Array.isArray(data.observations) || !data.observations.length) fail('시뮬레이션 원자료가 없습니다.');
    const rows = data.observations.map(row => {
      if (!Array.isArray(row) || row.length < 3) fail('시뮬레이션 원자료 형식을 확인하십시오.');
      const date = dateKey(row[0]);
      [row[1], row[2], row[3]].forEach(value => {
        if (value !== null && value !== undefined && !positive(value)) fail('시뮬레이션 지수·환율은 양의 유한한 숫자여야 합니다.');
      });
      const valid = positive(row[1]) && positive(row[2]) && (basis === 'local' || positive(row[3]));
      const equity = valid ? row[1] * (basis === 'krw' ? row[3] : 1) : null;
      if (valid && !positive(equity)) fail('시뮬레이션 환산 지수의 범위를 확인하십시오.');
      return {date, equity, bond: valid ? row[2] : null, valid};
    }).sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < rows.length; i++) if (rows[i].date === rows[i - 1].date) fail('시뮬레이션 관측일이 중복되었습니다.');
    const sourceAsOf = dateKey(data.source?.asOf || rows[rows.length - 1].date);
    if (sourceAsOf < rows[rows.length - 1].date) fail('시뮬레이션 기준일이 관측일보다 빠릅니다.');
    return {sourceAsOf, rows};
  }
  function periodLevels(rows, frequency, end) {
    if (!CONFIG.some(item => item.id === frequency)) fail('시뮬레이션 관측 주기를 확인하십시오.');
    dateKey(end);
    const endpoints = new Map(), lastDay = dayNumber(end);
    for (const row of rows) {
      if (!row.valid || row.date > end) continue;
      const day = dayNumber(row.date), weekday = new Date(day * DAY).getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      let period;
      if (frequency === 'daily') {
        // Consecutive weekday ordinals: missing weekdays are not bridged.
        period = day - 2 * Math.floor((day + 3) / 7);
      } else if (frequency === 'weekly') {
        period = Math.floor((day + 3) / 7);
        if (period * 7 + 1 > lastDay) continue; // Friday-ending completed weeks.
      } else {
        period = monthNumber(row.date);
        if (finalWeekday(row.date) > end) continue;
      }
      endpoints.set(period, {...row, period});
    }
    return Array.from(endpoints.values());
  }
  function resampleReturns(rows, frequency, start, end) {
    const levels = periodLevels(rows, frequency, end), returns = [];
    for (let i = 1; i < levels.length; i++) {
      const previous = levels[i - 1], current = levels[i];
      if (current.period - previous.period !== 1 || previous.date < start) continue;
      const equity = current.equity / previous.equity - 1, bond = current.bond / previous.bond - 1;
      if (![equity, bond].every(finite) || equity <= -1 || bond <= -1) fail('시뮬레이션 수익률 계산 범위를 확인하십시오.');
      returns.push({date: current.date, startDate: previous.date, equity, bond});
    }
    return returns;
  }
  function statistics(rows, periods) {
    if (rows.length < 2) fail('통계량 산출에는 수익률 2개 이상이 필요합니다.');
    const a = rows.map(row => row.equity), b = rows.map(row => row.bond);
    const variable = values => {
      const average = mean(values);
      const scale = values.reduce((largest, value) => Math.max(largest, Math.abs(value)), 1);
      return values.some(value => Math.abs(value - average) > 32 * Number.EPSILON * scale);
    };
    // Dividing constant-growth index levels can create machine-sized dispersion.
    const va = variable(a) ? covariance(a, a) : 0, vb = variable(b) ? covariance(b, b) : 0;
    const cov = covariance(a, b);
    const means = [mean(a) * periods, mean(b) * periods];
    const vols = [Math.sqrt(Math.max(0, va) * periods), Math.sqrt(Math.max(0, vb) * periods)];
    const rho = va > 0 && vb > 0 ? Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb))) : null;
    if (![...means, ...vols].every(finite)) fail('시뮬레이션 통계량의 범위를 확인하십시오.');
    return {means, vols, rho, n: rows.length, startDate: rows[0].startDate, endDate: rows[rows.length - 1].date};
  }
  function checkParameters(means, vols, rho, rf) {
    if (!Array.isArray(means) || means.length !== 2 || !means.every(finite) ||
        !Array.isArray(vols) || vols.length !== 2 || !vols.every(value => finite(value) && value >= 0) ||
        !finite(rho) || rho < -1 || rho > 1 || !finite(rf)) fail('시뮬레이션 모수 범위를 확인하십시오.');
  }
  function portfolioPoint(weight, means, vols, rho, rf = 0) {
    checkParameters(means, vols, rho, rf);
    if (!finite(weight) || weight < 0 || weight > 1) fail('시뮬레이션 비중은 0–100% 범위여야 합니다.');
    const a = weight * vols[0], b = (1 - weight) * vols[1];
    // Stable at rho=-1, where cancellation can produce a zero-risk portfolio.
    const variance = (a - b) ** 2 + 2 * a * b * (1 + rho);
    const annualVol = Math.sqrt(Math.max(0, variance));
    const expectedReturn = weight * means[0] + (1 - weight) * means[1];
    const zeroRisk = annualVol <= 1e-14 * Math.max(vols[0], vols[1], 1e-12);
    const excess = expectedReturn - rf;
    const sharpe = zeroRisk ? null : excess / annualVol;
    return {weight, expectedReturn, annualVol: zeroRisk ? 0 : annualVol, sharpe,
      sharpeStatus: zeroRisk ? (excess > 0 ? 'positiveInfinity' : excess < 0 ? 'negativeInfinity' : 'undefined') : 'finite'};
  }
  function minimumWeight(means, vols, rho) {
    const [a, b] = vols;
    const denominator = (a - b) ** 2 + 2 * a * b * (1 - rho);
    if (denominator === 0) return means[0] === means[1] ? 0.6 : Number(means[0] > means[1]);
    return clamp((b * b - rho * a * b) / denominator);
  }
  function optimize(means, vols, rho, objective = 'minVol', rf = 0) {
    checkParameters(means, vols, rho, rf);
    if (!['minVol', 'maxSharpe'].includes(objective)) fail('시뮬레이션 최적화 기준을 확인하십시오.');
    const gmv = minimumWeight(means, vols, rho);
    if (objective === 'minVol') return portfolioPoint(gmv, means, vols, rho, rf);
    const ea = means[0] - rf, eb = means[1] - rf;
    const a = vols[0] ** 2, b = vols[1] ** 2, c = rho * vols[0] * vols[1];
    const denominator = ea * b + eb * a - (ea + eb) * c;
    const candidates = [0, 1, gmv];
    if (denominator !== 0) {
      const critical = (ea * b - eb * c) / denominator;
      if (finite(critical) && critical >= 0 && critical <= 1) candidates.push(critical);
    }
    const score = point => point.sharpeStatus === 'positiveInfinity' ? Infinity : point.sharpe === null ? -Infinity : point.sharpe;
    return candidates.map(weight => portfolioPoint(weight, means, vols, rho, rf)).reduce((best, point) => {
      const x = score(point), y = score(best);
      if (x > y || (x === y && point.expectedReturn > best.expectedReturn)) return point;
      return best;
    });
  }
  function efficientFrontier(means, vols, rho, rf = 0) {
    checkParameters(means, vols, rho, rf);
    const gmv = minimumWeight(means, vols, rho);
    if (means[0] === means[1]) return [portfolioPoint(gmv, means, vols, rho, rf)];
    const endpoint = Number(means[0] > means[1]);
    if (gmv === endpoint) return [portfolioPoint(gmv, means, vols, rho, rf)];
    return Array.from({length: 101}, (_, i) => portfolioPoint(i === 100 ? endpoint : clamp(gmv + (endpoint - gmv) * i / 100), means, vols, rho, rf));
  }
  function performance(prepared, options, scenarios, inSampleRows) {
    const keys = scenarios.map(scenario => scenario.id);
    const labels = scenarios.map(scenario => scenario.label);
    const empty = {points: [], keys, labels, stats: keys.map(() => null), evaluation: options.evaluation, startDate: null, endDate: null, error: null};
    let rows;
    if (options.evaluation === 'inSample') rows = inSampleRows;
    else {
      const levels = periodLevels(prepared.rows, 'monthly', options.performanceEnd);
      // A known training month-end is a valid baseline; only subsequent returns
      // enter holdout wealth. A mid-month cutoff waits for the next month-end.
      const anchor = levels.find(level => level.date >= options.end);
      rows = anchor ? resampleReturns(prepared.rows, 'monthly', anchor.date, options.performanceEnd) : [];
      if (rows.length && rows[0].startDate !== anchor.date) return {...empty, error: '성과 시작 이후 공통 월말 결측이 있어 누적성과를 연결할 수 없습니다.'};
    }
    if (!rows.length) return {...empty, error: options.evaluation === 'holdout' ? '추정 종료일 이후 기준 월말과 다음 월말 관측이 필요합니다.' : '성과 산출에 필요한 공통 월수익률이 없습니다.'};
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].startDate !== rows[i - 1].date) return {...empty, error: '성과 기간에 공통 월말 결측이 있어 누적성과를 연결할 수 없습니다.'};
    }
    const weights = scenarios.map(scenario => scenario.optimum?.weight ?? null);
    const wealth = weights.map(weight => weight === null ? null : 1);
    const peak = wealth.slice(), maxDrawdown = wealth.map(value => value === null ? null : 0);
    const histories = weights.map(() => []);
    const points = [{date: rows[0].startDate, values: wealth.map(value => value === null ? null : 100)}];
    for (const row of rows) {
      weights.forEach((weight, i) => {
        if (weight === null) return;
        const value = weight * row.equity + (1 - weight) * row.bond;
        wealth[i] *= 1 + value;
        if (!positive(wealth[i])) fail('시뮬레이션 누적성과의 범위를 확인하십시오.');
        histories[i].push(value);
        peak[i] = Math.max(peak[i], wealth[i]);
        maxDrawdown[i] = Math.min(maxDrawdown[i], wealth[i] / peak[i] - 1);
      });
      points.push({date: row.date, values: wealth.map(value => value === null ? null : value * 100)});
    }
    const stats = weights.map((weight, i) => weight === null ? null : {
      id: keys[i], weight, totalReturn: wealth[i] - 1,
      cagr: Math.expm1(Math.log(wealth[i]) * 12 / rows.length),
      annualVol: rows.length > 1 ? Math.sqrt(Math.max(0, covariance(histories[i], histories[i])) * 12) : null,
      maxDrawdown: maxDrawdown[i]
    });
    return {...empty, points, stats, startDate: rows[0].startDate, endDate: rows[rows.length - 1].date};
  }
  function calculate(data, options = {}) {
    const basis = options.basis ?? 'local', mode = options.mode ?? 'correlation';
    const objective = options.objective ?? 'minVol', rf = options.rf ?? 0;
    const customRhos = options.customRhos !== undefined ? options.customRhos :
      options.customRho !== undefined ? [options.customRho] : [-1, -0.5, 0, 0.5, 1];
    const evaluation = options.evaluation ?? 'holdout';
    if (!['correlation', 'full'].includes(mode)) fail('시뮬레이션 비교 방식을 확인하십시오.');
    if (!['minVol', 'maxSharpe'].includes(objective)) fail('시뮬레이션 최적화 기준을 확인하십시오.');
    if (!['holdout', 'inSample'].includes(evaluation)) fail('시뮬레이션 성과 구분을 확인하십시오.');
    if (!finite(rf)) fail('시뮬레이션 무위험수익률 범위를 확인하십시오.');
    if (!Array.isArray(customRhos) || customRhos.length < 1 || customRhos.length > 7 ||
        !customRhos.every(rho => finite(rho) && Math.abs(rho) <= 1)) fail('Custom 상관계수는 −1–1 범위의 숫자로 1–7개 입력하십시오.');
    if (new Set(customRhos).size !== customRhos.length) fail('Custom 상관계수는 서로 다른 값으로 입력하십시오.');
    const prepared = prepareLevels(data, basis);
    const requestedStart = dateKey(options.start ?? prepared.rows[0].date);
    const requestedEnd = dateKey(options.end ?? prepared.sourceAsOf);
    const end = requestedEnd < prepared.sourceAsOf ? requestedEnd : prepared.sourceAsOf;
    const requestedPerformanceEnd = dateKey(options.performanceEnd ?? prepared.sourceAsOf);
    const performanceEnd = requestedPerformanceEnd < prepared.sourceAsOf ? requestedPerformanceEnd : prepared.sourceAsOf;
    if (requestedStart >= end) fail('시뮬레이션 시작일은 종료일보다 빨라야 합니다.');
    const monthlyRows = resampleReturns(prepared.rows, 'monthly', requestedStart, end);
    if (monthlyRows.length < 24) fail('시뮬레이션에는 공통 월수익률 24개 이상이 필요합니다.');
    const baseline = statistics(monthlyRows, 12);
    const scenarios = CONFIG.map(config => {
      const rows = config.id === 'monthly' ? monthlyRows : resampleReturns(prepared.rows, config.id, requestedStart, end);
      const item = {id: config.id, label: config.label, n: rows.length, rho: null,
        startDate: rows[0]?.startDate ?? null, endDate: rows[rows.length - 1]?.date ?? null,
        means: null, vols: null, frontier: [], optimum: null, error: null};
      if (rows.length < config.minimum) return {...item, error: `${config.label} 공통 수익률 ${config.minimum}개 이상이 필요합니다.`};
      const observed = statistics(rows, config.periods);
      if (observed.rho === null) return {...item, error: '변동성이 0인 자산의 관측 상관계수는 정의되지 않습니다.'};
      const means = mode === 'correlation' ? baseline.means.slice() : observed.means;
      const vols = mode === 'correlation' ? baseline.vols.slice() : observed.vols;
      return {...item, rho: observed.rho, means, vols,
        frontier: efficientFrontier(means, vols, observed.rho, rf),
        optimum: optimize(means, vols, observed.rho, objective, rf)};
    });
    customRhos.forEach((rho, index) => scenarios.push({id: 'custom-' + (index + 1),
      label: 'Custom ' + (index + 1) + ' · ρ = ' + (rho > 0 ? '+' : '') + rho.toFixed(2), n: baseline.n, rho,
      startDate: baseline.startDate, endDate: baseline.endDate, means: baseline.means.slice(), vols: baseline.vols.slice(),
      frontier: efficientFrontier(baseline.means, baseline.vols, rho, rf),
      optimum: optimize(baseline.means, baseline.vols, rho, objective, rf), error: null}));
    return {sourceAsOf: prepared.sourceAsOf, basis, mode, objective, rf, customRhos: customRhos.slice(),
      training: {startDate: baseline.startDate, endDate: baseline.endDate, requestedStart, requestedEnd}, baseline, scenarios,
      performance: performance(prepared, {end, performanceEnd, evaluation}, scenarios, monthlyRows)};
  }
  return {calculate, prepareLevels, periodLevels, resampleReturns, statistics, portfolioPoint, optimize, efficientFrontier};
}));
