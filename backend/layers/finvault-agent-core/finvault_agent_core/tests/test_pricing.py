"""
Unit tests for pricing.py.

Run with: python3 -m unittest finvault_agent_core.tests.test_pricing -v
"""

import unittest
from types import SimpleNamespace

from finvault_agent_core.pricing import (
    PRICING_USD_PER_MTOK,
    WEB_SEARCH_USD_PER_CALL,
    UnknownModelPricingError,
    estimate_cost_from_response,
    estimate_cost_usd,
    get_pricing,
)


class TestGetPricing(unittest.TestCase):
    def test_known_model_returns_rates(self):
        self.assertEqual(get_pricing("claude-sonnet-5"), PRICING_USD_PER_MTOK["claude-sonnet-5"])

    def test_unknown_model_raises(self):
        with self.assertRaises(UnknownModelPricingError):
            get_pricing("claude-does-not-exist")


class TestEstimateCostUsd(unittest.TestCase):
    def test_input_and_output_tokens(self):
        cost = estimate_cost_usd("claude-sonnet-5", input_tokens=1_000_000, output_tokens=1_000_000)
        self.assertAlmostEqual(cost, 2.00 + 10.00, places=6)

    def test_zero_usage_costs_zero(self):
        self.assertEqual(estimate_cost_usd("claude-sonnet-5"), 0.0)

    def test_cache_read_cheaper_than_base_input(self):
        base = estimate_cost_usd("claude-sonnet-5", input_tokens=1_000_000)
        cache_read = estimate_cost_usd("claude-sonnet-5", cache_read_input_tokens=1_000_000)
        self.assertLess(cache_read, base)

    def test_cache_write_pricier_than_base_input(self):
        base = estimate_cost_usd("claude-sonnet-5", input_tokens=1_000_000)
        cache_write = estimate_cost_usd("claude-sonnet-5", cache_creation_input_tokens=1_000_000)
        self.assertGreater(cache_write, base)

    def test_web_search_adds_flat_per_call_cost(self):
        cost = estimate_cost_usd("claude-sonnet-5", server_tool_use_web_search_requests=3)
        self.assertAlmostEqual(cost, 3 * WEB_SEARCH_USD_PER_CALL, places=6)

    def test_haiku_cheaper_than_sonnet_for_identical_usage(self):
        sonnet_cost = estimate_cost_usd("claude-sonnet-5", input_tokens=1000, output_tokens=1000)
        haiku_cost = estimate_cost_usd("claude-haiku-4-5", input_tokens=1000, output_tokens=1000)
        self.assertLess(haiku_cost, sonnet_cost)

    def test_unknown_model_raises_not_silently_zero(self):
        with self.assertRaises(UnknownModelPricingError):
            estimate_cost_usd("claude-does-not-exist", input_tokens=1_000_000)


class TestEstimateCostFromResponse(unittest.TestCase):
    def test_pulls_all_fields_from_real_shaped_usage(self):
        usage = SimpleNamespace(
            input_tokens=105, output_tokens=6039,
            cache_read_input_tokens=7123, cache_creation_input_tokens=7345,
            server_tool_use=SimpleNamespace(web_search_requests=1),
        )
        response = SimpleNamespace(usage=usage)
        cost = estimate_cost_from_response("claude-sonnet-5", response)
        expected = estimate_cost_usd(
            "claude-sonnet-5", input_tokens=105, output_tokens=6039,
            cache_read_input_tokens=7123, cache_creation_input_tokens=7345,
            server_tool_use_web_search_requests=1,
        )
        self.assertAlmostEqual(cost, expected, places=6)

    def test_missing_usage_returns_zero(self):
        self.assertEqual(estimate_cost_from_response("claude-sonnet-5", SimpleNamespace(usage=None)), 0.0)

    def test_missing_server_tool_use_defaults_to_zero_searches(self):
        usage = SimpleNamespace(input_tokens=100, output_tokens=50, cache_read_input_tokens=0,
                                 cache_creation_input_tokens=0, server_tool_use=None)
        response = SimpleNamespace(usage=usage)
        cost = estimate_cost_from_response("claude-sonnet-5", response)
        expected = estimate_cost_usd("claude-sonnet-5", input_tokens=100, output_tokens=50)
        self.assertAlmostEqual(cost, expected, places=6)


if __name__ == "__main__":
    unittest.main()
