"""
Unit tests for receipt-extractor/app.py -- pure helpers, categorization
fallback behavior, and the full process_record orchestration against
mocked S3/Lambda/DynamoDB.

Run with: python3 -m unittest discover -s tests -v
(from backend/ai-services/receipt-extractor/, with the finvault_agent_core
layer and this directory both on PYTHONPATH)
"""

import json
import unittest
from unittest.mock import MagicMock, patch

import app


class TestSimplifyStoreName(unittest.TestCase):
    def test_recognizes_known_chain(self):
        self.assertEqual(app.simplify_store_name("COSTCO WHOLESALE #123"), "Costco")

    def test_falls_back_to_first_token_titlecased(self):
        self.assertEqual(app.simplify_store_name("randoMart general store"), "Randomart")

    def test_empty_store_returns_unknown(self):
        self.assertEqual(app.simplify_store_name(""), "UnknownStore")
        self.assertEqual(app.simplify_store_name(None), "UnknownStore")


class TestDateHelpers(unittest.TestCase):
    def test_format_valid_date(self):
        self.assertEqual(app.format_receipt_date_mmddyyyy("2026-01-24"), "01-24-2026")

    def test_format_invalid_date_returns_unknown(self):
        self.assertEqual(app.format_receipt_date_mmddyyyy("not-a-date"), "UnknownDate")

    def test_is_yyyymmdd(self):
        self.assertTrue(app.is_yyyymmdd("2026-01-24"))
        self.assertFalse(app.is_yyyymmdd("01/24/2026"))
        self.assertFalse(app.is_yyyymmdd(None))

    def test_resolve_purchase_date_valid_passes_through(self):
        self.assertEqual(app.resolve_purchase_date("2026-01-24"), "2026-01-24")

    def test_resolve_purchase_date_invalid_falls_back_to_today(self):
        result = app.resolve_purchase_date("garbage")
        self.assertTrue(app.is_yyyymmdd(result))


class TestBuildReceiptId(unittest.TestCase):
    def test_builds_expected_format(self):
        result = app.build_receipt_id("Costco Wholesale", "2026-01-24", "abc123")
        self.assertEqual(result, "Costco_01-24-2026_abc123")


class TestShouldProcessKey(unittest.TestCase):
    def test_accepts_matching_prefix(self):
        with patch.dict("os.environ", {"RECEIPT_KEY_PREFIX": "receipts/"}):
            self.assertTrue(app.should_process_key("receipts/u1/foo.jpg"))

    def test_rejects_non_matching_prefix(self):
        with patch.dict("os.environ", {"RECEIPT_KEY_PREFIX": "receipts/"}):
            self.assertFalse(app.should_process_key("other/u1/foo.jpg"))


class TestNormalizeSummaryLines(unittest.TestCase):
    def test_fills_missing_with_nulls_in_fixed_order(self):
        result = app.normalize_summary_lines([{"type": "TOTAL", "amount": 12.5, "rawText": "TOTAL 12.50"}])
        self.assertEqual([r["type"] for r in result], ["SUBTOTAL", "TAX", "TOTAL"])
        self.assertIsNone(result[0]["amount"])
        self.assertEqual(result[2]["amount"], 12.5)

    def test_handles_non_list_input(self):
        result = app.normalize_summary_lines(None)
        self.assertEqual(len(result), 3)


class TestCategorizeItems(unittest.TestCase):
    @patch.object(app, "CATEGORIZATION_FUNCTION", "arn:aws:lambda:fake")
    @patch.object(app, "lambda_client")
    def test_returns_categorizations_on_success(self, mock_lambda):
        mock_lambda.invoke.return_value = {
            "Payload": MagicMock(read=lambda: json.dumps({"ok": True, "categorizations": [{"category": "Groceries", "confidence": 0.9}]}).encode())
        }
        result = app.categorize_items([{"productDescription": "apples"}])
        self.assertEqual(result[0]["category"], "Groceries")

    @patch.object(app, "CATEGORIZATION_FUNCTION", "arn:aws:lambda:fake")
    @patch.object(app, "lambda_client")
    def test_raises_on_service_failure(self, mock_lambda):
        mock_lambda.invoke.return_value = {
            "Payload": MagicMock(read=lambda: json.dumps({"ok": False, "error": "boom"}).encode())
        }
        with self.assertRaises(RuntimeError):
            app.categorize_items([{"productDescription": "apples"}])

    @patch.object(app, "CATEGORIZATION_FUNCTION", "")
    def test_raises_if_not_configured(self):
        with self.assertRaises(RuntimeError):
            app.categorize_items([{"productDescription": "apples"}])


class TestWriteToReceiptLedgerTable(unittest.TestCase):
    def _run(self, categorizations, needs_curation):
        table = MagicMock()
        batch_cm = MagicMock()
        table.batch_writer.return_value.__enter__.return_value = batch_cm

        extracted = {
            "receipt": {"store": "Costco", "purchaseDate": "2026-01-24", "currency": "USD"},
            "lines": [
                {"lineId": 1, "productCode": "123", "productDescription": "Bananas", "amount": 3.5, "rawText": "BANANAS 3.50"},
            ],
            "summaryLines": [
                {"type": "SUBTOTAL", "amount": 3.5, "rawText": "SUBTOTAL 3.50"},
                {"type": "TAX", "amount": 0.3, "rawText": "TAX 0.30"},
                {"type": "TOTAL", "amount": 3.8, "rawText": "TOTAL 3.80"},
            ],
        }
        app.write_to_receipt_ledger_table(table, "Costco_01-24-2026_abc", "bucket", "key", extracted, categorizations, needs_curation, "user1")
        return table, batch_cm

    def test_item_line_gets_category_and_needs_curation_flag(self):
        _, batch_cm = self._run([{"category": "Produce", "confidence": 0.9}], False)
        item_call = batch_cm.put_item.call_args_list[0]
        item = item_call.kwargs["Item"]
        self.assertEqual(item["category"], "Produce")
        self.assertFalse(item["needsCuration"])

    def test_item_line_falls_back_to_misc_category_and_needs_curation_true(self):
        _, batch_cm = self._run([{"category": app.FALLBACK_CATEGORY, "confidence": 0.0}], True)
        item = batch_cm.put_item.call_args_list[0].kwargs["Item"]
        self.assertEqual(item["category"], app.FALLBACK_CATEGORY)
        self.assertTrue(item["needsCuration"])

    def test_summary_rows_never_curatable(self):
        _, batch_cm = self._run([{"category": "Produce", "confidence": 0.9}], False)
        # Items 2,3,4 (indices 1-3) are the 3 summary rows.
        for call in batch_cm.put_item.call_args_list[1:]:
            item = call.kwargs["Item"]
            self.assertEqual(item["category"], "SUMMARY")
            self.assertFalse(item["needsCuration"])
            self.assertNotIn("curationKey", item)

    def test_meta_row_written_separately(self):
        table, _ = self._run([{"category": "Produce", "confidence": 0.9}], False)
        meta_item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(meta_item["status"], "READY")
        self.assertEqual(meta_item["store"], "Costco")


class TestProcessRecord(unittest.TestCase):
    def _s3_record(self, bucket="my-bucket", key="receipts/u1/foo.jpg"):
        return {"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}

    @patch.object(app, "write_to_receipt_ledger_table")
    @patch.object(app, "categorize_items")
    @patch.object(app, "extract_receipt_from_image_bytes")
    @patch.object(app, "s3")
    def test_happy_path_writes_with_needs_curation_false(self, mock_s3, mock_extract, mock_categorize, mock_write):
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: b"fake-image-bytes"), "ContentType": "image/jpeg"}
        mock_s3.head_object.return_value = {"Metadata": {"userid": "user1"}}
        mock_extract.return_value = {
            "receipt": {"store": "Costco", "purchaseDate": "2026-01-24", "currency": "USD"},
            "lines": [{"lineId": 1, "productCode": "1", "productDescription": "Bananas", "amount": 3.5, "rawText": "x"}],
            "summaryLines": [],
        }
        mock_categorize.return_value = [{"category": "Produce", "confidence": 0.9}]

        table = MagicMock()
        result = app.process_record(table, self._s3_record())

        self.assertTrue(result["ok"])
        mock_write.assert_called_once()
        self.assertFalse(mock_write.call_args.args[6])  # needs_curation positional arg

    @patch.object(app, "mark_failed")
    @patch.object(app, "write_to_receipt_ledger_table")
    @patch.object(app, "categorize_items", side_effect=RuntimeError("categorization down"))
    @patch.object(app, "extract_receipt_from_image_bytes")
    @patch.object(app, "s3")
    def test_categorization_failure_falls_back_but_still_writes(self, mock_s3, mock_extract, mock_categorize, mock_write, mock_mark_failed):
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: b"fake-image-bytes"), "ContentType": "image/jpeg"}
        mock_s3.head_object.return_value = {"Metadata": {}}
        mock_extract.return_value = {
            "receipt": {"store": "Costco", "purchaseDate": "2026-01-24", "currency": "USD"},
            "lines": [{"lineId": 1, "productCode": "1", "productDescription": "Bananas", "amount": 3.5, "rawText": "x"}],
            "summaryLines": [],
        }

        table = MagicMock()
        result = app.process_record(table, self._s3_record())

        self.assertTrue(result["ok"])
        mock_write.assert_called_once()
        self.assertTrue(mock_write.call_args.args[5])  # needs_curation=True on fallback
        mock_mark_failed.assert_not_called()

    @patch.object(app, "mark_failed")
    @patch.object(app, "extract_receipt_from_image_bytes", side_effect=RuntimeError("vision call failed"))
    @patch.object(app, "s3")
    def test_extraction_failure_marks_failed_and_reraises(self, mock_s3, mock_extract, mock_mark_failed):
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: b"fake-image-bytes"), "ContentType": "image/jpeg"}
        mock_s3.head_object.return_value = {"Metadata": {}}

        table = MagicMock()
        with self.assertRaises(RuntimeError):
            app.process_record(table, self._s3_record())
        mock_mark_failed.assert_called_once()

    @patch.object(app, "s3")
    def test_skips_key_outside_prefix(self, mock_s3):
        table = MagicMock()
        with patch.dict("os.environ", {"RECEIPT_KEY_PREFIX": "receipts/"}):
            result = app.process_record(table, self._s3_record(key="other/u1/foo.jpg"))
        self.assertTrue(result["skipped"])
        mock_s3.get_object.assert_not_called()


if __name__ == "__main__":
    unittest.main()
