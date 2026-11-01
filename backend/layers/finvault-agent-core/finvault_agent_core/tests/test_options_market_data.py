"""
Unit tests for options_market_data.py -- the yfinance-backed source of
underlying_price/iv for Tower 2's get_option_chain tool, replacing the
Robinhood MCP market-data tools that have no supported path to a backend
access token (see that module's docstring).

A real yfinance.Ticker is never constructed here -- get_option_chain_data
takes an injectable `ticker_factory`, same DI pattern as
RobinhoodMcpClient's `token_provider`, so these tests build a small fake
Ticker/chain/table object instead of mocking the yfinance import itself
or depending on real pandas. This module now lives back in the shared
layer (container-image packaging removed the 250MB zip pressure that
had briefly moved it into its own standalone Lambda) but these tests
still avoid a real pandas/yfinance dependency on principle -- they don't
need it, so they don't take it.

Run with: python3 -m unittest finvault_agent_core.tests.test_options_market_data -v
(from backend/layers/finvault-agent-core/)
"""

import datetime
import unittest

from finvault_agent_core.options_market_data import (
    OptionMarketDataError,
    days_to_expiry,
    get_option_chain_data,
)


class _FakeTable:
    """Minimal stand-in for the pandas DataFrame yfinance's option_chain
    actually returns -- only implements the two things
    get_option_chain_data touches: `.empty` and `.iterrows()`."""

    def __init__(self, rows=None):
        self._rows = rows or []

    @property
    def empty(self):
        return not self._rows

    def iterrows(self):
        return enumerate(self._rows)


class _FakeChain:
    def __init__(self, calls=None, puts=None):
        self.calls = _FakeTable(calls)
        self.puts = _FakeTable(puts)


class _FakeTicker:
    def __init__(self, last_price, chain):
        self._last_price = last_price
        self._chain = chain

    @property
    def fast_info(self):
        return {"lastPrice": self._last_price}

    def option_chain(self, expiry):
        return self._chain


def _row(strike, bid, ask, last_price, iv, volume, open_interest):
    return {
        "strike": strike, "bid": bid, "ask": ask, "lastPrice": last_price,
        "impliedVolatility": iv, "volume": volume, "openInterest": open_interest,
    }


def _make_factory(last_price, calls_rows=None, puts_rows=None):
    chain = _FakeChain(calls=calls_rows, puts=puts_rows)

    def factory(symbol):
        return _FakeTicker(last_price, chain)

    return factory


class TestGetOptionChainData(unittest.TestCase):
    def test_returns_liquid_near_the_money_contracts_sorted_by_distance(self):
        rows = [
            _row(100, 5.0, 5.2, 5.1, 0.30, 500, 1000),   # near the money, liquid
            _row(102, 3.5, 3.7, 3.6, 0.31, 300, 800),    # near the money, liquid
            _row(98, 7.0, 7.2, 7.1, 0.32, 400, 900),     # near the money, liquid
            _row(200, 0.05, 0.10, 0.07, 1.50, 1, 1),     # far OTM, illiquid, way outside moneyness window
        ]
        factory = _make_factory(last_price=100.0, calls_rows=rows)

        result = get_option_chain_data("TICK", "2026-12-18", "call", ticker_factory=factory)

        self.assertEqual(result["underlying_price"], 100.0)
        strikes = [c["strike"] for c in result["contracts"]]
        self.assertEqual(strikes, [100.0, 102.0, 98.0])  # sorted nearest-to-100 first
        self.assertNotIn(200.0, strikes)  # excluded: >20% away from underlying

    def test_strike_hint_changes_sort_center(self):
        rows = [
            _row(100, 5.0, 5.2, 5.1, 0.30, 500, 1000),
            _row(105, 3.0, 3.2, 3.1, 0.30, 500, 1000),
            _row(110, 1.5, 1.7, 1.6, 0.30, 500, 1000),
        ]
        factory = _make_factory(last_price=100.0, calls_rows=rows)

        result = get_option_chain_data("TICK", "2026-12-18", "call", strike_hint=110, ticker_factory=factory)

        strikes = [c["strike"] for c in result["contracts"]]
        self.assertEqual(strikes[0], 110.0)  # nearest to strike_hint, not to underlying_price

    def test_illiquid_contracts_excluded(self):
        rows = [
            _row(100, 5.0, 5.2, 5.1, 0.30, 500, 1000),  # liquid
            _row(101, 4.5, 4.7, 4.6, 0.95, 2, 3),       # near the money but illiquid (volume+OI=5 < MIN_LIQUIDITY)
        ]
        factory = _make_factory(last_price=100.0, calls_rows=rows)

        result = get_option_chain_data("TICK", "2026-12-18", "call", ticker_factory=factory)

        strikes = [c["strike"] for c in result["contracts"]]
        self.assertEqual(strikes, [100.0])

    def test_mid_falls_back_to_last_price_when_no_bid_ask(self):
        rows = [_row(100, 0, 0, 5.15, 0.30, 500, 1000)]
        factory = _make_factory(last_price=100.0, calls_rows=rows)

        result = get_option_chain_data("TICK", "2026-12-18", "call", ticker_factory=factory)

        self.assertEqual(result["contracts"][0]["mid"], 5.15)

    def test_put_option_type_uses_puts_table(self):
        call_rows = [_row(100, 5.0, 5.2, 5.1, 0.30, 500, 1000)]
        put_rows = [_row(95, 2.0, 2.2, 2.1, 0.28, 500, 1000)]
        factory = _make_factory(last_price=100.0, calls_rows=call_rows, puts_rows=put_rows)

        result = get_option_chain_data("TICK", "2026-12-18", "put", ticker_factory=factory)

        self.assertEqual(result["contracts"][0]["strike"], 95.0)

    def test_raises_when_no_chain_data_at_all(self):
        factory = _make_factory(last_price=100.0, calls_rows=None)
        with self.assertRaises(OptionMarketDataError):
            get_option_chain_data("TICK", "2026-12-18", "call", ticker_factory=factory)

    def test_raises_when_nothing_survives_the_liquidity_filter(self):
        rows = [_row(100, 1.0, 1.1, 1.05, 0.30, 1, 1)]  # liquid-ish price but volume+OI=2 < MIN_LIQUIDITY
        factory = _make_factory(last_price=100.0, calls_rows=rows)

        with self.assertRaises(OptionMarketDataError):
            get_option_chain_data("TICK", "2026-12-18", "call", ticker_factory=factory)

    def test_raises_when_nothing_survives_the_moneyness_filter(self):
        rows = [_row(500, 1.0, 1.1, 1.05, 0.30, 500, 1000)]  # liquid but 5x away from underlying
        factory = _make_factory(last_price=100.0, calls_rows=rows)

        with self.assertRaises(OptionMarketDataError):
            get_option_chain_data("TICK", "2026-12-18", "call", ticker_factory=factory)

    def test_wraps_factory_exception(self):
        def failing_factory(symbol):
            raise RuntimeError("network blip")

        with self.assertRaises(OptionMarketDataError):
            get_option_chain_data("TICK", "2026-12-18", "call", ticker_factory=failing_factory)


class TestDaysToExpiry(unittest.TestCase):
    def test_computes_calendar_days(self):
        result = days_to_expiry("2026-12-18", as_of=datetime.date(2026, 12, 1))
        self.assertEqual(result, 17.0)

    def test_past_expiry_is_negative(self):
        result = days_to_expiry("2026-01-01", as_of=datetime.date(2026, 12, 1))
        self.assertLess(result, 0)


if __name__ == "__main__":
    unittest.main()
