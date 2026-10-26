"""
Exact-match unit tests for scenario_math.py.

Run with: python3 -m unittest finvault_agent_core.tests.test_scenario_math -v
(from backend/layers/finvault-agent-core/)

Reference values are computed independently via Python's stdlib
statistics.NormalDist — a separate code path from this module's own
`cnd()`, not a circular check against itself.
"""

import math
import unittest

from finvault_agent_core.scenario_math import (
    Leg,
    LegSide,
    LegType,
    black_scholes_greeks,
    black_scholes_price,
    payoff_at_price,
    simulate_scenario,
)


class TestBlackScholesPrice(unittest.TestCase):
    def test_atm_call_one_year(self):
        # S=100, K=100, T=1, r=0.05, sigma=0.25 — independently computed via
        # statistics.NormalDist: 12.335998930368717
        price = black_scholes_price(100, 100, 1, 0.05, 0.25, "C")
        self.assertAlmostEqual(price, 12.335998930368717, places=6)

    def test_atm_put_one_year(self):
        # Same inputs, put side — independently computed: 7.458941380440123
        price = black_scholes_price(100, 100, 1, 0.05, 0.25, "P")
        self.assertAlmostEqual(price, 7.458941380440123, places=6)

    def test_otm_put_csp_like(self):
        # S=50, K=45, T=0.25, r=0.045, sigma=0.35 — a cash-secured-put-shaped
        # case. Independently computed: 1.2454185344386115
        price = black_scholes_price(50, 45, 0.25, 0.045, 0.35, "P")
        self.assertAlmostEqual(price, 1.2454185344386115, places=6)

    def test_put_call_parity(self):
        # C - P == S - K*exp(-rT), for any consistent set of inputs.
        S, K, T, r, sigma = 87.5, 90, 0.5, 0.04, 0.3
        call = black_scholes_price(S, K, T, r, sigma, "C")
        put = black_scholes_price(S, K, T, r, sigma, "P")
        self.assertAlmostEqual(call - put, S - K * math.exp(-r * T), places=6)

    def test_zero_time_to_expiry_is_intrinsic(self):
        self.assertEqual(black_scholes_price(110, 100, 0, 0.05, 0.3, "C"), 10)
        self.assertEqual(black_scholes_price(90, 100, 0, 0.05, 0.3, "C"), 0)
        self.assertEqual(black_scholes_price(90, 100, 0, 0.05, 0.3, "P"), 10)


class TestBlackScholesGreeks(unittest.TestCase):
    def test_atm_call_delta(self):
        # Independently computed N(d1) for S=100,K=100,T=1,r=.05,sigma=.25: 0.627409464153284
        greeks = black_scholes_greeks(100, 100, 1, 0.05, 0.25, "C")
        self.assertAlmostEqual(greeks["delta"], 0.6274, places=4)

    def test_otm_put_delta(self):
        # Independently computed: -0.22547090835907269
        greeks = black_scholes_greeks(50, 45, 0.25, 0.045, 0.35, "P")
        self.assertAlmostEqual(greeks["delta"], -0.2255, places=4)

    def test_call_put_delta_relationship(self):
        # delta_call - delta_put == 1 for the same S,K,T,r,sigma.
        S, K, T, r, sigma = 87.5, 90, 0.5, 0.04, 0.3
        call_delta = black_scholes_greeks(S, K, T, r, sigma, "C")["delta"]
        put_delta = black_scholes_greeks(S, K, T, r, sigma, "P")["delta"]
        self.assertAlmostEqual(call_delta - put_delta, 1.0, places=4)

    def test_zero_time_to_expiry(self):
        g = black_scholes_greeks(110, 100, 0, 0.05, 0.3, "C")
        self.assertEqual(g, {"delta": 1.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0})


class TestPayoffAtPrice(unittest.TestCase):
    def test_long_stock(self):
        leg = Leg(type=LegType.STOCK, side=LegSide.LONG, qty=100, entry_price=50)
        self.assertEqual(payoff_at_price([leg], 55), 500)
        self.assertEqual(payoff_at_price([leg], 45), -500)

    def test_short_stock(self):
        leg = Leg(type=LegType.STOCK, side=LegSide.SHORT, qty=100, entry_price=50)
        self.assertEqual(payoff_at_price([leg], 45), 500)
        self.assertEqual(payoff_at_price([leg], 55), -500)

    def test_cash_secured_put_otm_expires_worthless(self):
        # Short 1 put, strike 45, sold for 1.20 premium per share, 100 shares/contract.
        leg = Leg(type=LegType.PUT, side=LegSide.SHORT, qty=100, entry_price=1.20, strike=45)
        # Stock finishes above strike -> put expires worthless -> keep full premium.
        self.assertAlmostEqual(payoff_at_price([leg], 50), 120, places=2)

    def test_cash_secured_put_assigned_itm(self):
        leg = Leg(type=LegType.PUT, side=LegSide.SHORT, qty=100, entry_price=1.20, strike=45)
        # Stock finishes at 40 -> put is $5 ITM -> lose 5 - 1.20 premium per share.
        self.assertAlmostEqual(payoff_at_price([leg], 40), (1.20 - 5) * 100, places=2)

    def test_covered_call(self):
        stock = Leg(type=LegType.STOCK, side=LegSide.LONG, qty=100, entry_price=48)
        call = Leg(type=LegType.CALL, side=LegSide.SHORT, qty=100, entry_price=1.50, strike=50)
        legs = [stock, call]
        # Stock called away at 50: stock gain capped at 2, plus premium kept.
        self.assertAlmostEqual(payoff_at_price(legs, 55), (50 - 48) * 100 + 1.50 * 100, places=2)
        # Stock finishes below strike: call worthless, just stock P&L + premium.
        self.assertAlmostEqual(payoff_at_price(legs, 49), (49 - 48) * 100 + 1.50 * 100, places=2)

    def test_vertical_spread(self):
        long_put = Leg(type=LegType.PUT, side=LegSide.LONG, qty=100, entry_price=2.0, strike=95)
        short_put = Leg(type=LegType.PUT, side=LegSide.SHORT, qty=100, entry_price=0.8, strike=90)
        legs = [long_put, short_put]
        # Max loss (both ITM, max spread width minus net credit received)
        net_credit = (0.8 - 2.0) * 100  # negative = net debit paid
        self.assertAlmostEqual(payoff_at_price(legs, 80), (95 - 90) * 100 + net_credit, places=2)
        # Both OTM: lose net debit paid
        self.assertAlmostEqual(payoff_at_price(legs, 100), net_credit, places=2)


class TestSimulateScenarioPriceMove(unittest.TestCase):
    def test_deterministic_point_eval(self):
        leg = Leg(type=LegType.STOCK, side=LegSide.LONG, qty=100, entry_price=100)
        result = simulate_scenario(
            [leg], underlying_price=100, iv=0.25, days_to_expiry=30,
            scenario_type="price_move", price_move_pct=0.15,
        )
        self.assertEqual(result["assumed_price"], 115)
        self.assertEqual(result["pnl"], 1500)
        self.assertNotIn("probability_of_profit", result)

    def test_breakeven_for_long_call(self):
        call = Leg(type=LegType.CALL, side=LegSide.LONG, qty=100, entry_price=3.0, strike=100)
        result = simulate_scenario(
            [call], underlying_price=100, iv=0.3, days_to_expiry=45,
            scenario_type="price_move", price_move_pct=0.0,
        )
        # Breakeven for a long call = strike + premium = 103.
        self.assertEqual(len(result["breakevens"]), 1)
        self.assertAlmostEqual(result["breakevens"][0], 103, places=1)


class TestSimulateScenarioMonteCarlo(unittest.TestCase):
    def test_reproducible_with_fixed_seed(self):
        leg = Leg(type=LegType.STOCK, side=LegSide.LONG, qty=100, entry_price=100)
        r1 = simulate_scenario([leg], 100, 0.25, 30, scenario_type="expiry_distribution", random_seed=7)
        r2 = simulate_scenario([leg], 100, 0.25, 30, scenario_type="expiry_distribution", random_seed=7)
        self.assertEqual(r1["probability_of_profit"], r2["probability_of_profit"])
        self.assertEqual(r1["expected_value"], r2["expected_value"])

    def test_pop_converges_to_closed_form_nd2(self):
        # A long call struck ATM with ZERO premium: probability of profit
        # (pnl > 0) equals probability of finishing ITM (S_T > K), which
        # under risk-neutral GBM is exactly N(d2) in closed form.
        # S=100, K=100, T=1yr (365d), r=0.05, sigma=0.20 -> N(d2) = 0.5596176923702425
        call = Leg(type=LegType.CALL, side=LegSide.LONG, qty=1, entry_price=0.0, strike=100)
        result = simulate_scenario(
            [call], underlying_price=100, iv=0.20, days_to_expiry=365, r=0.05,
            scenario_type="expiry_distribution", monte_carlo_paths=50_000, random_seed=123,
        )
        closed_form_nd2 = 0.5596176923702425
        # Monte Carlo sampling error at 50k paths is on the order of
        # 1/sqrt(50000) ~= 0.0045; allow a comfortable tolerance band.
        self.assertAlmostEqual(result["probability_of_profit"], closed_form_nd2, delta=0.015)

    def test_long_stock_pop_roughly_half_at_zero_drift_cost_basis(self):
        # With r=0 and entry_price == underlying_price, a long stock
        # position's PoP under GBM should be close to 50% (slightly above,
        # since lognormal drift is upward-skewed even at zero risk-free rate
        # due to the -0.5*sigma^2*T term's interaction with qty symmetry).
        leg = Leg(type=LegType.STOCK, side=LegSide.LONG, qty=100, entry_price=100)
        result = simulate_scenario(
            [leg], underlying_price=100, iv=0.2, days_to_expiry=365, r=0.0,
            scenario_type="expiry_distribution", monte_carlo_paths=50_000, random_seed=55,
        )
        self.assertTrue(0.40 <= result["probability_of_profit"] <= 0.50)


class TestSimulateScenarioIvCrush(unittest.TestCase):
    def test_iv_crush_reduces_option_value(self):
        call = Leg(type=LegType.CALL, side=LegSide.LONG, qty=100, entry_price=3.0, strike=100)
        result = simulate_scenario(
            [call], underlying_price=100, iv=0.6, days_to_expiry=5,
            scenario_type="iv_crush", iv_crush_factor=0.4,
        )
        self.assertEqual(result["crushed_iv"], 0.24)
        # High starting IV (0.6) crushed to 0.24 one day before a 5-day
        # expiry should produce a loss on a long call bought at iv=0.6 prices.
        self.assertLess(result["pnl"], 0)


class TestInputValidation(unittest.TestCase):
    def test_empty_legs_rejected(self):
        with self.assertRaises(ValueError):
            simulate_scenario([], 100, 0.25, 30)

    def test_non_positive_iv_rejected(self):
        leg = Leg(type=LegType.STOCK, side=LegSide.LONG, qty=100, entry_price=100)
        with self.assertRaises(ValueError):
            simulate_scenario([leg], 100, 0.0, 30)

    def test_price_move_without_pct_rejected(self):
        leg = Leg(type=LegType.STOCK, side=LegSide.LONG, qty=100, entry_price=100)
        with self.assertRaises(ValueError):
            simulate_scenario([leg], 100, 0.25, 30, scenario_type="price_move")


if __name__ == "__main__":
    unittest.main()
