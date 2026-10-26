"""
Unit tests for tower2_shared.py — the Robinhood allowlist/config and
simulate_scenario tool builder shared by Opportunity Engine and Deep Dive.

Run with: python3 -m unittest finvault_agent_core.tests.test_tower2_shared -v
(from backend/layers/finvault-agent-core/)
"""

import unittest

from finvault_agent_core.tower2_shared import (
    TOWER2_ROBINHOOD_ALLOWED_TOOLS,
    build_robinhood_mcp_server_config,
    build_simulate_scenario_tool,
)


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


class TestBuildSimulateScenarioTool(unittest.TestCase):
    def test_tool_is_deterministic_compute_and_not_confirmation_gated(self):
        state = {}
        tool = build_simulate_scenario_tool(state)
        self.assertEqual(tool.name, "simulate_scenario")
        self.assertEqual(tool.category, "deterministic_compute")
        self.assertFalse(tool.requires_confirmation)

    def test_fn_stashes_result_in_injected_state(self):
        state = {}
        tool = build_simulate_scenario_tool(state)
        tool.fn(
            legs=[{"type": "STOCK", "side": "LONG", "qty": 100, "entry_price": 100.0}],
            underlying_price=100, iv=0.25, days_to_expiry=30,
            scenario_type="expiry_distribution", monte_carlo_paths=1000, random_seed=1,
        )
        self.assertIn("last_scenario_result", state)
        self.assertIn("probability_of_profit", state["last_scenario_result"])

    def test_two_tools_with_separate_state_dont_interfere(self):
        state_a, state_b = {}, {}
        tool_a = build_simulate_scenario_tool(state_a)
        tool_a.fn(
            legs=[{"type": "STOCK", "side": "LONG", "qty": 100, "entry_price": 100.0}],
            underlying_price=100, iv=0.25, days_to_expiry=30, scenario_type="expiry_distribution",
        )
        self.assertIn("last_scenario_result", state_a)
        self.assertNotIn("last_scenario_result", state_b)


if __name__ == "__main__":
    unittest.main()
