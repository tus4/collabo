/* COLLABO model extensions. Rates, returns, volatilities and costs are fractions.
 * FX A simulates the existing monthly-estimated lognormal model; no forecast
 * advantage, parameter uncertainty, or calibrated regime model is implied.
 * Hedge returns use fixed initial notional and a deterministic forward premium.
 */
(function (root, factory) {
  'use strict';
  var fx = typeof module === 'object' && module.exports ? require('./fx.js') : root.CollaboFX;
  var api = factory(fx);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CollaboModels = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (FX) {
  'use strict';
  var Z68 = 0.994457883209753, Z95 = 1.959963984540054;
  function finite(x) { return typeof x === 'number' && Number.isFinite(x); }
  function number(x, name, min, max) {
    if (!finite(x) || x < min || x > max) throw new Error(name + ': 유효한 범위의 숫자가 필요합니다.');
    return x;
  }
  function integer(x, name, min, max) {
    number(x, name, min, max);
    if (!Number.isInteger(x)) throw new Error(name + ': 정수가 필요합니다.');
    return x;
  }
  function clamp(x) { return Math.max(0, Math.min(1, x)); }
  function provided(x, fallback) { return x === undefined ? fallback : x; }

  // S is KRW per unit of foreign currency. Rates are annual simple rates for
  // the SAME maturity: F/S=(1+r_KRW*T)/(1+r_foreign*T). Annual premium is simple
  // (F/S-1)/T, positive for the KRW investor selling foreign currency forward.
  function cip(input) {
    if (!input || typeof input !== 'object') throw new Error('CIP 입력이 필요합니다.');
    var months = integer(provided(input.months, 12), '만기 개월', 1, 120), t = months / 12;
    var domestic = number(input.domesticRate, '원화 금리', -.99, 1);
    var foreign = number(input.foreignRate, '외화 금리', -.99, 1);
    if (1 + domestic * t <= 0 || 1 + foreign * t <= 0) throw new Error('동일 만기의 금리 누적계수는 양수여야 합니다.');
    var ratio = (1 + domestic * t) / (1 + foreign * t);
    var result = { months: months, theoreticalForwardRatio: ratio, annualPremium: (ratio - 1) / t,
      forward: null, gap: null, premiumConvention: 'annual-simple-receipt-positive', basisIncluded: false };
    if (input.spot !== undefined) result.forward = number(input.spot, '현물환율', Number.MIN_VALUE, 1e12) * ratio;
    if (input.observedPremium !== undefined && input.observedPremium !== null) {
      if (input.observedPremiumConfirmed !== true) throw new Error('관측 프리미엄의 연 단순수익률 단위 확인이 필요합니다.');
      result.gap = number(input.observedPremium, '관측 연간 프리미엄', -100, 100) - result.annualPremium;
    }
    return result;
  }

  // Annual local/FX simple expected returns are converted by (1+mu)^T-1.
  // Annual premium/cost is prorated by T; no second CIP/basis adjustment.
  // E[(1+R)(1+X)-1+h(p-X)] includes Cov(R,X). The reported normal bands use
  // first-order variance; product risk, changing premium and parameter error
  // are excluded. These are conditional approximations, not loss guarantees.
  function hedge(input, options) {
    options = options || {};
    if (!input || input.confirmed !== true) throw new Error('연간 프리미엄 가정의 단위 확인이 필요합니다.');
    FX.scenario(input); // Reuse the existing complete input validation.
    var model = provided(options.model, 'A');
    if (['A', 'B', 'C'].indexOf(model) < 0) throw new Error('알 수 없는 환헤지 모형입니다.');
    var cost = number(provided(options.cost, 0), '연간 헤지 비용', 0, 1);
    // Risk aversion belongs only to B. An incomplete B control must not hide
    // independent manual/CIP or minimum-variance results in A and C.
    var gamma = model === 'B' ? number(provided(options.riskAversion, 3), '위험회피계수', .01, 1000) : null;
    var cov = input.correlation * input.assetVol * input.fxVol;
    var vfx = input.fxVol * input.fxVol, net = input.premium - cost, h = input.hedgeRatio;
    // d E[R_KRW]/dh = netPremium - E[X].
    // d Var/dh = -2 * (Cov(R,X) + (1-h) Var(X)).
    // B: max mean - gamma/2*variance; C: min variance, both h in [0,1].
    if (model === 'B') h = vfx > 0 ? clamp(1 + cov / vfx + (net - input.fxReturn) / (gamma * vfx)) : (net > input.fxReturn ? 1 : 0);
    if (model === 'C') h = vfx > 0 ? clamp(1 + cov / vfx) : 0;
    var rows = [3, 6, 9, 12].map(function (months) {
      var t = months / 12, r = Math.pow(1 + input.localReturn, t) - 1, x = Math.pow(1 + input.fxReturn, t) - 1;
      var p = net * t, scenarioReturn = (1 + r) * (1 + x) - 1 + h * (p - x);
      var mean = scenarioReturn + cov * t;
      var variance = Math.max(0, (input.assetVol * input.assetVol + (1 - h) * (1 - h) * vfx + 2 * (1 - h) * cov) * t);
      var vol = Math.sqrt(variance), lower95 = mean - Z95 * vol;
      return { horizon: months, months: months, hedgeRatio: h, localReturn: r, fxReturn: x,
        premium: p, grossPremium: input.premium * t, cost: cost * t, hedgePnl: h * (p - x),
        covariance: cov * t, scenarioReturn: scenarioReturn, mean: mean, expectedReturn: mean,
        approxVol: vol, variance: variance, lower68: mean - Z68 * vol, upper68: mean + Z68 * vol,
        lower95: lower95, upper95: mean + Z95 * vol, var975: Math.max(0, -lower95) };
    });
    return { model: model, ratio: h, hedgeRatio: h, cost: cost, riskAversion: gamma, netPremium: net,
      annual: rows[3], rows: rows, currency: input.currency || null,
      returnConvention: 'fixed-initial-notional-with-covariance', riskApproximation: 'first-order-normal',
      horizonConvention: 'annual-simple-returns-compounded;annual-premium-and-cost-prorated',
      parameterUncertaintyIncluded: false };
  }

  function seededUniform(seed) {
    var state = seed >>> 0;
    return function () {
      state = (state + 0x6D2B79F5) >>> 0;
      var t = state;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      // Strictly inside (0,1), including at the uint32 endpoints.
      return ((t ^ t >>> 14) >>> 0) / 4294967296 + 0.5 / 4294967296;
    };
  }
  function normalGenerator(seed) {
    var uniform = seededUniform(seed), spare = null;
    return function () {
      if (spare !== null) { var result = spare; spare = null; return result; }
      var radius = Math.sqrt(-2 * Math.log(uniform())), angle = 2 * Math.PI * uniform();
      spare = radius * Math.sin(angle);
      return radius * Math.cos(angle);
    };
  }
  function quantile(sorted, probability) {
    var index = (sorted.length - 1) * probability, lo = Math.floor(index), hi = Math.ceil(index);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
  }
  function summarize(values, spot) {
    var sorted = Array.from(values).sort(function (a, b) { return a - b; });
    var sum = 0;
    sorted.forEach(function (value) {
      if (!finite(value) || value <= 0) throw new Error('모의 환율이 유효한 범위를 초과했습니다.');
      sum += value;
    });
    var lower95 = quantile(sorted, 0.025);
    return { mean: sum / sorted.length, median: quantile(sorted, 0.5),
      lower68: quantile(sorted, 0.16), upper68: quantile(sorted, 0.84),
      lower95: lower95, upper95: quantile(sorted, 0.975),
      var975: Math.max(0, 1 - lower95 / spot), var975KRW: Math.max(0, spot - lower95) };
  }
  // The estimator remains FX.forecast. This simulator does not refit and does
  // not use future observations. Daily log drift=annual log drift/252 (not the
  // GBM price drift); the Jensen term belongs to the mean of simulated levels.
  function simulateForecast(forecast, options) {
    options = options || {};
    if (!forecast || !Array.isArray(forecast.rows)) throw new Error('추정된 환율 모형이 필요합니다.');
    var spot = number(forecast.spot, '현물환율', Number.MIN_VALUE, 1e12);
    var drift = number(forecast.annualDrift, '연간 로그 변화율', -10, 10);
    var vol = number(forecast.annualVol, '연율 변동성', 0, 10);
    var months = integer(forecast.months, '전망 개월', 1, 12);
    var count = integer(provided(options.paths, 20000), '모의 경로 수', 100, 100000);
    var seed = integer(provided(options.seed, 20261102), '난수 시드', 0, 4294967295);
    var pathCount = integer(provided(options.samplePathCount, 12), '표본 경로 수', 0, 50);
    if (forecast.rows.length !== months + 1) throw new Error('전망 월별 행이 일치하지 않습니다.');
    var data = Array.from({ length: months + 1 }, function () { return new Float64Array(count); });
    var samples = [], normal = normalGenerator(seed), dailyMean = drift / 252, dailyVol = vol / Math.sqrt(252);
    for (var path = 0; path < count; path++) {
      var logLevel = Math.log(spot), sample = [{ horizon: 0, date: forecast.rows[0].date, value: spot }];
      data[0][path] = spot;
      for (var step = 1; step <= months * 21; step++) {
        logLevel += dailyMean + dailyVol * normal();
        if (step % 21 === 0) {
          var h = step / 21, value = Math.exp(logLevel);
          data[h][path] = value;
          if (path < pathCount) sample.push({ horizon: h, date: forecast.rows[h].date, value: value });
        }
      }
      if (path < pathCount) samples.push(sample);
    }
    var rows = forecast.rows.map(function (row, index) {
      return Object.assign({ horizon: row.horizon, date: row.date }, summarize(data[index], spot));
    });
    return Object.assign({}, forecast, { rows: rows, quarterly: rows.filter(function (row) { return row.horizon > 0 && row.horizon % 3 === 0; }),
      samplePaths: samples, paths: count, steps: months * 21, stepsPerYear: 252, seed: seed,
      model: 'A', simulation: 'iid-normal-log-returns', analyticRows: forecast.rows,
      parameterUncertaintyIncluded: false, varConvention: 'long-USD-unhedged-KRW-loss-one-sided-97.5-percent' });
  }
  function monteCarlo(history, options) {
    options = options || {};
    return simulateForecast(FX.forecast(history, options), options);
  }
  return { cip: cip, hedge: hedge, monteCarlo: monteCarlo, simulateForecast: simulateForecast };
}));
