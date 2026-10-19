"""Independent numerical cross-checks (developer-only; Python + NumPy/SciPy).

Run: python tests/validate_platform.py
Production is dependency-free JavaScript. These checks use independently coded
Python statistics, SciPy optimization and analytical identities as references.
"""

from __future__ import annotations

import calendar
import datetime as dt
import itertools
import json
import math
from pathlib import Path
import subprocess

import numpy as np
from scipy.optimize import minimize
from scipy.stats import norm


ROOT = Path(__file__).resolve().parents[1]


def call_js(module: str, method: str, *args):
    """Call the public CommonJS API without depending on browser/UI code."""
    runner = """
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
const engine = require(p.module);
try { process.stdout.write(JSON.stringify({value: engine[p.method](...p.args)})); }
catch (error) { process.stdout.write(JSON.stringify({error: String(error.message)})); }
"""
    payload = {"module": str(ROOT / "template/platform" / module), "method": method, "args": args}
    completed = subprocess.run(["node", "-e", runner], input=json.dumps(payload), text=True,
                               capture_output=True, check=True)
    result = json.loads(completed.stdout)
    if "error" in result:
        raise ValueError(result["error"])
    return result["value"]


def close(actual, expected, *, rtol=1e-10, atol=1e-10):
    np.testing.assert_allclose(actual, expected, rtol=rtol, atol=atol)


def synthetic_monthly():
    history, level = [], 1000.0
    for i in range(91):
        year, month = 2017 + i // 12, i % 12 + 1
        day = calendar.monthrange(year, month)[1]
        date = dt.date(year, month, day)
        date -= dt.timedelta(days=max(0, date.weekday() - 4))
        if i:
            level *= math.exp(.002 + .018 * math.sin(i * .83) + .009 * math.cos(i * .31))
        history.append({"date": date.isoformat(), "value": level})
    return history


def check_fx():
    history = synthetic_monthly()
    forecast = call_js("fx.js", "forecast", history, {"method": "historical", "lookback": 60, "months": 12})
    levels = np.array([p["value"] for p in history[-61:]])
    returns = np.diff(np.log(levels))
    mean, variance = returns.mean(), returns.var(ddof=1)
    close(forecast["annualDrift"], 12 * mean)
    close(forecast["annualVol"], math.sqrt(12 * variance))
    for h, row in enumerate(forecast["rows"]):
        log_m, log_v = h * mean, h * variance
        close(row["median"], levels[-1] * math.exp(log_m))
        close(row["mean"], levels[-1] * math.exp(log_m + .5 * log_v))
        for coverage, name in [(.68, "68"), (.95, "95")]:
            z = norm.ppf((1 + coverage) / 2)
            close(row["lower" + name], levels[-1] * math.exp(log_m - z * math.sqrt(log_v)))
            close(row["upper" + name], levels[-1] * math.exp(log_m + z * math.sqrt(log_v)))
        # Geometric symmetry of the lognormal interval and Jensen adjustment.
        close(row["lower95"] * row["upper95"], row["median"] ** 2)
        close(row["mean"] / row["median"], math.exp(.5 * log_v))

    result = call_js("fx.js", "evaluate", history, {"testMonths": 24})
    chosen = result["rows"][3]
    poisoned = [dict(p, value=p["value"] * (8 if p["date"] >= chosen["date"] else 1)) for p in history]
    changed = call_js("fx.js", "evaluate", poisoned, {"testMonths": 24})
    changed_row = next(r for r in changed["rows"] if r["date"] == chosen["date"])
    assert chosen["actual"] != changed_row["actual"]
    assert chosen["historical"] == changed_row["historical"], "Future observations changed an earlier prediction"
    assert chosen["randomWalk"] == changed_row["randomWalk"]
    for name in ["historical", "randomWalk"]:
        errors = np.array([r[name]["median"] - r["actual"] for r in result["rows"]])
        close(result[name]["rmse"], math.sqrt(np.mean(errors**2)))

    rolling = call_js("fx.js", "evaluate", history, {"testMonths": 24, "lookback": 60})
    for row in rolling["rows"]:
        training = [p["value"] for p in history if p["date"] <= row["asof"]][-61:]
        log_returns = np.diff(np.log(training))
        close(row["historical"]["median"], training[-1] * math.exp(log_returns.mean()))
        close(row["historical"]["upper95"], training[-1] * math.exp(log_returns.mean() + norm.ppf(.975)*log_returns.std(ddof=1)))
        assert row["trainingReturns"] == len(log_returns)

    for h in [0, .5, 1]:
        args = {"localReturn": .07, "fxReturn": -.09, "premium": -.02,
                "hedgeRatio": h, "assetVol": .16, "fxVol": .11, "correlation": -.4}
        result = call_js("fx.js", "scenario", args)
        initial_fx, initial_asset = 1300.0, 100.0
        final_asset = initial_asset * (1 + args["localReturn"])
        final_fx = initial_fx * (1 + args["fxReturn"])
        forward_fx = initial_fx * (1 + args["premium"])
        initial_krw = initial_asset * initial_fx
        final_krw = final_asset * final_fx + h * initial_asset * (forward_fx - final_fx)
        close(result["krwReturn"], final_krw / initial_krw - 1)
        cov = np.array([[.16**2, -.4*.16*.11], [-.4*.16*.11, .11**2]])
        exposure = np.array([1, 1-h])
        close(result["variance"], exposure @ cov @ exposure)
    print("PASS FX: independent monthly moments, lognormal quantiles, rolling refits, forward cash flows, future-poison test")


def bounded_vertices(lower, upper):
    """All bounded-simplex extreme points, independent of a QP solver."""
    n = len(lower)
    for free in range(n):
        others = [i for i in range(n) if i != free]
        for bits in itertools.product((0, 1), repeat=n-1):
            w = np.array(lower, dtype=float)
            for i, bit in zip(others, bits):
                w[i] = upper[i] if bit else lower[i]
            w[free] = 1 - sum(w[others])
            if lower[free] - 1e-12 <= w[free] <= upper[free] + 1e-12:
                yield w


def qp_oracle(mu, cov, lower, upper, target=None):
    if np.max(np.abs(upper-lower)) < 1e-12:
        close(np.sum(lower), 1)
        if target is not None:
            close(lower @ mu, target)
        return np.array(lower)
    constraints = [{"type": "eq", "fun": lambda w: w.sum()-1}]
    vertices = list(bounded_vertices(lower, upper))
    initial = np.mean(vertices, axis=0)
    if target is not None:
        constraints.append({"type": "eq", "fun": lambda w: w @ mu-target})
        low = min(vertices, key=lambda w: w @ mu)
        high = max(vertices, key=lambda w: w @ mu)
        if abs((high-low) @ mu) > 1e-12:
            fraction = (target-low @ mu) / ((high-low) @ mu)
            initial = low + fraction * (high-low)
    result = minimize(lambda w: w @ cov @ w, initial,
                      jac=lambda w: 2*cov @ w, bounds=list(zip(lower, upper)),
                      constraints=constraints, method="SLSQP",
                      options={"ftol": 1e-14, "maxiter": 3000})
    assert result.success, result.message
    return result.x


def sharpe_oracle(mu, cov, lower, upper, rf):
    vertices = list(bounded_vertices(lower, upper))

    def objective(w):
        return -(w @ mu-rf) / math.sqrt(max(1e-25, w @ cov @ w))

    # For non-positive excess return the maximum ratio is attained at a vertex.
    if max(w @ mu for w in vertices) <= rf:
        return min(vertices, key=objective)
    starts = [qp_oracle(mu, cov, lower, upper), np.mean(vertices, axis=0)]
    rng = np.random.default_rng(874)
    starts += [vertices[i] for i in rng.choice(len(vertices), size=min(5, len(vertices)), replace=False)]
    solutions = []
    for start in starts:
        result = minimize(objective, start, bounds=list(zip(lower, upper)), method="SLSQP",
                          constraints=[{"type": "eq", "fun": lambda w: w.sum()-1}],
                          options={"ftol": 1e-13, "maxiter": 2000})
        if result.success:
            solutions.append(result.x)
    assert solutions, "Independent Sharpe optimizer did not converge"
    return min(solutions, key=objective)


def check_portfolios():
    n = 7
    mu = np.array([.032, .045, .046, .058, .075, .085, .065])
    vol = np.array([.035, .045, .065, .085, .17, .19, .10])
    corr = np.full((n, n), .22) + np.eye(n)*.78
    lower, upper = np.full(n, .01), np.full(n, .45)
    rng = np.random.default_rng(4891)
    factors = rng.normal(size=(7, 3))
    singular = factors @ factors.T
    singular /= np.sqrt(np.outer(singular.diagonal(), singular.diagonal()))
    cases = [
        ("positive capped", mu, vol, corr, lower, upper, .025),
        ("all negative excess", mu * .3, vol, corr, lower, upper, .04),
        ("equal expected return", np.full(n, .06), vol, corr, lower, upper, .02),
        ("rank-three covariance", mu, vol, singular, lower, upper, .025),
        ("fixed allocation", mu, vol, corr, np.full(n, 1/n), np.full(n, 1/n), .025),
    ]
    # Mixed-sign random correlation; not the common positive-correlation case.
    for seed in (119, 507):
        loading = np.random.default_rng(seed).normal(size=(n, n))
        covariance = loading @ loading.T + np.eye(n)*.5
        random_corr = covariance / np.sqrt(np.outer(covariance.diagonal(), covariance.diagonal()))
        cases.append((f"random {seed}", mu, vol, random_corr, lower, upper, .025))

    for name, m, v, r, lo, hi, rf in cases:
        covariance = r * np.outer(v, v)
        assets = [{"mu": float(m[i]), "vol": float(v[i]), "min": float(lo[i]), "max": float(hi[i])} for i in range(n)]
        result = call_js("analytics.js", "optimize", assets, r.tolist(), {"rf": rf, "points": 17})
        independent = qp_oracle(m, covariance, lo, hi)
        close(result["minVol"]["vol"]**2, independent @ covariance @ independent, rtol=2e-6, atol=2e-10)
        # Fixed allocation has no degrees of freedom and needs no numerical solver.
        if np.max(hi-lo) > 1e-12 and result["maxSharpe"]["vol"] > 1e-8:
            independent = sharpe_oracle(m, covariance, lo, hi, rf)
            expected = (independent @ m-rf) / math.sqrt(independent @ covariance @ independent)
            close(result["maxSharpe"]["sharpe"], expected, rtol=3e-6, atol=3e-7)
        for point in result["frontier"] + [result["minVol"], result["maxSharpe"]]:
            w = np.array(point["weights"])
            assert np.all(w >= lo-2e-8) and np.all(w <= hi+2e-8), name
            close(w.sum(), 1, atol=2e-8)
            close(point["return"], w @ m)
            close(point["vol"]**2, w @ covariance @ w, atol=1e-11)
            close(sum(point["contributions"]), point["vol"], atol=1e-8)
        for point in result["frontier"][1:-1:4]:
            independent = qp_oracle(m, covariance, lo, hi, point["return"])
            close(point["vol"]**2, independent @ covariance @ independent, rtol=2e-6, atol=2e-10)
        print(f"PASS allocation {name}: minimum variance, Sharpe, frontier, bounds, Euler risk sum")

    invalid = [{"mu": .04, "vol": .1, "max": .1} for _ in range(7)]
    try:
        call_js("analytics.js", "optimize", invalid, corr.tolist(), {})
    except ValueError:
        pass
    else:
        raise AssertionError("Infeasible maximum-weight constraints were accepted")
    bad_corr = np.eye(3) + np.array([[0, .9, .9], [.9, 0, -.9], [.9, -.9, 0]])
    try:
        call_js("analytics.js", "validateModel", [{"mu": .05, "vol": .1}] * 3, bad_corr.tolist())
    except ValueError:
        pass
    else:
        raise AssertionError("Indefinite correlation matrix was accepted")
    print("PASS rejection of infeasible caps and indefinite correlations")


def check_published_data():
    market = json.loads((ROOT / "docs/data/market.json").read_text())
    source = next(s for s in market["series"] if s["code"] == "USDKRW")
    payload = json.loads((ROOT / "docs/data/series" / (source["id"] + ".json")).read_text())
    history = call_js("fx.js", "points", market["dates"], payload)
    result = call_js("fx.js", "forecast", history, {"method": "historical", "months": 12})
    monthly = {}
    for row in history:
        monthly[row["date"][:7]] = row
    samples = sorted(monthly.values(), key=lambda row: row["date"])
    if result["estimation"]["partialLatestMonthExcluded"]:
        samples.pop()
    samples = [p for p in samples if result["estimation"]["startDate"] <= p["date"] <= result["estimation"]["endDate"]]
    returns = np.diff(np.log([p["value"] for p in samples]))
    close(result["annualVol"], returns.std(ddof=1) * math.sqrt(12))
    close(result["annualDrift"], returns.mean() * 12)
    rolling = call_js("fx.js", "evaluate", history, {"testMonths": 24, "lookback": 120})
    squared_errors = {"historical": [], "randomWalk": []}
    for row in rolling["rows"]:
        # Use all monthly history, not the final forecast's restricted window.
        prior = [p["value"] for p in sorted(monthly.values(), key=lambda p: p["date"]) if p["date"] <= row["asof"]][-121:]
        log_returns = np.diff(np.log(prior))
        predictions = {"historical": prior[-1] * math.exp(log_returns.mean()), "randomWalk": prior[-1]}
        for model, predicted in predictions.items():
            close(row[model]["median"], predicted)
            squared_errors[model].append((predicted-row["actual"])**2)
    for model in squared_errors:
        close(rolling[model]["rmse"], math.sqrt(np.mean(squared_errors[model])))
    flat = 1
    for row in reversed(history[:-1]):
        if row["value"] != history[-1]["value"]:
            break
        flat += 1
    print(f"PASS published USDKRW: {result['observations']} monthly returns, asof {result['asof']}; flat tail {flat}")


if __name__ == "__main__":
    check_portfolios()
    check_fx()
    check_published_data()
