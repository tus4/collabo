/* Collabo allocation mathematics. Inputs and outputs use annual decimal units. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CollaboAnalytics = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var EPS = 1e-10;
  var FEAS = 2e-8;

  function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
  function dot(a, b) { return a.reduce(function (sum, value, i) { return sum + value * b[i]; }, 0); }
  function multiply(matrix, vector) { return matrix.map(function (row) { return dot(row, vector); }); }
  function bounds(asset) { return [asset.min === undefined ? 0 : asset.min, asset.max === undefined ? 1 : asset.max]; }
  function fail(message) { throw new Error(message); }

  // Jacobi rotations check the correlation matrix itself, including zero-vol assets.
  function eigenvalues(matrix) {
    var a = matrix.map(function (row) { return row.slice(); });
    var n = a.length;
    for (var iteration = 0; iteration < 100 * n * n; iteration++) {
      var p = 0, q = 0, largest = 0;
      for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
        if (Math.abs(a[i][j]) > largest) { largest = Math.abs(a[i][j]); p = i; q = j; }
      }
      if (largest < 1e-13) break;
      var angle = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
      var c = Math.cos(angle), s = Math.sin(angle);
      var pp = a[p][p], qq = a[q][q], pq = a[p][q];
      for (var k = 0; k < n; k++) if (k !== p && k !== q) {
        var kp = a[k][p], kq = a[k][q];
        a[k][p] = a[p][k] = c * kp - s * kq;
        a[k][q] = a[q][k] = s * kp + c * kq;
      }
      a[p][p] = c * c * pp - 2 * s * c * pq + s * s * qq;
      a[q][q] = s * s * pp + 2 * s * c * pq + c * c * qq;
      a[p][q] = a[q][p] = 0;
    }
    return a.map(function (row, i) { return row[i]; });
  }

  function validateModel(assets, corr) {
    if (!Array.isArray(assets) || !assets.length) fail('자산을 한 개 이상 입력해 주세요.');
    var minimum = 0, maximum = 0;
    assets.forEach(function (asset, i) {
      var name = asset && (asset.name || asset.id) || ('자산 ' + (i + 1));
      if (!asset || !finite(asset.mu)) fail(name + ': 기대수익률은 유한한 숫자여야 합니다.');
      if (!finite(asset.vol) || asset.vol < 0) fail(name + ': 변동성은 0 이상의 숫자여야 합니다.');
      var b = bounds(asset);
      if (!finite(b[0]) || !finite(b[1]) || b[0] < 0 || b[1] > 1 || b[0] > b[1]) {
        fail(name + ': 비중 한도는 0 ≤ 최소 ≤ 최대 ≤ 100%여야 합니다.');
      }
      ['current', 'saa'].forEach(function (key) {
        if (asset[key] !== undefined && (!finite(asset[key]) || asset[key] < 0 || asset[key] > 1)) {
          fail(name + ': ' + (key === 'current' ? '현재' : 'SAA') + ' 비중은 0~100%여야 합니다.');
        }
      });
      minimum += b[0]; maximum += b[1];
    });
    if (minimum > 1 + EPS || maximum < 1 - EPS) fail('비중 한도로 합계 100%를 만들 수 없습니다. 최소·최대 비중을 확인해 주세요.');
    var n = assets.length;
    if (!Array.isArray(corr) || corr.length !== n || corr.some(function (row) { return !Array.isArray(row) || row.length !== n; })) {
      fail('상관행렬 크기는 자산 수와 같아야 합니다.');
    }
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      var value = corr[i][j];
      if (!finite(value) || value < -1 - EPS || value > 1 + EPS) fail('상관계수는 -1~1의 유한한 숫자여야 합니다.');
      if (i === j && Math.abs(value - 1) > EPS) fail('상관행렬의 대각선은 1이어야 합니다.');
      if (Math.abs(value - corr[j][i]) > EPS) fail('상관행렬은 대칭이어야 합니다.');
    }
    if (Math.min.apply(null, eigenvalues(corr)) < -EPS) fail('상관행렬이 양의 준정부호가 아닙니다. 입력 상관계수의 조합을 확인해 주세요.');
    return true;
  }

  function covariance(assets, corr) {
    return corr.map(function (row, i) { return row.map(function (r, j) { return r * assets[i].vol * assets[j].vol; }); });
  }

  function summarize(weights, assets, cov, rf) {
    var expected = dot(weights, assets.map(function (a) { return a.mu; }));
    var marginal = multiply(cov, weights);
    var variance = Math.max(0, dot(weights, marginal));
    var vol = Math.sqrt(variance);
    var excess = expected - rf;
    // Sharpe is financially undefined at zero volatility. Extended-real values
    // below are solely an optimization ordering convention; the UI must show —.
    var sharpe = vol > 1e-14 ? excess / vol : (excess > 1e-14 ? Infinity : (excess < -1e-14 ? -Infinity : 0));
    return {
      weights: weights.slice(),
      return: expected,
      vol: vol,
      sharpe: sharpe,
      sharpeDefined: vol > 1e-14,
      contributions: weights.map(function (w, i) { return vol > 1e-14 ? w * marginal[i] / vol : 0; }),
      returnContributions: weights.map(function (w, i) { return w * assets[i].mu; })
    };
  }

  function portfolio(weights, assets, corr, rf) {
    validateModel(assets, corr);
    rf = rf === undefined ? 0 : rf;
    if (!finite(rf)) fail('무위험수익률은 유한한 숫자여야 합니다.');
    if (!Array.isArray(weights) || weights.length !== assets.length || weights.some(function (w) { return !finite(w) || w < -EPS || w > 1 + EPS; })) {
      fail('포트폴리오 비중은 자산 수에 맞는 0~100% 숫자여야 합니다.');
    }
    if (Math.abs(weights.reduce(function (a, b) { return a + b; }, 0) - 1) > 1e-8) fail('포트폴리오 비중의 합계는 100%여야 합니다.');
    return summarize(weights, assets, covariance(assets, corr), rf);
  }

  // Rank-revealing elimination also handles singular covariance matrices.
  // Free coordinates are set to zero. Enumerating boundary faces supplies a
  // feasible representative when a stationary solution has a null space.
  function solve(matrix, rhs) {
    var n = rhs.length;
    var a = matrix.map(function (row, i) { return row.slice().concat(rhs[i]); });
    var pivots = [], row = 0;
    for (var col = 0; col < n && row < n; col++) {
      var best = row;
      for (var k = row + 1; k < n; k++) if (Math.abs(a[k][col]) > Math.abs(a[best][col])) best = k;
      if (Math.abs(a[best][col]) < 1e-12) continue;
      var swap = a[row]; a[row] = a[best]; a[best] = swap;
      var pivot = a[row][col];
      for (var j = col; j <= n; j++) a[row][j] /= pivot;
      for (var r = 0; r < n; r++) if (r !== row) {
        var factor = a[r][col];
        if (factor === 0) continue;
        for (var c = col; c <= n; c++) a[r][c] -= factor * a[row][c];
      }
      pivots.push(col); row++;
    }
    for (var r2 = row; r2 < n; r2++) if (Math.abs(a[r2][n]) > 2e-9) return null;
    var result = Array(n).fill(0);
    pivots.forEach(function (col, i) { result[col] = a[i][n]; });
    return result.every(finite) ? result : null;
  }

  // Linear extrema on a bounded simplex, with fixed coordinates already removed.
  function extreme(free, budget, lower, upper, means, descending) {
    var allocation = {}, remainder = budget, value = 0;
    free.forEach(function (i) { allocation[i] = lower[i]; remainder -= lower[i]; value += lower[i] * means[i]; });
    free.slice().sort(function (a, b) { return descending ? means[b] - means[a] : means[a] - means[b]; }).forEach(function (i) {
      var added = Math.max(0, Math.min(remainder, upper[i] - lower[i]));
      allocation[i] += added; remainder -= added; value += added * means[i];
    });
    return { value: value, allocation: allocation };
  }

  function compileFaces(assets, cov) {
    var n = assets.length;
    var lower = assets.map(function (a) { return bounds(a)[0]; });
    var upper = assets.map(function (a) { return bounds(a)[1]; });
    var rawMeans = assets.map(function (a) { return a.mu; });
    var offset = Math.min.apply(null, rawMeans);
    var scale = Math.max(Math.max.apply(null, rawMeans) - offset, 1e-8);
    var means = rawMeans.map(function (mu) { return (mu - offset) / scale; });
    var varianceScale = Math.max.apply(null, cov.map(function (row, i) { return row[i]; })) || 1;
    var h = cov.map(function (row) { return row.map(function (v) { return v / varianceScale; }); });
    var faces = [], statuses = Array(n).fill(0);

    function accept(base, slope, anchor, lo, hi) {
      for (var i = 0; i < n; i++) {
        if (Math.abs(slope[i]) < 1e-12) {
          if (base[i] < lower[i] - FEAS || base[i] > upper[i] + FEAS) return;
        } else {
          var a = anchor + (lower[i] - base[i]) / slope[i];
          var b = anchor + (upper[i] - base[i]) / slope[i];
          lo = Math.max(lo, Math.min(a, b)); hi = Math.min(hi, Math.max(a, b));
        }
      }
      if (lo > hi + 1e-9) return;
      if (lo > hi) lo = hi = (lo + hi) / 2;
      var cBase = multiply(cov, base), cSlope = multiply(cov, slope);
      faces.push({ base: base, slope: slope, anchor: anchor, lo: lo, hi: hi,
        a: Math.max(0, dot(slope, cSlope)), b: dot(base, cSlope), c: Math.max(0, dot(base, cBase)) });
    }

    function inspect() {
      var free = [], fixed = [], base = Array(n).fill(0), budget = 1, fixedReturn = 0;
      for (var i = 0; i < n; i++) {
        if (statuses[i] === 0) free.push(i);
        else { fixed.push(i); base[i] = statuses[i] === -1 ? lower[i] : upper[i]; budget -= base[i]; fixedReturn += base[i] * means[i]; }
      }
      var minBudget = free.reduce(function (s, i) { return s + lower[i]; }, 0);
      var maxBudget = free.reduce(function (s, i) { return s + upper[i]; }, 0);
      if (budget < minBudget - EPS || budget > maxBudget + EPS) return;
      if (free.length === 0) {
        if (Math.abs(budget) <= EPS) accept(base, Array(n).fill(0), fixedReturn, fixedReturn, fixedReturn);
        return;
      }
      var lo = fixedReturn + extreme(free, budget, lower, upper, means, false).value;
      var hi = fixedReturn + extreme(free, budget, lower, upper, means, true).value;
      var twoConstraints = hi - lo > 1e-10;
      var count = free.length, constraints = twoConstraints ? 2 : 1;
      var matrix = Array.from({ length: count + constraints }, function () { return Array(count + constraints).fill(0); });
      var rhs = Array(count + constraints).fill(0);
      for (var r = 0; r < count; r++) {
        for (var c = 0; c < count; c++) matrix[r][c] = h[free[r]][free[c]];
        matrix[r][count] = matrix[count][r] = 1;
        if (twoConstraints) matrix[r][count + 1] = matrix[count + 1][r] = means[free[r]];
        rhs[r] = -fixed.reduce(function (sum, i) { return sum + h[free[r]][i] * base[i]; }, 0);
      }
      rhs[count] = budget;
      if (twoConstraints) rhs[count + 1] = lo - fixedReturn;
      var lowSolution = solve(matrix, rhs);
      if (!lowSolution) return;
      var slope = Array(n).fill(0);
      if (twoConstraints) {
        rhs[count + 1] = hi - fixedReturn;
        var highSolution = solve(matrix, rhs);
        if (!highSolution) return;
        free.forEach(function (i, j) { slope[i] = (highSolution[j] - lowSolution[j]) / (hi - lo); });
      }
      free.forEach(function (i, j) { base[i] = lowSolution[j]; });
      accept(base, slope, lo, lo, hi);
    }

    function visit(i) {
      if (i === n) { inspect(); return; }
      if (Math.abs(upper[i] - lower[i]) < EPS) { statuses[i] = -1; visit(i + 1); return; }
      statuses[i] = 0; visit(i + 1);
      statuses[i] = -1; visit(i + 1);
      statuses[i] = 1; visit(i + 1);
    }
    visit(0);
    return { faces: faces, offset: offset, scale: scale, lower: lower, upper: upper };
  }

  function optimize(assets, corr, options) {
    validateModel(assets, corr);
    if (assets.length > 10) fail('현재 최적화는 최대 10개 자산을 지원합니다.');
    options = options || {};
    var rf = options.rf === undefined ? 0 : options.rf;
    if (!finite(rf)) fail('무위험수익률은 유한한 숫자여야 합니다.');
    var points = options.points === undefined ? 35 : options.points;
    if (!Number.isInteger(points) || points < 2 || points > 201) fail('효율적 경계선 점의 개수는 2~201 사이의 정수여야 합니다.');
    var cov = covariance(assets, corr);
    var compiled = compileFaces(assets, cov), faces = compiled.faces;
    if (!faces.length) fail('주어진 비중 한도로 최적화 해를 찾지 못했습니다. 입력값을 확인해 주세요.');

    function evaluate(face, x) {
      var t = x - face.anchor;
      var weights = face.base.map(function (w, i) {
        var value = w + face.slope[i] * t;
        return Math.max(compiled.lower[i], Math.min(compiled.upper[i], value));
      });
      var remainder = 1 - weights.reduce(function (a, b) { return a + b; }, 0);
      if (Math.abs(remainder) > FEAS) return null;
      // Remove roundoff only; never renormalize a materially infeasible result.
      for (var i = 0; i < weights.length && Math.abs(remainder) > 1e-15; i++) {
        var change = remainder > 0 ? Math.min(remainder, compiled.upper[i] - weights[i]) : Math.max(remainder, compiled.lower[i] - weights[i]);
        weights[i] += change; remainder -= change;
      }
      return summarize(weights, assets, cov, rf);
    }

    var minVol = null, maxSharpe = null, maxX = -Infinity;
    function consider(point) {
      if (!point) return;
      if (!minVol || point.vol < minVol.vol - 1e-13 || (Math.abs(point.vol - minVol.vol) <= 1e-13 && point.return > minVol.return)) minVol = point;
      if (!maxSharpe || point.sharpe > maxSharpe.sharpe || (point.sharpe === maxSharpe.sharpe && point.vol < maxSharpe.vol)) maxSharpe = point;
    }
    faces.forEach(function (face) {
      maxX = Math.max(maxX, face.hi);
      var candidates = [face.lo, face.hi];
      if (face.a > 1e-24) candidates.push(Math.max(face.lo, Math.min(face.hi, face.anchor - face.b / face.a)));
      // Stationary Sharpe point on this face's affine minimum-variance path.
      var excess = compiled.offset + compiled.scale * face.anchor - rf;
      var denominator = compiled.scale * face.b - excess * face.a;
      if (Math.abs(denominator) > 1e-24) {
        var root = face.anchor + (excess * face.b - compiled.scale * face.c) / denominator;
        if (root >= face.lo - EPS && root <= face.hi + EPS) candidates.push(Math.max(face.lo, Math.min(face.hi, root)));
      }
      candidates.forEach(function (x) { consider(evaluate(face, x)); });
    });
    if (!minVol || !maxSharpe) fail('수치 오차로 유효한 최적화 해를 찾지 못했습니다.');

    function solveAt(x) {
      var best = null;
      faces.forEach(function (face) {
        if (x < face.lo - 1e-9 || x > face.hi + 1e-9) return;
        var candidate = evaluate(face, Math.max(face.lo, Math.min(face.hi, x)));
        if (candidate && (!best || candidate.vol < best.vol)) best = candidate;
      });
      if (!best) fail('효율적 경계선 계산에 실패했습니다. 비중 한도를 확인해 주세요.');
      return best;
    }
    var minX = (minVol.return - compiled.offset) / compiled.scale;
    var frontier = [];
    if (maxX - minX <= 1e-10) frontier.push(minVol);
    else for (var i = 0; i < points; i++) frontier.push(solveAt(minX + (maxX - minX) * i / (points - 1)));
    return {
      minVol: minVol,
      maxSharpe: maxSharpe,
      frontier: frontier,
      meta: {
        solver: 'bounded-simplex active-face quadratic optimization',
        units: 'annual decimal',
        longOnly: true,
        covarianceRegularization: 0,
        zeroVolSharpe: 'undefined; extended-real values used only for optimization ordering',
        feasibilityTolerance: FEAS,
        frontierPoints: frontier.length,
        targetSelection: 'nearest computed frontier return'
      }
    };
  }

  function selectTarget(result, targetReturn) {
    if (!result || !Array.isArray(result.frontier) || !result.frontier.length || !finite(targetReturn)) fail('목표수익률과 효율적 경계선 결과를 확인해 주세요.');
    return result.frontier.reduce(function (best, point) {
      return Math.abs(point.return - targetReturn) < Math.abs(best.return - targetReturn) ? point : best;
    });
  }

  return { validateModel: validateModel, portfolio: portfolio, optimize: optimize, selectTarget: selectTarget };
}));
