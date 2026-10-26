"""
Unit tests for tools.py — most importantly the hard enforcement that
write_ranked_recommendation's persisted probability_of_profit can only
ever be the value simulate_scenario actually computed, never trusted
from the model's own submitted number.

Run with: python3 -m unittest tests.test_tools -v
(from backend/ai-services/opportunity-engine/, with the finvault_agent_core
layer and this directory both on PYTHONPATH)
"""

import unittest

from tools import build_robinhood_mcp_server_config, build_tower2_tools, TOWER2_ROBINHOOD_ALLOWED_TOOLS


def _stock_leg():
    return {"type": "STOCK", "side": "LONG", "qty": 100, "entry_price": 100.0}


class TestProbabilityGrounding(unittest.TestCase):
    def setUp(self):
        self.state = {"last_scenario_result": None, "captured_recommendation": None}
        tools = build_tower2_tools(self.state)
        self.simulate = next(t for t in tools if t.name == "simulate_scenario")
        self.write_rec = next(t for t in tools if t.name == "write_ranked_recommendation")

    def test_write_before_simulate_raises(self):
        with self.assertRaises(ValueError):
            self.write_rec.fn(
                strategy_type="LONG_EQUITY", legs=[_stock_leg()],
                portfolio_fit_rationale="fits", market_rationale="strong",
                probability_of_profit=0.99, rank_score=90,
            )

    def test_price_move_scenario_has_no_probability_to_ground_against(self):
        self.simulate.fn(
            legs=[_stock_leg()], underlying_price=100, iv=0.25, days_to_expiry=30,
            scenario_type="price_move", price_move_pct=0.1,
        )
        with self.assertRaises(ValueError):
            self.write_rec.fn(
                strategy_type="LONG_EQUITY", legs=[_stock_leg()],
                portfolio_fit_rationale="fits", market_rationale="strong",
                probability_of_profit=0.99, rank_score=90,
            )

    def test_model_submitted_probability_is_overridden_not_trusted(self):
        self.simulate.fn(
            legs=[_stock_leg()], underlying_price=100, iv=0.25, days_to_expiry=30,
            scenario_type="expiry_distribution", monte_carlo_paths=2000, random_seed=1,
        )
        real_probability = self.state["last_scenario_result"]["probability_of_profit"]
        self.assertNotEqual(real_probability, 0.9999)  # sanity: the fake number below is distinguishable

        result = self.write_rec.fn(
            strategy_type="LONG_EQUITY", legs=[_stock_leg()],
            portfolio_fit_rationale="fits", market_rationale="strong",
            probability_of_profit=0.9999,  # model tries to lie / hallucinate
            rank_score=90,
        )

        self.assertEqual(result["probability_of_profit"], real_probability)
        self.assertEqual(self.state["captured_recommendation"]["probability_of_profit"], real_probability)
        self.assertNotEqual(self.state["captured_recommendation"]["probability_of_profit"], 0.9999)

    def test_successful_write_captures_full_recommendation(self):
        self.simulate.fn(
            legs=[_stock_leg()], underlying_price=100, iv=0.25, days_to_expiry=30,
            scenario_type="expiry_distribution", monte_carlo_paths=2000, random_seed=1,
        )
        self.write_rec.fn(
            strategy_type="LONG_EQUITY", legs=[_stock_leg()],
            portfolio_fit_rationale="fits portfolio", market_rationale="strong fundamentals",
            probability_of_profit=0.5, rank_score=85,
        )
        captured = self.state["captured_recommendation"]
        self.assertEqual(captured["strategy_type"], "LONG_EQUITY")
        self.assertEqual(captured["rank_score"], 85)
        self.assertIn("scenario_output", captured)
        self.assertEqual(captured["portfolio_fit_rationale"], "fits portfolio")

    def test_state_is_isolated_per_build_call(self):
        # Each candidate's Tower 2 run gets its own state dict -- verifies
        # build_tower2_tools doesn't leak state across candidates when run
        # concurrently (ThreadPoolExecutor in handler.py).
        state_a = {"last_scenario_result": None, "captured_recommendation": None}
        state_b = {"last_scenario_result": None, "captured_recommendation": None}
        tools_a = build_tower2_tools(state_a)
        tools_b = build_tower2_tools(state_b)

        sim_a = next(t for t in tools_a if t.name == "simulate_scenario")
        sim_a.fn(legs=[_stock_leg()], underlying_price=100, iv=0.25, days_to_expiry=30, scenario_type="expiry_distribution")

        self.assertIsNotNone(state_a["last_scenario_result"])
        self.assertIsNone(state_b["last_scenario_result"])


class TestToolMetadata(unittest.TestCase):
    def test_simulate_scenario_is_deterministic_compute(self):
        state = {"last_scenario_result": None, "captured_recommendation": None}
        tools = build_tower2_tools(state)
        simulate = next(t for t in tools if t.name == "simulate_scenario")
        self.assertEqual(simulate.category, "deterministic_compute")
        self.assertFalse(simulate.requires_confirmation)


class TestRobinhoodMcpServerConfig(unittest.TestCase):
    def test_no_mutating_tool_in_allowlist(self):
        mutating_prefixes = ("place_", "cancel_", "review_", "preview_", "exercise_", "decline_",
                             "create_", "update_", "delete_", "add_", "remove_", "follow_", "unfollow_")
        for tool_name in TOWER2_ROBINHOOD_ALLOWED_TOOLS:
            self.assertFalse(
                tool_name.startswith(mutating_prefixes),
                f"{tool_name} looks like a mutating tool and must not be in the Tower 2 allowlist",
            )

    def test_config_shape_matches_anthropic_beta_param(self):
        config = build_robinhood_mcp_server_config("fake-token")
        self.assertEqual(len(config), 1)
        entry = config[0]
        self.assertEqual(entry["type"], "url")
        self.assertEqual(entry["authorization_token"], "fake-token")
        self.assertTrue(entry["tool_configuration"]["enabled"])
        self.assertEqual(set(entry["tool_configuration"]["allowed_tools"]), set(TOWER2_ROBINHOOD_ALLOWED_TOOLS))


if __name__ == "__main__":
    unittest.main()
