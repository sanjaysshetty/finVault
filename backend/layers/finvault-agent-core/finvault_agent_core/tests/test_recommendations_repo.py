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
    get_scan_run_for_week,
    put_recommendation,
    put_scan_run,
    put_scenario_run,
    put_screened_recommendation,
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


class TestPutScreenedRecommendation(unittest.TestCase):
    def test_writes_lightweight_record_without_tower2_fields(self):
        table = MagicMock()
        rec_id = put_screened_recommendation(
            table, "acct1",
            ticker="MSFT",
            fundamental_score=72,
            fundamentals_summary="MSFT (Microsoft, Technology): price $400, ...",
            note="Did not rank in the top N for deep-dive analysis.",
        )
        item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["sk"], f"REC#{rec_id}")
        self.assertEqual(item["status"], "SCREENED_ONLY")
        self.assertEqual(item["ticker"], "MSFT")
        self.assertEqual(item["fundamentalScore"], 72)
        # Absent, not None-filled -- a reader must not mistake this for a
        # deep-dived recommendation that merely found nothing.
        self.assertNotIn("tower2Research", item)
        self.assertNotIn("probabilityOfProfit", item)
        self.assertNotIn("strategyDetail", item)


class TestScanRun(unittest.TestCase):
    def test_put_then_get_round_trip(self):
        table = MagicMock()
        put_scan_run(table, "acct1", "2026-W44", status="IN_PROGRESS", universeSize=897)
        item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["sk"], "SCANRUN#2026-W44")
        self.assertEqual(item["weekKey"], "2026-W44")
        self.assertEqual(item["status"], "IN_PROGRESS")
        self.assertEqual(item["universeSize"], 897)

        table.get_item.return_value = {"Item": item}
        fetched = get_scan_run_for_week(table, "acct1", "2026-W44")
        self.assertEqual(fetched["status"], "IN_PROGRESS")
        call_kwargs = table.get_item.call_args.kwargs
        self.assertEqual(call_kwargs["Key"], {"accountId": "acct1", "sk": "SCANRUN#2026-W44"})

    def test_completion_overwrites_in_progress(self):
        table = MagicMock()
        put_scan_run(table, "acct1", "2026-W44", status="IN_PROGRESS")
        put_scan_run(table, "acct1", "2026-W44", status="COMPLETE", totalActualCostUsd=0.1823)
        final_item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(final_item["status"], "COMPLETE")
        self.assertEqual(final_item["totalActualCostUsd"], Decimal("0.1823"))

    def test_get_returns_none_when_no_scan_run_yet(self):
        table = MagicMock()
        table.get_item.return_value = {}
        self.assertIsNone(get_scan_run_for_week(table, "acct1", "2026-W44"))


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


if __name__ == "__main__":
    unittest.main()
