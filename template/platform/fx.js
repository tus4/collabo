/* FX and fixed-initial-notional hedge analytics. All return/risk inputs are fractions. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CollaboFX = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var Z68 = 0.994457883209753, Z95 = 1.959963984540054;
  var MIN_RETURNS = 24;

  function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
  function isoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    var d = new Date(value + 'T00:00:00.000Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? d : null;
  }
  function monthIndex(date) { return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1; }
  function integer(value, name, min, max) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(name + ': ' + min + '–' + max + ' 범위의 정수가 필요합니다.');
    }
    return value;
  }
  function number(value, name, min, max) {
    if (!finite(value) || value < min || value > max) throw new Error(name + ': 유효한 범위의 숫자가 필요합니다.');
    return value;
  }
  function normalized(history, positive) {
    if (!Array.isArray(history)) throw new Error('시계열은 {date,value} 배열이어야 합니다.');
    var unique = new Map();
    history.forEach(function (p) {
      if (p && isoDate(p.date) && finite(p.value) && (!positive || p.value > 0)) {
        unique.set(p.date, { date: p.date, value: p.value });
      }
    });
    return Array.from(unique.values()).sort(function (a, b) { return a.date.localeCompare(b.date); });
  }
  function points(dates, payload) {
    if (!Array.isArray(dates) || !payload || !Array.isArray(payload.values)) {
      throw new Error('날짜 배열과 {start,values} 시계열이 필요합니다.');
    }
    var start = payload.start === undefined ? 0 : payload.start;
    integer(start, 'start', 0, Number.MAX_SAFE_INTEGER);
    return normalized(payload.values.map(function (value, i) {
      return { date: dates[start + i], value: value };
    }), false);
  }
  function monthly(history) {
    var sampled = new Map();
    normalized(history, true).forEach(function (p) { sampled.set(p.date.slice(0, 7), p); });
    return Array.from(sampled.values());
  }
  function lastWeekday(date) {
    var d = isoDate(date);
    var e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    if (e.getUTCDay() === 6) e.setUTCDate(e.getUTCDate() - 1);
    if (e.getUTCDay() === 0) e.setUTCDate(e.getUTCDate() - 2);
    return e.toISOString().slice(0, 10);
  }
  function completed(history) {
    var ms = monthly(history);
    var excluded = ms.length > 0 && ms[ms.length - 1].date < lastWeekday(ms[ms.length - 1].date);
    return { samples: excluded ? ms.slice(0, -1) : ms, all: ms, partialLatestMonthExcluded: excluded };
  }
  function returnsOf(ms) {
    var returns = [], gaps = 0;
    for (var i = 1; i < ms.length; i++) {
      if (monthIndex(ms[i].date) - monthIndex(ms[i - 1].date) === 1) {
        returns.push({ date: ms[i].date, fromDate: ms[i - 1].date, value: Math.log(ms[i].value / ms[i - 1].value) });
      } else { gaps++; }
    }
    return { returns: returns, gaps: gaps };
  }
  function moments(returns) {
    // Welford's update avoids cancellation when monthly returns are nearly constant.
    var n = 0, mean = 0, m2 = 0;
    returns.forEach(function (r) {
      n++;
      var d = r.value - mean;
      mean += d / n;
      m2 += d * (r.value - mean);
    });
    return { count: n, monthlyMean: mean, monthlyVariance: n > 1 ? Math.max(0, m2 / (n - 1)) : 0 };
  }
  function addMonthsClamped(date, months) {
    var d = isoDate(date), target = d.getUTCMonth() + months;
    var end = new Date(Date.UTC(d.getUTCFullYear(), target + 1, 0)).getUTCDate();
    return new Date(Date.UTC(d.getUTCFullYear(), target, Math.min(d.getUTCDate(), end))).toISOString().slice(0, 10);
  }
  function distribution(spot, drift, annualVariance, months) {
    var mu = drift * months / 12, variance = annualVariance * months / 12;
    var sd = Math.sqrt(variance);
    var result = {
      median: spot * Math.exp(mu), mean: spot * Math.exp(mu + variance / 2),
      lower68: spot * Math.exp(mu - Z68 * sd), upper68: spot * Math.exp(mu + Z68 * sd),
      lower95: spot * Math.exp(mu - Z95 * sd), upper95: spot * Math.exp(mu + Z95 * sd)
    };
    if (!Object.keys(result).every(function (key) { return finite(result[key]) && result[key] > 0; })) {
      throw new Error('입력값이 수치적으로 안정적인 전망 범위를 초과했습니다.');
    }
    return result;
  }
  function forecast(history, options) {
    options = options || {};
    var horizon = integer(options.months === undefined ? 12 : options.months, '전망 개월', 1, 120);
    var lookback = integer(options.lookback === undefined ? 120 : options.lookback, '추정 개월', MIN_RETURNS, 1200);
    var method = options.method === undefined ? 'random-walk' : options.method;
    if (['random-walk', 'historical', 'scenario'].indexOf(method) < 0) throw new Error('알 수 없는 전망 방식입니다.');
    var cleanHistory = normalized(history, true);
    var sampled = completed(cleanHistory), ms = sampled.samples;
    if (!sampled.all.length) throw new Error('유효한 양수 환율 관측값이 없습니다.');
    var anchor = sampled.all[sampled.all.length - 1];
    var trailingUnchanged = 1;
    for (var t = cleanHistory.length - 2; t >= 0 && cleanHistory[t].value === anchor.value; t--) trailingUnchanged++;
    var firstMonth = ms.length ? monthIndex(ms[ms.length - 1].date) - lookback : 0;
    var estimationSample = ms.filter(function (p) { return monthIndex(p.date) >= firstMonth; });
    var r = returnsOf(estimationSample), stats = moments(r.returns);
    if (stats.count < MIN_RETURNS) throw new Error('완결 월의 연속 월간 수익률이 최소 24개 필요합니다. 현재 ' + stats.count + '개입니다.');
    var drift = method === 'historical' ? stats.monthlyMean * 12 : 0;
    if (method === 'scenario') drift = number(options.annualDrift === undefined ? 0 : options.annualDrift, '연간 로그 변화율', -10, 10);
    var variance = stats.monthlyVariance * 12, rows = [];
    for (var h = 0; h <= horizon; h++) {
      rows.push(Object.assign({ date: addMonthsClamped(anchor.date, h), horizon: h }, distribution(anchor.value, drift, variance, h)));
    }
    var warnings = [
      '월간 로그수익률의 독립·정규분포와 일정 변동성을 가정합니다. 예측구간은 모수 추정오차와 구조 변화를 포함하지 않습니다.',
      '전망 날짜는 최신 관측일의 h개월 후이며 짧은 달은 말일로 보정합니다. 월말 전망과 다를 수 있습니다.'
    ];
    if (method === 'historical') warnings.push('과거 평균 로그 변화율의 지속을 가정합니다. 표본 외 예측 우월성은 보장되지 않습니다.');
    if (method === 'scenario') warnings.push('중앙 경로는 사용자가 입력한 연간 로그 변화율 시나리오입니다.');
    if (sampled.partialLatestMonthExcluded) warnings.push('최신 관측월이 마지막 평일 이전에 종료되어 그 월은 추정에서 제외했습니다. 휴장일은 별도로 식별하지 않습니다.');
    if (r.gaps) warnings.push('월 자료가 누락된 구간 ' + r.gaps + '개는 월간 수익률 추정에서 제외했습니다.');
    if (trailingUnchanged >= 5) warnings.push('최근 ' + trailingUnchanged + '개 유효 관측값이 동일합니다. 원자료 갱신·보간 여부를 확인해야 하며 관측값은 임의로 삭제하지 않았습니다.');
    return {
      asof: anchor.date, spot: anchor.value, method: method, months: horizon,
      annualVol: Math.sqrt(variance), annualDrift: drift, observations: stats.count,
      rows: rows, history: sampled.all, warnings: warnings,
      quality: {
        trailingUnchangedObservations: trailingUnchanged,
        unchangedSince: cleanHistory[cleanHistory.length - trailingUnchanged].date,
        sourceVintageVerified: false
      },
      estimation: {
        startDate: r.returns[0].fromDate, endDate: r.returns[r.returns.length - 1].date,
        lookbackMonths: lookback, monthlyReturns: stats.count, skippedGaps: r.gaps,
        partialLatestMonthExcluded: sampled.partialLatestMonthExcluded,
        monthlyMean: stats.monthlyMean, monthlyVariance: stats.monthlyVariance,
        sampling: 'monthly-last-observed-consecutive', varianceDivisor: stats.count - 1,
        parameterUncertaintyIncluded: false, horizonConvention: 'anchor-plus-calendar-months-clamped'
      }
    };
  }
  function evaluate(history, options) {
    options = options || {};
    var testMonths = integer(options.testMonths === undefined ? 24 : options.testMonths, '검증 개월', 1, 120);
    var minTrain = integer(options.minTrainMonths === undefined ? MIN_RETURNS : options.minTrainMonths, '최소 학습 개월', MIN_RETURNS, 1200);
    var lookback = options.lookback === undefined || options.lookback === null ? null : integer(options.lookback, '추정 개월', minTrain, 1200);
    var sampled = completed(history), ms = sampled.samples, candidates = [];
    // Each forecast is fitted only to observations strictly before its target month.
    for (var i = 1; i < ms.length; i++) {
      if (monthIndex(ms[i].date) - monthIndex(ms[i - 1].date) !== 1) continue;
      var trainingSample = ms.slice(0, i);
      if (lookback !== null) {
        var firstMonth = monthIndex(ms[i - 1].date) - lookback;
        trainingSample = trainingSample.filter(function (p) { return monthIndex(p.date) >= firstMonth; });
      }
      var training = returnsOf(trainingSample), stats = moments(training.returns);
      if (stats.count < minTrain) continue;
      candidates.push({
        date: ms[i].date, asof: ms[i - 1].date, actual: ms[i].value, trainingReturns: stats.count,
        randomWalk: distribution(ms[i - 1].value, 0, stats.monthlyVariance * 12, 1),
        historical: distribution(ms[i - 1].value, stats.monthlyMean * 12, stats.monthlyVariance * 12, 1)
      });
    }
    var rows = candidates.slice(-testMonths);
    function metric(key) {
      if (!rows.length) return { rmse: null, mae: null, coverage68: null, coverage95: null, count: 0 };
      var se = 0, ae = 0, c68 = 0, c95 = 0;
      rows.forEach(function (r) {
        var p = r[key], error = p.median - r.actual;
        se += error * error; ae += Math.abs(error);
        c68 += Number(r.actual >= p.lower68 && r.actual <= p.upper68);
        c95 += Number(r.actual >= p.lower95 && r.actual <= p.upper95);
      });
      return { rmse: Math.sqrt(se / rows.length), mae: ae / rows.length, coverage68: c68 / rows.length, coverage95: c95 / rows.length, count: rows.length };
    }
    var warnings = [
      (lookback === null ? '월별 확장표본' : '직전 ' + lookback + '개월 이동표본') + '으로 재추정한 1개월 앞 예측입니다. RMSE는 환율 수준의 중앙값 오차이며 구간 적중률은 0–1 비율입니다.',
      '재추정은 해당 예측 시점 이전의 공개 시계열만 사용합니다. 당시 이용 가능했던 원자료 빈티지와 전처리의 시점 일관성은 검증하지 않았습니다.'
    ];
    if (!rows.length) warnings.push('최소 학습기간 이후의 완결 월 자료가 부족하여 표본 외 검증 결과가 없습니다.');
    else if (rows.length < testMonths) warnings.push('요청한 ' + testMonths + '개 중 ' + rows.length + '개 월만 검증할 수 있습니다.');
    if (sampled.partialLatestMonthExcluded) warnings.push('최신 부분월은 검증 대상에서 제외했습니다.');
    return {
      rows: rows, observations: rows.length, randomWalk: metric('randomWalk'), historical: metric('historical'),
      startDate: rows.length ? rows[0].date : null, endDate: rows.length ? rows[rows.length - 1].date : null,
      minTrainMonths: minTrain, requestedTestMonths: testMonths, lookbackMonths: lookback,
      horizonMonths: 1, fitting: lookback === null ? 'expanding' : 'rolling', lossTarget: 'level-median', warnings: warnings
    };
  }
  function scenario(input) {
    if (!input || typeof input !== 'object') throw new Error('환헤지 시나리오 입력이 필요합니다.');
    var local = number(input.localReturn, '현지통화 수익률', -1, 100);
    var fx = number(input.fxReturn, '환율 변화율', -1 + Number.EPSILON, 100);
    var premium = number(input.premium, '수취 헤지 프리미엄', -1 + Number.EPSILON, 100);
    var h = number(input.hedgeRatio, '헤지비율', 0, 1);
    var av = number(input.assetVol, '자산 변동성', 0, 100);
    var fv = number(input.fxVol, '환율 변동성', 0, 100);
    var rho = number(input.correlation, '상관계수', -1, 1);
    var exposure = 1 - h;
    var unhedged = (1 + local) * (1 + fx) - 1;
    var pnl = h * (premium - fx);
    var variance = av * av + exposure * exposure * fv * fv + 2 * exposure * rho * av * fv;
    // The variance is non-negative for |rho|<=1; clamp only floating point cancellation.
    variance = Math.max(0, variance);
    return {
      unhedgedReturn: unhedged, hedgePnl: pnl, krwReturn: unhedged + pnl,
      approxVol: Math.sqrt(variance), variance: variance, fxExposure: exposure,
      returnConvention: 'fixed-initial-notional', riskApproximation: 'first-order',
      warnings: [
        '수익률은 기초 원금 고정 헤지의 1년 만기 시나리오입니다. 100% 헤지에도 현지자산 수익과 환율 변화의 교차항이 남습니다.',
        '위험은 1차 근사입니다. 자산·환율 수익의 곱, 헤지 프리미엄 변동, 거래비용 및 담보 비용은 반영하지 않습니다.',
        '프리미엄은 수취를 양수로 입력한 동일 1년 기간의 가정값입니다. 원자료의 연율화 여부는 별도로 확인해야 합니다.'
      ]
    };
  }
  return { points: points, monthly: monthly, forecast: forecast, evaluate: evaluate, scenario: scenario };
}));
