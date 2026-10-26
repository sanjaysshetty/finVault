"""
Unit tests for Deep Dive's tools.py — save_scenario_run's recommendation-
creation-on-first-save behavior, and approve_scenario's HITL/staging
wiring, especially that a paper-trade-api staging failure doesn't lose
or block the approval decision itself.

Run with: python3 -m unittest tests.test_tools -v
(from backend/ai-services/deep-dive/, with the finvault_agent_core layer
and this directory both on PYTHONPATH)
"""

import json
import unittest
from unittest.mock import MagicMock, patch

from tools import build_deep_dive_tools


def _stock_leg(side="LONG"):
    return {"type": "STOCK", "side": side, "qty": 100, "entry_price": 100.0}


def _run_simulate(tools, **overrides):
    simulate = next(t for t in tools if t.name == "simulate_scenario")
    kwargs = dict(legs=[_stock_leg()], underlying_price=100, iv=0.25, days_to_expiry=30,
                  scenario_type="expiry_distribution", monte_carlo_paths=1000, random_seed=1)
    kwargs.update(overrides)
    simulate.fn(**kwargs)


class TestSaveScenarioRun(unittest.TestCase):
    def test_save_before_simulate_raises(self):
        state = {}
        tools = build_deep_dive_tools(state, MagicMock(), "acct1", None)
        save = next(t for t in tools if t.name == "save_scenario_run")
        with self.assertRaises(ValueError):
            save.fn(ticker="AAPL", strategy_type="LONG_EQUITY", legs=[_stock_leg()], narrative_summary="x")

    @patch("tools.put_scenario_run")
    @patch("tools.put_recommendation")
    def test_standalone_chat_creates_recommendation_on_first_save(self, mock_put_rec, mock_put_scenario):
        mock_put_rec.return_value = "new-rec-id"
        mock_put_scenario.return_value = "scenario-id"
        state = {}
        table = MagicMock()
        tools = build_deep_dive_tools(state, table, "acct1", None)
        _run_simulate(tools)

        save = next(t for t in tools if t.name == "save_scenario_run")
        result = save.fn(ticker="AAPL", strategy_type="LONG_EQUITY", legs=[_stock_leg()], narrative_summary="looks good")

        mock_put_rec.assert_called_once()
        self.assertEqual(mock_put_rec.call_args.kwargs["source"], "standalone_deep_dive")
        self.assertEqual(state["active_recommendation_id"], "new-rec-id")
        self.assertEqual(result["recommendationId"], "new-rec-id")

    @patch("tools.put_scenario_run")
    @patch("tools.put_recommendation")
    def test_preseeded_chat_reuses_existing_recommendation_not_creating_new(self, mock_put_rec, mock_put_scenario):
        mock_put_scenario.return_value = "scenario-id"
        state = {"active_recommendation_id": "existing-rec-id"}
        table = MagicMock()
        tools = build_deep_dive_tools(state, table, "acct1", None)
        _run_simulate(tools)

        save = next(t for t in tools if t.name == "save_scenario_run")
        result = save.fn(ticker="AAPL", strategy_type="LONG_EQUITY", legs=[_stock_leg()], narrative_summary="x")

        mock_put_rec.assert_not_called()
        self.assertEqual(result["recommendationId"], "existing-rec-id")


class TestApproveScenario(unittest.TestCase):
    def test_approve_before_save_raises(self):
        state = {}
        tools = build_deep_dive_tools(state, MagicMock(), "acct1", None)
        approve = next(t for t in tools if t.name == "approve_scenario")
        with self.assertRaises(ValueError):
            approve.fn(ticker="AAPL", strategy_type="LONG_EQUITY", legs=[_stock_leg()])

    @patch("tools.update_status")
    def test_approval_recorded_even_when_no_paper_trade_function_configured(self, mock_update_status):
        state = {"active_recommendation_id": "rec1", "last_scenario_result": {"probability_of_profit": 0.6}}
        tools = build_deep_dive_tools(state, MagicMock(), "acct1", None)  # paper_trade_api_function=None
        approve = next(t for t in tools if t.name == "approve_scenario")

        result = approve.fn(ticker="AAPL", strategy_type="LONG_EQUITY", legs=[_stock_leg()])

        mock_update_status.assert_called_once()
        self.assertEqual(mock_update_status.call_args.args[2], "rec1")
        self.assertEqual(mock_update_status.call_args.args[3], "APPROVED")
        self.assertTrue(result["approved"])
        self.assertEqual(result["stagedOrderCount"], 0)

    @patch("tools.update_status")
    @patch("tools._lambda")
    def test_approval_stages_order_via_paper_trade_api(self, mock_lambda, mock_update_status):
        mock_lambda.invoke.return_value = {
            "Payload": _payload_stream({"ok": True, "statusCode": 201, "body": {"tradeId": "PAPER_123"}})
        }
        state = {"active_recommendation_id": "rec1", "last_scenario_result": {"probability_of_profit": 0.6}}
        tools = build_deep_dive_tools(state, MagicMock(), "acct1", "PaperTradeApiFunctionArn")
        approve = next(t for t in tools if t.name == "approve_scenario")

        result = approve.fn(ticker="AAPL", strategy_type="LONG_EQUITY", legs=[_stock_leg()])

        mock_lambda.invoke.assert_called_once()
        invoke_payload = json.loads(mock_lambda.invoke.call_args.kwargs["Payload"])
        self.assertEqual(invoke_payload["source"], "deep-dive-approval")
        self.assertEqual(invoke_payload["accountId"], "acct1")
        self.assertEqual(invoke_payload["body"]["strategy"], "BUY_STOCK")
        self.assertEqual(invoke_payload["body"]["scanId"], "rec1")
        self.assertEqual(result["stagedOrderCount"], 1)
        self.assertIsNone(result["stagingError"])

    @patch("tools.update_status")
    @patch("tools._lambda")
    def test_staging_failure_does_not_block_or_lose_the_approval(self, mock_lambda, mock_update_status):
        mock_lambda.invoke.side_effect = RuntimeError("Lambda invoke failed")
        state = {"active_recommendation_id": "rec1", "last_scenario_result": {"probability_of_profit": 0.6}}
        tools = build_deep_dive_tools(state, MagicMock(), "acct1", "PaperTradeApiFunctionArn")
        approve = next(t for t in tools if t.name == "approve_scenario")

        result = approve.fn(ticker="AAPL", strategy_type="LONG_EQUITY", legs=[_stock_leg()])

        # status transition to APPROVED still happened -- the user's
        # decision is recorded regardless of the staging side effect.
        mock_update_status.assert_called_once()
        self.assertTrue(result["approved"])
        self.assertEqual(result["stagedOrderCount"], 0)
        self.assertIn("Lambda invoke failed", result["stagingError"])

    def test_unmapped_leg_combination_raises_clear_error(self):
        from tools import _stage_leg_via_paper_trade_api
        with self.assertRaises(ValueError):
            _stage_leg_via_paper_trade_api("fn", "acct1", "AAPL", {"type": "UNKNOWN", "side": "LONG", "qty": 1}, "rec1")


def _payload_stream(obj):
    class _Stream:
        def read(self):
            return json.dumps(obj).encode("utf-8")
    return _Stream()


if __name__ == "__main__":
    unittest.main()
