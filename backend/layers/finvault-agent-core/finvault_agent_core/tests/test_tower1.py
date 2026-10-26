"""
Unit tests for tower1.py — most importantly that Robinhood's as-yet-unset-up
OAuth grant degrades gracefully (returns {"available": False}) rather than
crashing the whole engine run, and that non-Robinhood pieces (manual
holdings, investor profile) work independently of it. Lives in the shared
layer (not per-service) since both Opportunity Engine and Deep Dive build
on the identical Tower 1 snapshot.

Run with: python3 -m unittest finvault_agent_core.tests.test_tower1 -v
(from backend/layers/finvault-agent-core/)
"""

import unittest
from unittest.mock import MagicMock

from finvault_agent_core.robinhood_mcp import RobinhoodMcpError
from finvault_agent_core.tower1 import build_tower1_context, fetch_investor_profile, fetch_portfolio, fetch_robinhood_context


class TestFetchRobinhoodContext(unittest.TestCase):
    def test_degrades_gracefully_on_mcp_error(self):
        client = MagicMock()
        client.get_accounts.side_effect = RobinhoodMcpError("OAuth not set up yet")

        result = fetch_robinhood_context(client)

        self.assertEqual(result, {"available": False})

    def test_successful_fetch_returns_all_fields(self):
        client = MagicMock()
        client.get_accounts.return_value = {"accounts": ["a1"]}
        client.get_portfolio.return_value = {"cash": 1000}
        client.get_equity_positions.return_value = []
        client.get_option_positions.return_value = []
        client.get_crypto_positions.return_value = []
        client.get_realized_pnl.return_value = {"ytd": 500}

        result = fetch_robinhood_context(client)

        self.assertTrue(result["available"])
        self.assertEqual(result["portfolio"], {"cash": 1000})
        self.assertEqual(result["realized_pnl"], {"ytd": 500})


class TestFetchPortfolio(unittest.TestCase):
    def test_returns_empty_dict_when_table_missing(self):
        self.assertEqual(fetch_portfolio(None, "user1"), {})

    def test_returns_empty_dict_when_user_id_missing(self):
        table = MagicMock()
        self.assertEqual(fetch_portfolio(table, None), {})

    def test_groups_items_by_asset_type(self):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {"assetType": "STOCK_TX", "ticker": "AAPL", "qty": 10, "avgCost": 150},
                {"assetType": "BULLION_TX", "metal": "GOLD", "oz": 5},
                {"assetType": "FIXED_INCOME", "name": "T-Bill", "value": 1000},
            ]
        }

        result = fetch_portfolio(table, "user1")

        self.assertEqual(len(result["stocks"]), 1)
        self.assertEqual(result["stocks"][0]["ticker"], "AAPL")
        self.assertEqual(len(result["bullion"]), 1)
        self.assertEqual(result["total_invested"], 10 * 150 + 1000)

    def test_degrades_gracefully_on_query_exception(self):
        table = MagicMock()
        table.query.side_effect = RuntimeError("DynamoDB unavailable")
        self.assertEqual(fetch_portfolio(table, "user1"), {})


class TestFetchInvestorProfile(unittest.TestCase):
    def test_returns_default_when_table_missing(self):
        profile = fetch_investor_profile(None, "acct1")
        self.assertEqual(profile["riskTolerance"], "Moderate")

    def test_returns_default_when_no_profile_set(self):
        table = MagicMock()
        table.get_item.return_value = {"Item": {}}
        profile = fetch_investor_profile(table, "acct1")
        self.assertEqual(profile["riskTolerance"], "Moderate")
        self.assertIsNone(profile["netWorthGoal"])

    def test_returns_stored_profile(self):
        table = MagicMock()
        table.get_item.return_value = {
            "Item": {
                "investorProfile": {
                    "riskTolerance": "Aggressive",
                    "objective": "Aggressive Growth",
                    "timeHorizon": "10+ years",
                    "targetAnnualReturnPct": 20,
                    "netWorthGoal": {"amount": 1000000, "byYear": 2030},
                    "monthlyContribution": 2000,
                    "notes": "avoid tobacco",
                }
            }
        }
        profile = fetch_investor_profile(table, "acct1")
        self.assertEqual(profile["riskTolerance"], "Aggressive")
        self.assertEqual(profile["netWorthGoal"], {"amount": 1000000, "byYear": 2030})
        self.assertEqual(profile["notes"], "avoid tobacco")


class TestBuildTower1Context(unittest.TestCase):
    def test_full_context_with_robinhood_unavailable(self):
        robinhood_client = MagicMock()
        robinhood_client.get_accounts.side_effect = RobinhoodMcpError("not authorized")

        context = build_tower1_context(robinhood_client, None, None, "acct1")

        self.assertFalse(context["robinhood"]["available"])
        self.assertEqual(context["manual_holdings"], {})
        self.assertEqual(context["investor_profile"]["riskTolerance"], "Moderate")

    def test_full_context_with_no_robinhood_client_at_all(self):
        # handler.py passes robinhood_client=None when no access token exists yet.
        context = build_tower1_context(None, None, None, "acct1")
        self.assertFalse(context["robinhood"]["available"])


if __name__ == "__main__":
    unittest.main()
