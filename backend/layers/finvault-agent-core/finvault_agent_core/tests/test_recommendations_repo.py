"""
Unit tests for recommendations_repo.py — specifically that floats get
converted to Decimal before being handed to boto3's DynamoDB resource
API (which raises TypeError on a native float), since every upstream
number here (scenario_math output, rank scores, probabilities) is a
plain Python float. Also covers the read/update paths Deep Dive needs
(get_recommendation_with_history, put_scenario_run, update_status).

Run with: python3 -m unittest finvault_agent_core.tests.test_recommendations_repo -v
(from backend/layers/finvault-agent-core/)
"""

import unittest
from decimal import Decimal
from unittest.mock import MagicMock

from finvault_agent_core.recommendations_repo import (
    _to_decimal,
    get_recommendation_with_history,
    mark_calibration_evaluated,
    put_recommendation,
    query_by_status,
    put_scenario_run,
    update_status,
)


class TestToDecimal(unittest.TestCase):
    def test_converts_float(self):
        self.assertEqual(_to_decimal(1.5), Decimal("1.5"))

    def test_leaves_int_and_str_unchanged(self):
        self.assertEqual(_to_decimal(5), 5)
        self.assertEqual(_to_decimal("hello"), "hello")

    def test_recurses_into_nested_dict(self):
        result = _to_decimal({"a": 1.5, "b": {"c": 2.25}})
        self.assertEqual(result, {"a": Decimal("1.5"), "b": {"c": Decimal("2.25")}})

    def test_recurses_into_list(self):
        result = _to_decimal([1.1, {"x": 2.2}, "keep"])
        self.assertEqual(result, [Decimal("1.1"), {"x": Decimal("2.2")}, "keep"])


class TestPutRecommendation(unittest.TestCase):
    def test_writes_item_with_expected_shape_and_no_native_floats(self):
        table = MagicMock()

        rec_id = put_recommendation(
            table, "acct1",
            ticker="AAPL",
            strategy_type="LONG_EQUITY",
            strategy_detail=[{"type": "STOCK", "side": "LONG", "qty": 100, "entry_price": 150.5}],
            tower1_context={"investor_profile": {"riskTolerance": "Moderate"}},
            tower2_research={"market_rationale": "strong fundamentals"},
            rationale="fits portfolio, strong fundamentals",
            rank_score=85,
            probability_of_profit=0.62,
        )

        self.assertTrue(table.put_item.called)
        item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["accountId"], "acct1")
        self.assertEqual(item["sk"], f"REC#{rec_id}")
        self.assertEqual(item["status"], "NEW")
        self.assertEqual(item["ticker"], "AAPL")
        self.assertEqual(item["probabilityOfProfit"], Decimal("0.62"))
        self.assertEqual(item["strategyDetail"][0]["entry_price"], Decimal("150.5"))

        def _assert_no_float(obj):
            if isinstance(obj, float):
                self.fail(f"native float leaked into DynamoDB item: {obj}")
            if isinstance(obj, dict):
                for v in obj.values():
                    _assert_no_float(v)
            if isinstance(obj, list):
                for v in obj:
                    _assert_no_float(v)

        _assert_no_float(item)


class TestGetRecommendationWithHistory(unittest.TestCase):
    def test_splits_header_from_scenario_runs(self):
        table = MagicMock()
        table.query.return_value = {
            "Items": [
                {"sk": "REC#abc", "status": "NEW"},
                {"sk": "REC#abc#SCENARIO#2026-01-01T00:00:00Z", "ranAt": "2026-01-01T00:00:00Z"},
                {"sk": "REC#abc#SCENARIO#2026-01-02T00:00:00Z", "ranAt": "2026-01-02T00:00:00Z"},
            ]
        }
        header, runs = get_recommendation_with_history(table, "acct1", "abc")
        self.assertEqual(header["sk"], "REC#abc")
        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0]["ranAt"], "2026-01-01T00:00:00Z")  # sorted ascending

    def test_returns_none_header_when_not_found(self):
        table = MagicMock()
        table.query.return_value = {"Items": []}
        header, runs = get_recommendation_with_history(table, "acct1", "missing")
        self.assertIsNone(header)
        self.assertEqual(runs, [])


class TestPutScenarioRun(unittest.TestCase):
    def test_writes_scenario_item_and_updates_status(self):
        table = MagicMock()
        scenario_id = put_scenario_run(
            table, "acct1", "abc",
            scenario_input={"scenario_type": "price_move", "price_move_pct": 0.1},
            scenario_output={"pnl": 500.0},
            narrative_summary="Modest upside case",
        )
        self.assertTrue(table.put_item.called)
        item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["recommendationId"], "abc")
        self.assertEqual(item["scenarioId"], scenario_id)
        self.assertTrue(item["sk"].startswith("REC#abc#SCENARIO#"))
        self.assertEqual(item["scenarioOutput"]["pnl"], Decimal("500.0"))
        # best-effort status transition attempted
        self.assertTrue(table.update_item.called)

    def test_survives_status_update_failure(self):
        table = MagicMock()
        table.update_item.side_effect = Exception("ConditionalCheckFailedException")
        # must not raise even though the status transition failed
        scenario_id = put_scenario_run(
            table, "acct1", "abc",
            scenario_input={}, scenario_output={"pnl": 0.0},
        )
        self.assertIsNotNone(scenario_id)


class TestUpdateStatus(unittest.TestCase):
    def test_updates_status_and_extra_fields(self):
        table = MagicMock()
        update_status(table, "acct1", "abc", "APPROVED", extra_fields={"approvalSnapshot": {"ticker": "AAPL"}})

        call_kwargs = table.update_item.call_args.kwargs
        self.assertEqual(call_kwargs["Key"], {"accountId": "acct1", "sk": "REC#abc"})
        self.assertEqual(call_kwargs["ExpressionAttributeValues"][":status"], "APPROVED")
        self.assertEqual(call_kwargs["ExpressionAttributeValues"][":approvalSnapshot"], {"ticker": "AAPL"})

    def test_raises_on_missing_recommendation(self):
        table = MagicMock()
        table.update_item.side_effect = Exception("ConditionalCheckFailedException")
        with self.assertRaises(Exception):
            update_status(table, "acct1", "missing", "APPROVED")


class TestQueryByStatus(unittest.TestCase):
    def test_paginates_until_no_last_evaluated_key(self):
        table = MagicMock()
        table.query.side_effect = [
            {"Items": [{"recommendationId": "a"}], "LastEvaluatedKey": {"sk": "x"}},
            {"Items": [{"recommendationId": "b"}]},
        ]
        items = query_by_status(table, "APPROVED")
        self.assertEqual(len(items), 2)
        self.assertEqual(table.query.call_count, 2)
        self.assertEqual(table.query.call_args_list[0].kwargs["IndexName"], "StatusIndex")

    def test_single_page(self):
        table = MagicMock()
        table.query.return_value = {"Items": [{"recommendationId": "a"}]}
        items = query_by_status(table, "EXPIRED")
        self.assertEqual(len(items), 1)
        self.assertEqual(table.query.call_count, 1)


class TestMarkCalibrationEvaluated(unittest.TestCase):
    def test_sets_outcome_fields_without_touching_status(self):
        table = MagicMock()
        mark_calibration_evaluated(
            table, "acct1", "abc",
            outcome={"realized_pnl": 123.45, "realized_win": True, "source": "paper_trade_fill"},
        )
        call_kwargs = table.update_item.call_args.kwargs
        self.assertEqual(call_kwargs["Key"], {"accountId": "acct1", "sk": "REC#abc"})
        self.assertNotIn(":status", call_kwargs["ExpressionAttributeValues"])
        self.assertTrue(call_kwargs["ExpressionAttributeValues"][":calibrationEvaluated"])
        self.assertEqual(call_kwargs["ExpressionAttributeValues"][":realizedPnl"], Decimal("123.45"))
        self.assertTrue(call_kwargs["ExpressionAttributeValues"][":realizedWin"])


if __name__ == "__main__":
    unittest.main()
