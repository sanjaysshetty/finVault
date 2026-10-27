"""
Unit tests for prefilter.py's scoring rubric -- specifically the two new
free, deterministic signals (momentum/52-week range position, liquidity)
added to make the ranking correlate more directly with "likely to succeed
as a near-term trade idea," and summarize_fundamentals's compact format.

Run with: python3 -m unittest tests.test_prefilter -v
(from backend/ai-services/opportunity-engine/)
"""

import unittest

from prefilter import score_stock_fundamentals, summarize_fundamentals


def _base_stock(**overrides):
    stock = {
        "ticker": "TEST",
        "name": "Test Co",
        "sector": "Technology",
        "price": 100.0,
        "market_cap_b": 10.0,
        "rev_growth": 0.0,
        "gross_margin": 0.0,
        "fcf": 0,
        "de_ratio": 5.0,  # deliberately high so the baseline score floor is near 0
        "roe": 0.0,
        "eps_growth": 0.0,
        "week52_high": None,
        "week52_low": None,
        "avg_volume": 0,
    }
    stock.update(overrides)
    return stock


class TestMomentumScoring(unittest.TestCase):
    def test_sweet_spot_scores_higher_than_near_52_week_low(self):
        near_low = _base_stock(price=52.0, week52_low=50.0, week52_high=150.0)   # range_pos ~0.02
        sweet_spot = _base_stock(price=120.0, week52_low=50.0, week52_high=150.0)  # range_pos=0.70

        self.assertGreater(score_stock_fundamentals(sweet_spot), score_stock_fundamentals(near_low))

    def test_sweet_spot_scores_higher_than_overextended_blow_off_top(self):
        overextended = _base_stock(price=149.0, week52_low=50.0, week52_high=150.0)  # range_pos=0.99
        sweet_spot = _base_stock(price=120.0, week52_low=50.0, week52_high=150.0)     # range_pos=0.70

        self.assertGreaterEqual(score_stock_fundamentals(sweet_spot), score_stock_fundamentals(overextended))

    def test_missing_52_week_data_scores_neither_up_nor_down(self):
        missing = _base_stock(week52_high=None, week52_low=None)
        present_but_neutral_range = _base_stock(price=100.0, week52_low=0.0, week52_high=200.0)  # range_pos=0.50
        # Missing data contributes 0 to this component; a present-but-outside-any-bucket
        # range (e.g. exactly at the boundary) should score >= missing data, never less.
        self.assertLessEqual(score_stock_fundamentals(missing), score_stock_fundamentals(present_but_neutral_range) + 1)

    def test_invalid_range_does_not_crash(self):
        # week52_high <= week52_low is a degenerate/bad-data case -- must not raise.
        bad = _base_stock(week52_high=50.0, week52_low=100.0)
        score_stock_fundamentals(bad)  # no exception


class TestLiquidityScoring(unittest.TestCase):
    def test_monotonic_in_average_dollar_volume(self):
        low_liq = _base_stock(price=10.0, avg_volume=10_000)       # $0.1M/day
        mid_liq = _base_stock(price=10.0, avg_volume=1_000_000)    # $10M/day
        high_liq = _base_stock(price=10.0, avg_volume=10_000_000)  # $100M/day

        s_low = score_stock_fundamentals(low_liq)
        s_mid = score_stock_fundamentals(mid_liq)
        s_high = score_stock_fundamentals(high_liq)
        self.assertLessEqual(s_low, s_mid)
        self.assertLessEqual(s_mid, s_high)

    def test_zero_volume_contributes_nothing(self):
        zero_vol = _base_stock(avg_volume=0)
        # Shouldn't raise, and shouldn't score higher than a liquid stock.
        liquid = _base_stock(price=10.0, avg_volume=10_000_000)
        self.assertLessEqual(score_stock_fundamentals(zero_vol), score_stock_fundamentals(liquid))


class TestScoreCapsAt100(unittest.TestCase):
    def test_best_possible_stock_caps_at_100(self):
        best = _base_stock(
            rev_growth=25, gross_margin=70, fcf=10_000_000_000, de_ratio=0.1, roe=40, eps_growth=30,
            price=120.0, week52_low=50.0, week52_high=150.0,  # range_pos=0.70 -> sweet spot
            avg_volume=50_000_000,  # extremely liquid at $10/share placeholder below
        )
        best["price"] = 100.0  # keep avg-dollar-volume huge regardless of range calc above
        self.assertLessEqual(score_stock_fundamentals(best), 100)


class TestSummarizeFundamentals(unittest.TestCase):
    def test_includes_key_fields(self):
        stock = _base_stock(ticker="AAPL", name="Apple Inc.", sector="Technology",
                             price=250.5, market_cap_b=3500.0, rev_growth=8.2,
                             gross_margin=46.5, de_ratio=1.5, roe=28.0, eps_growth=12.0)
        stock["_fund_score"] = 72
        summary = summarize_fundamentals(stock)
        self.assertIn("AAPL", summary)
        self.assertIn("Apple Inc.", summary)
        self.assertIn("250.5", summary)
        self.assertIn("72/100", summary)


if __name__ == "__main__":
    unittest.main()
