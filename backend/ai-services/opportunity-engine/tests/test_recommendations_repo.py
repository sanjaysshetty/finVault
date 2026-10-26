"""
Unit tests for recommendations_repo.py — specifically that floats get
converted to Decimal before being handed to boto3's DynamoDB resource
API (which raises TypeError on a native float), since every upstream
number here (scenario_math output, rank scores, probabilities) is a
plain Python float.

Run with: python3 -m unittest tests.test_recommendations_repo -v
"""

import unittest
from decimal import Decimal
from unittest.mock import MagicMock

from recommendations_repo import _to_decimal, put_recommendation


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


if __name__ == "__main__":
    unittest.main()
