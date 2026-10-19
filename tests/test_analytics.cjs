'use strict';
const assert = require('node:assert/strict');
const A = require('../template/platform/analytics.js');
function near(actual, expected, tol = 1e-8, label = '') {
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} != ${expected}`);
}
function asset(mu, vol, min = 0, max = 1) { return { mu, vol, min, max }; }
function verify(point, assets) {
  near(point.weights.reduce((a, b) => a + b, 0), 1, 1e-8, 'weight sum');
  point.weights.forEach((w, i) => assert.ok(w >= assets[i].min - 1e-8 && w <= assets[i].max + 1e-8));
  near(point.contributions.reduce((a, b) => a + b, 0), point.vol, 1e-8, 'risk contributions');
}

// Independent two-asset minimum-variance closed form.
const two = [asset(0.04, 0.1), asset(0.08, 0.2)];
const corr = [[1, 0.25], [0.25, 1]];
const cov12 = 0.25 * 0.1 * 0.2;
const weight1 = (0.2 ** 2 - cov12) / (0.1 ** 2 + 0.2 ** 2 - 2 * cov12);
const result = A.optimize(two, corr, { rf: 0.02, points: 35 });
near(result.minVol.weights[0], weight1, 1e-9, 'two-asset closed form');
result.frontier.forEach(point => verify(point, two));
verify(result.maxSharpe, two);
for (let i = 1; i < result.frontier.length; i++) {
  assert.ok(result.frontier[i].return >= result.frontier[i - 1].return - 1e-10);
  assert.ok(result.frontier[i].vol >= result.frontier[i - 1].vol - 1e-10);
}
// Independent tangency weights: Sigma^-1 (mu-rf), normalized.
const x1 = (0.04 * 0.02 - cov12 * 0.06);
const x2 = (-cov12 * 0.02 + 0.01 * 0.06);
near(result.maxSharpe.weights[0], x1 / (x1 + x2), 1e-8, 'tangency portfolio');
assert.equal(A.selectTarget(result, 0.08), result.frontier.at(-1));

const bounded = [asset(0.04, 0.1, 0.2, 0.6), asset(0.08, 0.2, 0.1, 0.8)];
const boundedResult = A.optimize(bounded, corr, { rf: 0.02 });
near(boundedResult.minVol.weights[0], 0.6);
[boundedResult.minVol, boundedResult.maxSharpe, ...boundedResult.frontier].forEach(p => verify(p, bounded));
near(boundedResult.frontier.at(-1).weights[0], 0.2);

assert.throws(() => A.validateModel(two, [[1, 0.3], [0.2, 1]]), /대칭/);
assert.throws(() => A.validateModel([asset(0.1, 0.1), asset(0.2, 0.2), asset(0.3, 0.3)], [[1, 0.9, 0.9], [0.9, 1, -0.9], [0.9, -0.9, 1]]), /준정부호/);
assert.throws(() => A.validateModel([asset(0.1, 0.1, 0.6), asset(0.2, 0.2, 0.6)], corr), /100%/);
assert.throws(() => A.validateModel([asset(0.1, 0.1, 0, 0.4), asset(0.2, 0.2, 0, 0.4)], corr), /100%/);
assert.throws(() => A.portfolio([0.3, 0.3], two, corr), /合計|합계/);
assert.throws(() => A.portfolio([-0.1, 1.1], two, corr), /0~100%/);

const single = A.optimize([asset(0.05, 0.12)], [[1]], { rf: 0.02 });
near(single.minVol.weights[0], 1);
near(single.maxSharpe.sharpe, 0.25);
assert.equal(single.frontier.length, 1);

// Singular perfect-correlation and perfect-hedge matrices remain valid.
const sameRisk = A.optimize([asset(0.04, 0.1), asset(0.08, 0.1)], [[1, 1], [1, 1]], { rf: 0.02 });
near(sameRisk.minVol.vol, 0.1);
near(sameRisk.maxSharpe.return, 0.08);
const hedge = A.optimize(two, [[1, -1], [-1, 1]], { rf: 0.02 });
near(hedge.minVol.weights[0], 2 / 3, 1e-8);
near(hedge.minVol.vol, 0, 1e-8);
assert.equal(hedge.maxSharpe.sharpe, Infinity);
const sameMean = A.optimize([asset(0.05, 0.1), asset(0.05, 0.2)], [[1, 0], [0, 1]], { rf: 0.02 });
near(sameMean.minVol.weights[0], 0.8);
assert.equal(sameMean.frontier.length, 1);
const fixed = A.optimize([asset(0.04, 0.1, 0.3, 0.3), asset(0.08, 0.2, 0.7, 0.7)], corr);
near(fixed.minVol.weights[0], 0.3);

// Zero-risk assets and negative excess returns do not assume positive Sharpe.
const zeroRisk = A.optimize([asset(0.04, 0), asset(0.08, 0.2)], [[1, 0], [0, 1]], { rf: 0.02 });
assert.equal(zeroRisk.maxSharpe.sharpe, Infinity);
assert.equal(zeroRisk.maxSharpe.sharpeDefined, false);
const negative = A.optimize(two, corr, { rf: 0.2 });
const endpointBest = Math.max((0.04 - 0.2) / 0.1, (0.08 - 0.2) / 0.2);
near(negative.maxSharpe.sharpe, endpointBest);

// A dense independent grid checks constrained three-asset numerical optima.
const three = [asset(0.03, 0.07, 0.1, 0.6), asset(0.07, 0.16, 0.2, 0.7), asset(0.1, 0.24, 0.05, 0.5)];
const corr3 = [[1, 0.2, -0.1], [0.2, 1, 0.3], [-0.1, 0.3, 1]];
const solved = A.optimize(three, corr3, { rf: 0.015, points: 21 });
let gridVol = Infinity, gridSharpe = -Infinity;
for (let i = 100; i <= 600; i++) for (let j = 200; j <= 700; j++) {
  const k = 1000 - i - j;
  if (k < 50 || k > 500) continue;
  const w = [i / 1000, j / 1000, k / 1000];
  const ret = w.reduce((s, x, n) => s + x * three[n].mu, 0);
  let variance = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) variance += w[a] * w[b] * three[a].vol * three[b].vol * corr3[a][b];
  const vol = Math.sqrt(variance);
  gridVol = Math.min(gridVol, vol);
  gridSharpe = Math.max(gridSharpe, (ret - 0.015) / vol);
}
assert.ok(solved.minVol.vol <= gridVol + 1e-10);
assert.ok(gridVol - solved.minVol.vol < 2e-5);
assert.ok(solved.maxSharpe.sharpe >= gridSharpe - 1e-10);
assert.ok(solved.maxSharpe.sharpe - gridSharpe < 2e-5);
[solved.minVol, solved.maxSharpe, ...solved.frontier].forEach(p => verify(p, three));
assert.equal(solved.meta.covarianceRegularization, 0);
console.log('Allocation analytics: all closed-form, constraint, PSD, singular and grid checks passed.');
