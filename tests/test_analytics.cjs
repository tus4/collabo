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
near(A.selectTarget(result, 0.08).return, result.frontier.at(-1).return);

// A target between plotted dots is solved directly, even with only two dots.
const coarse = A.optimize(two, corr, { rf: 0.02, points: 2 });
const exactTarget = 0.06321;
const exact = A.selectTarget(coarse, exactTarget, 'exact');
const exactWeight1 = (two[1].mu - exactTarget) / (two[1].mu - two[0].mu);
near(exact.weights[0], exactWeight1, 1e-10, 'exact return closed-form weight');
near(exact.return, exactTarget, 1e-12);
near(exact.vol ** 2, exactWeight1 ** 2 * two[0].vol ** 2 +
  (1 - exactWeight1) ** 2 * two[1].vol ** 2 + 2 * exactWeight1 * (1 - exactWeight1) * cov12, 1e-12);
verify(exact, two);
near(A.selectTarget(coarse, exactTarget).return, exactTarget, 1e-12);
assert.equal(A.selectTarget(coarse, -0.1), coarse.minVol);
assert.equal(A.selectTarget(coarse, coarse.minVol.return), coarse.minVol);
near(A.selectTarget(coarse, 0.041, 'exact').return, 0.041, 1e-12, 'equality below minimum-vol return');
near(A.selectTarget(coarse, 0.04, 'exact').weights[0], 1, 1e-12);
near(A.selectTarget(coarse, 0.08, 'exact').weights[1], 1, 1e-12);
near(coarse.returnRange.min, 0.04);
near(coarse.returnRange.max, 0.08);
assert.throws(() => A.selectTarget(coarse, 0.081), /달성/);
assert.throws(() => A.selectTarget(coarse, 0.039, 'exact'), /달성/);
assert.throws(() => A.selectTarget(coarse, NaN), /유한/);
assert.throws(() => A.selectTarget(coarse, Infinity), /유한/);
assert.throws(() => A.selectTarget(coarse, '0.06'), /유한/);
assert.throws(() => A.selectTarget(coarse, 0.06, 'invalid'), /조건/);
assert.throws(() => A.selectTarget(JSON.parse(JSON.stringify(coarse)), 0.06), /다시 계산/);

const bounded = [asset(0.04, 0.1, 0.2, 0.6), asset(0.08, 0.2, 0.1, 0.8)];
const boundedResult = A.optimize(bounded, corr, { rf: 0.02 });
near(boundedResult.minVol.weights[0], 0.6);
[boundedResult.minVol, boundedResult.maxSharpe, ...boundedResult.frontier].forEach(p => verify(p, bounded));
near(boundedResult.frontier.at(-1).weights[0], 0.2);
near(boundedResult.returnRange.min, 0.056);
near(boundedResult.returnRange.max, 0.072);
verify(A.selectTarget(boundedResult, 0.06123, 'exact'), bounded);
near(A.selectTarget(boundedResult, 0.06123, 'exact').return, 0.06123, 1e-12);
assert.equal(A.selectTarget(boundedResult, 0.03), boundedResult.minVol);
assert.throws(() => A.selectTarget(boundedResult, 0.055, 'exact'), /달성/);
assert.throws(() => A.selectTarget(boundedResult, 0.073), /달성/);

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
near(A.selectTarget(single, 0.05, 'exact').return, 0.05);
assert.equal(A.selectTarget(single, 0.04), single.minVol);
assert.throws(() => A.selectTarget(single, 0.06), /달성/);

// Singular perfect-correlation and perfect-hedge matrices remain valid.
const sameRisk = A.optimize([asset(0.04, 0.1), asset(0.08, 0.1)], [[1, 1], [1, 1]], { rf: 0.02 });
near(sameRisk.minVol.vol, 0.1);
near(sameRisk.maxSharpe.return, 0.08);
near(A.selectTarget(sameRisk, 0.06, 'exact').return, 0.06, 1e-12);
near(A.selectTarget(sameRisk, 0.06, 'exact').vol, 0.1, 1e-12);
const hedge = A.optimize(two, [[1, -1], [-1, 1]], { rf: 0.02 });
near(hedge.minVol.weights[0], 2 / 3, 1e-8);
near(hedge.minVol.vol, 0, 1e-8);
assert.equal(hedge.maxSharpe.sharpe, Infinity);
near(A.selectTarget(hedge, 0.06, 'exact').vol, 0.05, 1e-10);
near(A.selectTarget(hedge, hedge.minVol.return, 'exact').vol, 0, 1e-8);
const sameMean = A.optimize([asset(0.05, 0.1), asset(0.05, 0.2)], [[1, 0], [0, 1]], { rf: 0.02 });
near(sameMean.minVol.weights[0], 0.8);
assert.equal(sameMean.frontier.length, 1);
near(A.selectTarget(sameMean, 0.05, 'exact').weights[0], 0.8, 1e-10);
assert.equal(A.selectTarget(sameMean, 0.04), sameMean.minVol);
assert.throws(() => A.selectTarget(sameMean, 0.04, 'exact'), /달성/);
const fixed = A.optimize([asset(0.04, 0.1, 0.3, 0.3), asset(0.08, 0.2, 0.7, 0.7)], corr);
near(fixed.minVol.weights[0], 0.3);
near(A.selectTarget(fixed, 0.068, 'exact').weights[0], 0.3);
near(fixed.returnRange.min, fixed.returnRange.max);
assert.throws(() => A.selectTarget(fixed, 0.067, 'exact'), /달성/);

// Zero-risk assets and negative excess returns do not assume positive Sharpe.
const zeroRisk = A.optimize([asset(0.04, 0), asset(0.08, 0.2)], [[1, 0], [0, 1]], { rf: 0.02 });
assert.equal(zeroRisk.maxSharpe.sharpe, Infinity);
assert.equal(zeroRisk.maxSharpe.sharpeDefined, false);
near(A.selectTarget(zeroRisk, 0.06, 'exact').weights[0], 0.5);
const negative = A.optimize(two, corr, { rf: 0.2 });
const endpointBest = Math.max((0.04 - 0.2) / 0.1, (0.08 - 0.2) / 0.2);
near(negative.maxSharpe.sharpe, endpointBest);
near(A.selectTarget(negative, 0.065, 'exact').return, 0.065, 1e-12);
const negativeMeans = A.optimize([asset(-0.08, 0.1), asset(-0.02, 0.2)], corr);
near(A.selectTarget(negativeMeans, -0.035, 'exact').weights[0], 0.25, 1e-12);

// A dense independent grid checks constrained three-asset numerical optima.
const three = [asset(0.03, 0.07, 0.1, 0.6), asset(0.07, 0.16, 0.2, 0.7), asset(0.1, 0.24, 0.05, 0.5)];
const corr3 = [[1, 0.2, -0.1], [0.2, 1, 0.3], [-0.1, 0.3, 1]];
const solved = A.optimize(three, corr3, { rf: 0.015, points: 21 });
let gridVol = Infinity, gridSharpe = -Infinity, gridTargetVol = Infinity;
const target3 = 0.067;
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
  if (ret >= target3) gridTargetVol = Math.min(gridTargetVol, vol);
}
assert.ok(solved.minVol.vol <= gridVol + 1e-10);
assert.ok(gridVol - solved.minVol.vol < 2e-5);
assert.ok(solved.maxSharpe.sharpe >= gridSharpe - 1e-10);
assert.ok(solved.maxSharpe.sharpe - gridSharpe < 2e-5);
[solved.minVol, solved.maxSharpe, ...solved.frontier].forEach(p => verify(p, three));
assert.equal(solved.meta.covarianceRegularization, 0);
near(solved.returnRange.min, 0.0475, 1e-12);
near(solved.returnRange.max, 0.081, 1e-12);
const lowerBound3 = A.selectTarget(solved, target3);
verify(lowerBound3, three);
assert.ok(lowerBound3.return >= target3 - 1e-12);
assert.ok(lowerBound3.vol <= gridTargetVol + 1e-10);
assert.ok(gridTargetVol - lowerBound3.vol < 2e-5);

// Independent equality-line grid: eliminate two weights using budget and return.
// This checks the actual constraint, not a selection among optimizer outputs.
const exact3 = A.selectTarget(solved, target3, 'exact');
let equalityGridVol = Infinity;
for (let i = 0; i <= 50000; i++) {
  const w0 = 0.1 + i / 100000;
  const w1 = (target3 - three[2].mu - w0 * (three[0].mu - three[2].mu)) / (three[1].mu - three[2].mu);
  const w = [w0, w1, 1 - w0 - w1];
  if (w.some((v, j) => v < three[j].min || v > three[j].max)) continue;
  let variance = 0;
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) variance += w[a] * w[b] * three[a].vol * three[b].vol * corr3[a][b];
  equalityGridVol = Math.min(equalityGridVol, Math.sqrt(variance));
}
verify(exact3, three);
near(exact3.return, target3, 1e-12);
assert.ok(exact3.vol <= equalityGridVol + 1e-10);
assert.ok(equalityGridVol - exact3.vol < 1e-8);
console.log('Allocation analytics: all closed-form, constraint, PSD, singular and grid checks passed.');
