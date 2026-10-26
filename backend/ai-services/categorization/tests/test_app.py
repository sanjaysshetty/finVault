"""
Unit tests for categorization/app.py — batch chunking/alignment, the
missing-categorization fallback, and the enum taxonomy being the one
category-curator already validates strictly in production (not a new
or different set of labels).

Run with: python3 -m unittest tests.test_app -v
(from backend/ai-services/categorization/, with the finvault_agent_core
layer and this directory both on PYTHONPATH)
"""

import unittest
from unittest.mock import patch

import app


class TestCategorizeBatch(unittest.TestCase):
    def test_empty_items_returns_empty_list(self):
        self.assertEqual(app.categorize_batch([]), [])

    @patch("app.structured_call")
    def test_single_batch_preserves_order(self, mock_call):
        mock_call.return_value = {
            "categorizations": [
                {"index": 0, "category": "Groceries", "confidence": 0.9},
                {"index": 1, "category": "Dining & Takeout", "confidence": 0.8},
            ]
        }
        items = [{"productDescription": "apples"}, {"productDescription": "burger"}]

        results = app.categorize_batch(items)

        self.assertEqual(len(results), 2)
        self.assertEqual(results[0]["category"], "Groceries")
        self.assertEqual(results[1]["category"], "Dining & Takeout")

    @patch("app.structured_call")
    def test_missing_index_defaults_to_miscellaneous(self, mock_call):
        # Model only returned a categorization for index 0 -- index 1 must
        # not be silently left as None or crash the caller.
        mock_call.return_value = {"categorizations": [{"index": 0, "category": "Groceries", "confidence": 0.9}]}
        items = [{"productDescription": "apples"}, {"productDescription": "???"}]

        results = app.categorize_batch(items)

        self.assertEqual(results[1]["category"], "Miscellaneous / Other")
        self.assertEqual(results[1]["confidence"], 0.0)

    @patch("app.structured_call")
    def test_splits_into_chunks_of_max_batch_size(self, mock_call):
        mock_call.return_value = {"categorizations": [{"index": i, "category": "Groceries", "confidence": 0.5} for i in range(app.MAX_BATCH_SIZE)]}
        items = [{"productDescription": f"item {i}"} for i in range(app.MAX_BATCH_SIZE + 5)]

        results = app.categorize_batch(items)

        self.assertEqual(len(results), app.MAX_BATCH_SIZE + 5)
        self.assertEqual(mock_call.call_count, 2)  # one full batch + one 5-item remainder

    @patch("app.structured_call")
    def test_passes_categorization_model_by_default(self, mock_call):
        mock_call.return_value = {"categorizations": [{"index": 0, "category": "Groceries", "confidence": 0.9}]}
        app.categorize_batch([{"productDescription": "apples"}])
        self.assertEqual(mock_call.call_args.kwargs["model"], app.MODELS["CATEGORIZATION"])

    @patch("app.structured_call")
    def test_truncates_overly_long_fields(self, mock_call):
        mock_call.return_value = {"categorizations": [{"index": 0, "category": "Groceries", "confidence": 0.9}]}
        app.categorize_batch([{"productDescription": "x" * 500}])
        user_message = mock_call.call_args.kwargs["user_message"]
        self.assertLess(len(user_message), 500)


class TestHandler(unittest.TestCase):
    @patch("app.categorize_batch")
    def test_success_shape(self, mock_batch):
        mock_batch.return_value = [{"category": "Groceries", "confidence": 0.9}]
        result = app.handler({"items": [{"productDescription": "apples"}]})
        self.assertTrue(result["ok"])
        self.assertEqual(result["categorizations"][0]["category"], "Groceries")

    @patch("app.categorize_batch", side_effect=RuntimeError("boom"))
    def test_failure_shape(self, mock_batch):
        result = app.handler({"items": [{"productDescription": "apples"}]})
        self.assertFalse(result["ok"])
        self.assertIn("boom", result["error"])

    def test_handles_missing_items_key(self):
        result = app.handler({})
        self.assertTrue(result["ok"])
        self.assertEqual(result["categorizations"], [])


class TestTaxonomy(unittest.TestCase):
    def test_canonical_categories_match_curators_existing_strict_enum(self):
        # These exact 10 strings are category-curator's existing,
        # strictly-validated CATEGORIES list -- adopted verbatim, not
        # redesigned, to avoid disrupting historical data/dashboards
        # already keyed to it.
        expected = [
            "Groceries", "Dining & Takeout", "Household Supplies", "Personal Care",
            "Clothing & Footwear", "Home & Furniture", "Health & Pharmacy",
            "Electronics & Gadgets", "Transportation & Auto", "Miscellaneous / Other",
        ]
        self.assertEqual(app.CATEGORIES, expected)

    def test_output_schema_enum_matches_categories(self):
        enum = app.OUTPUT_SCHEMA["properties"]["categorizations"]["items"]["properties"]["category"]["enum"]
        self.assertEqual(enum, app.CATEGORIES)


if __name__ == "__main__":
    unittest.main()
