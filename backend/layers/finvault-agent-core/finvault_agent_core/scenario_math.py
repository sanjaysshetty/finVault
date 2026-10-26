"""
Deterministic scenario simulation and payoff math.

Canonical source of every probability/payoff number surfaced by the
Opportunity Engine and Deep Dive agentic surfaces — the LLM narrates
around this module's output, it never originates a probability or
payoff number itself.

Ported from and consolidating two existing implementations:
  - backend/crud/paper-trade-api/app.js (cnd/bsPrice/bsGreeks) — the
    production Black-Scholes implementation already serving paper-trade
    fills. This becomes the one canonical Black-Scholes implementation
    for new Python code.
  - backend/ai-services/wheel-scan/tools.py (_approx_delta) — a cruder
    put-only delta approximation (no risk-free-rate term, no call/put
    branch) that this module replaces.

Pure Python, zero AWS dependencies, zero third-party dependencies —
deliberately, so it stays exact-match unit-testable without a Lambda
runtime or any network/service call.
"""

import math
import random
from dataclasses import dataclass
from enum import Enum
from typing import Literal, Optional

# Matches paper-trade-api's RISK_FREE_RATE (app.js) — update once a year.
RISK_FREE_RATE_DEFAULT = 0.045

# Matches paper-trade-api's hv30-unavailable fallback (app.js buildSnapshot).
DEFAULT_IV_FALLBACK = 0.30


class LegType(str, Enum):
    STOCK = "STOCK"
    CALL = "CALL"
    PUT = "PUT"


class LegSide(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


@dataclass(frozen=True)
class Leg:
    """One leg of a position. `strike` is required for CALL/PUT, ignored for STOCK."""

    type: LegType
    side: LegSide
    qty: float
    entry_price: float
    strike: Optional[float] = None


def cnd(x: float) -> float:
    """Standard normal CDF, exact via math.erf.

    paper-trade-api's JS `cnd` uses a manual Abramowitz & Stegun rational
    approximation (no erf in JS). Python's math.erf is exact and free, so
    this is strictly more accurate than the ported formula — not a
    byte-for-byte port of the JS approximation.
    """
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _npd(x: float) -> float:
    """Standard normal PDF, phi(x) — inlined in paper-trade-api's bsGreeks."""
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def black_scholes_price(
    S: float, K: float, T: float, r: float, sigma: float, right: Literal["C", "P"]
) -> float:
    """Direct port of paper-trade-api's bsPrice (app.js lines 84-92)."""
    if T <= 0:
        return max(S - K, 0.0) if right == "C" else max(K - S, 0.0)
    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    if right == "C":
        return S * cnd(d1) - K * math.exp(-r * T) * cnd(d2)
    return K * math.exp(-r * T) * cnd(-d2) - S * cnd(-d1)


def black_scholes_greeks(
    S: float, K: float, T: float, r: float, sigma: float, right: Literal["C", "P"]
) -> dict:
    """Direct port of paper-trade-api's bsGreeks (app.js lines 94-112)."""
    if T <= 0:
        return {"delta": 1.0 if right == "C" else -1.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    npd1 = _npd(d1)
    delta = cnd(d1) if right == "C" else cnd(d1) - 1
    gamma = npd1 / (S * sigma * sqrt_t)
    vega = S * npd1 * sqrt_t / 100  # per 1% change in vol
    if right == "C":
        theta = (-(S * npd1 * sigma) / (2 * sqrt_t) - r * K * math.exp(-r * T) * cnd(d2)) / 365
    else:
        theta = (-(S * npd1 * sigma) / (2 * sqrt_t) + r * K * math.exp(-r * T) * cnd(-d2)) / 365
    return {
        "delta": round(delta, 4),
        "gamma": round(gamma, 4),
        "theta": round(theta, 4),
        "vega": round(vega, 4),
    }


def payoff_at_price(legs: list[Leg], s_t: float) -> float:
    """Total dollar P&L of a multi-leg position at a given terminal stock price.

    Covers a single equity leg, a covered call, a cash-secured put, or a
    vertical spread with the same code path — no per-strategy branching.
    """
    total = 0.0
    for leg in legs:
        sign = 1.0 if leg.side == LegSide.LONG else -1.0
        if leg.type == LegType.STOCK:
            intrinsic = s_t
        elif leg.type == LegType.CALL:
            intrinsic = max(s_t - leg.strike, 0.0)
        elif leg.type == LegType.PUT:
            intrinsic = max(leg.strike - s_t, 0.0)
        else:
            raise ValueError(f"Unknown leg type: {leg.type}")
        total += sign * (intrinsic - leg.entry_price) * leg.qty
    return total


def _find_breakevens(legs: list[Leg], s0: float) -> list[float]:
    """Root-find breakeven terminal price(s).

    payoff_at_price is piecewise-linear in s_t for any combination of
    STOCK/CALL/PUT legs, so a grid scan for sign changes followed by
    bisection is exact (no numerical solver dependency needed).
    """
    lo, hi = max(s0 * 0.01, 0.01), s0 * 5
    n = 2000
    xs = [lo + (hi - lo) * i / n for i in range(n + 1)]
    ys = [payoff_at_price(legs, x) for x in xs]
    breakevens = []
    for i in range(n):
        if ys[i] == 0:
            breakevens.append(round(xs[i], 4))
        elif (ys[i] < 0) != (ys[i + 1] < 0):
            a, b = xs[i], xs[i + 1]
            fa = ys[i]
            for _ in range(40):
                mid = (a + b) / 2
                fm = payoff_at_price(legs, mid)
                if (fm < 0) == (fa < 0):
                    a, fa = mid, fm
                else:
                    b = mid
            breakevens.append(round((a + b) / 2, 4))
    return breakevens


def _payoff_curve(legs: list[Leg], s0: float, points: int = 61) -> list[dict]:
    """Payoff at 61 points spanning -40%/+40% of s0, for charting."""
    return [
        {
            "price": round(s0 * (0.6 + 0.8 * i / (points - 1)), 2),
            "pnl": round(payoff_at_price(legs, s0 * (0.6 + 0.8 * i / (points - 1))), 2),
        }
        for i in range(points)
    ]


ScenarioType = Literal["price_move", "expiry_distribution", "iv_crush"]


def simulate_scenario(
    legs: list[Leg],
    underlying_price: float,
    iv: float,
    days_to_expiry: float,
    r: float = RISK_FREE_RATE_DEFAULT,
    scenario_type: ScenarioType = "expiry_distribution",
    price_move_pct: Optional[float] = None,
    iv_crush_factor: Optional[float] = None,
    monte_carlo_paths: int = 20_000,
    random_seed: int = 42,
) -> dict:
    """
    The one tool every Tower-2 agent calls for a probability/payoff number.
    `requires_confirmation: False` — read-only math, no side effects.

    Three modes:
      - "price_move": deterministic point evaluation at
        underlying_price * (1 + price_move_pct). No probability — a single
        what-if, not a distribution.
      - "expiry_distribution" (default): lognormal GBM Monte Carlo at
        expiry, fixed seed for reproducibility. Computes
        probability_of_profit, expected_value, max_gain/max_loss (empirical
        over the sampled paths) and a payoff curve.
      - "iv_crush": Black-Scholes repricing one day forward with reduced
        sigma (e.g. post-earnings IV collapse) — a mark-to-market
        repricing, not a Monte Carlo draw.
    """
    if not legs:
        raise ValueError("simulate_scenario requires at least one leg")
    if iv <= 0:
        raise ValueError("iv must be positive — use DEFAULT_IV_FALLBACK (0.30) if unknown")

    s0 = underlying_price
    t = days_to_expiry / 365.0
    breakevens = _find_breakevens(legs, s0)
    payoff_curve = _payoff_curve(legs, s0)

    if scenario_type == "price_move":
        if price_move_pct is None:
            raise ValueError("price_move scenario requires price_move_pct")
        s_t = s0 * (1 + price_move_pct)
        return {
            "scenario_type": scenario_type,
            "assumed_price": round(s_t, 2),
            "pnl": round(payoff_at_price(legs, s_t), 2),
            "breakevens": breakevens,
            "payoff_curve": payoff_curve,
            "days_to_expiry": days_to_expiry,
            "assumptions": {"model": "deterministic_point_eval"},
        }

    if scenario_type == "iv_crush":
        if iv_crush_factor is None:
            raise ValueError("iv_crush scenario requires iv_crush_factor")
        crushed_iv = iv * iv_crush_factor
        t_after = max(t - 1 / 365.0, 0.0)
        total = 0.0
        for leg in legs:
            sign = 1.0 if leg.side == LegSide.LONG else -1.0
            if leg.type == LegType.STOCK:
                total += sign * (s0 - leg.entry_price) * leg.qty
            else:
                right = "C" if leg.type == LegType.CALL else "P"
                new_price = black_scholes_price(s0, leg.strike, t_after, r, crushed_iv, right)
                total += sign * (new_price - leg.entry_price) * leg.qty
        return {
            "scenario_type": scenario_type,
            "crushed_iv": round(crushed_iv, 4),
            "pnl": round(total, 2),
            "breakevens": breakevens,
            "payoff_curve": payoff_curve,
            "days_to_expiry": days_to_expiry,
            "assumptions": {"model": "black_scholes_reprice", "iv_crush_factor": iv_crush_factor},
        }

    # "expiry_distribution" — lognormal GBM Monte Carlo
    rng = random.Random(random_seed)
    drift = (r - 0.5 * iv * iv) * t
    vol_term = iv * math.sqrt(t)
    pnls = []
    for _ in range(monte_carlo_paths):
        z = rng.gauss(0.0, 1.0)
        s_t = s0 * math.exp(drift + vol_term * z)
        pnls.append(payoff_at_price(legs, s_t))

    wins = sum(1 for p in pnls if p > 0)
    return {
        "scenario_type": scenario_type,
        "probability_of_profit": round(wins / monte_carlo_paths, 4),
        "expected_value": round(sum(pnls) / monte_carlo_paths, 2),
        "max_gain": round(max(pnls), 2),
        "max_loss": round(min(pnls), 2),
        "breakevens": breakevens,
        "payoff_curve": payoff_curve,
        "days_to_expiry": days_to_expiry,
        "assumptions": {
            "model": "gbm_monte_carlo",
            "paths": monte_carlo_paths,
            "random_seed": random_seed,
        },
    }
