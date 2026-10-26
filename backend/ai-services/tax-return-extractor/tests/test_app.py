"""
Unit tests for tax-return-extractor/app.py -- mime guessing, the
accountId/year/docId key-parsing + skip conditions, the merge-preserves-
manual-edits logic, PII redaction wiring, and the schema-minimization
guarantee (no SCHEMAS entry ever asks for an SSN/EIN field).

Run with: python3 -m unittest discover -s tests -v
(from backend/ai-services/tax-return-extractor/, with the finvault_agent_core
layer and this directory both on PYTHONPATH)
"""

import unittest
from unittest.mock import MagicMock, patch

import app


class TestGuessMimeType(unittest.TestCase):
    def test_trusts_non_octet_stream_content_type(self):
        self.assertEqual(app.guess_mime_type("image/png", "foo.bin"), "image/png")

    def test_falls_back_to_extension_when_octet_stream(self):
        self.assertEqual(app.guess_mime_type("application/octet-stream", "foo.pdf"), "application/pdf")
        self.assertEqual(app.guess_mime_type(None, "foo.jpg"), "image/jpeg")
        self.assertEqual(app.guess_mime_type(None, "foo.png"), "image/png")

    def test_unknown_extension_returns_octet_stream(self):
        self.assertEqual(app.guess_mime_type(None, "foo.xyz"), "application/octet-stream")


class TestSchemaMinimization(unittest.TestCase):
    def test_no_schema_requests_ssn_or_ein(self):
        banned_substrings = ["ssn", "social security number", "ein", "tax id", "taxpayer id"]
        for doc_type, schema in app.SCHEMAS.items():
            for field_name, field_def in schema["fields"].items():
                haystack = (field_name + " " + str(field_def.get("description", ""))).lower()
                for banned in banned_substrings:
                    self.assertNotIn(banned, haystack, f"{doc_type}.{field_name} looks like it captures {banned}")


def _s3_record(key, bucket="tax-docs-bucket"):
    return {"s3": {"bucket": {"name": bucket}, "object": {"key": key}}}


class TestProcessRecord(unittest.TestCase):
    def test_skips_unexpected_key_format(self):
        table = MagicMock()
        result = app.process_record(table, _s3_record("too/short"))
        self.assertEqual(result["reason"], "unexpected-key-format")
        table.get_item.assert_not_called()

    def test_skips_when_no_ddb_record(self):
        table = MagicMock()
        table.get_item.return_value = {}
        result = app.process_record(table, _s3_record("acct1/2026/doc1/file.pdf"))
        self.assertEqual(result["reason"], "no-ddb-record")

    def test_skips_unknown_doc_type(self):
        table = MagicMock()
        table.get_item.return_value = {"Item": {"docType": "SOMETHING_WEIRD"}}
        result = app.process_record(table, _s3_record("acct1/2026/doc1/file.pdf"))
        self.assertEqual(result["reason"], "unknown-docType:SOMETHING_WEIRD")

    @patch.object(app, "s3")
    def test_skips_unsupported_mime(self, mock_s3):
        table = MagicMock()
        table.get_item.return_value = {"Item": {"docType": "W2"}}
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: b"data"), "ContentType": "text/plain"}
        result = app.process_record(table, _s3_record("acct1/2026/doc1/file.txt"))
        self.assertTrue(result["reason"].startswith("unsupported-mime"))

    @patch.object(app, "extract_with_claude")
    @patch.object(app, "s3")
    def test_merge_preserves_manual_nonnull_and_s3key(self, mock_s3, mock_extract):
        table = MagicMock()
        existing_item = {
            "userId": "acct1",
            "assetId": "TAX_DOC#2026#doc1",
            "docType": "W2",
            "data": {"employer": "Manually Entered Corp", "wages": 1000.0, "s3Key": "acct1/2026/doc1/w2.pdf"},
        }
        table.get_item.return_value = {"Item": existing_item}
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: b"pdf-bytes"), "ContentType": "application/pdf"}
        # Claude returns employer=None (couldn't read it) and a new wages figure.
        mock_extract.return_value = {"employer": None, "wages": 55000.0, "federalWithheld": 4000.0}

        result = app.process_record(table, _s3_record("acct1/2026/doc1/w2.pdf"))

        self.assertTrue(result["ok"])
        written = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(written["data"]["employer"], "Manually Entered Corp")  # null extraction didn't overwrite
        self.assertEqual(float(written["data"]["wages"]), 55000.0)  # non-null extraction did overwrite
        self.assertEqual(written["data"]["s3Key"], "acct1/2026/doc1/w2.pdf")  # preserved
        self.assertEqual(written["status"], "extracted")

    @patch.object(app, "redact_json")
    @patch.object(app, "extract_with_claude")
    @patch.object(app, "s3")
    def test_applies_post_extraction_redaction(self, mock_s3, mock_extract, mock_redact):
        table = MagicMock()
        table.get_item.return_value = {"Item": {"userId": "acct1", "assetId": "TAX_DOC#2026#doc1", "docType": "1099-INT", "data": {}}}
        mock_s3.get_object.return_value = {"Body": MagicMock(read=lambda: b"pdf-bytes"), "ContentType": "application/pdf"}
        mock_extract.return_value = {"payer": "Some Bank", "interestIncome": 12.5}
        mock_redact.return_value = {"payer": "Some Bank", "interestIncome": 12.5}

        app.process_record(table, _s3_record("acct1/2026/doc1/1099int.pdf"))

        mock_redact.assert_called_once_with({"payer": "Some Bank", "interestIncome": 12.5})

class TestExtractWithClaude(unittest.TestCase):
    @patch.object(app, "structured_call")
    @patch.object(app, "redact_image_pii")
    def test_pdf_skips_pre_call_redaction(self, mock_redact_image, mock_structured_call):
        mock_structured_call.return_value = {"payer": "Bank"}
        app.extract_with_claude(b"pdf-bytes", "application/pdf", "1099-INT", app.SCHEMAS["1099-INT"])
        mock_redact_image.assert_not_called()

    @patch.object(app, "structured_call")
    @patch.object(app, "redact_image_pii")
    def test_image_runs_pre_call_redaction(self, mock_redact_image, mock_structured_call):
        mock_redact_image.return_value = b"redacted-bytes"
        mock_structured_call.return_value = {"payer": "Bank"}
        app.extract_with_claude(b"image-bytes", "image/png", "1099-INT", app.SCHEMAS["1099-INT"])
        mock_redact_image.assert_called_once_with(b"image-bytes", "image/png")


class TestHandler(unittest.TestCase):
    def test_no_records_returns_zero_processed(self):
        result = app.handler({})
        self.assertEqual(result["processed"], 0)

    @patch.object(app, "require_env", return_value="FinAssets")
    @patch.object(app, "dynamodb")
    @patch.object(app, "process_record", side_effect=RuntimeError("boom"))
    def test_per_record_failure_does_not_abort_other_records(self, mock_process, mock_ddb, mock_env):
        event = {"Records": [_s3_record("acct1/2026/doc1/a.pdf"), _s3_record("acct1/2026/doc2/b.pdf")]}
        result = app.handler(event)
        self.assertTrue(result["ok"])
        self.assertEqual(len(result["results"]), 2)
        self.assertFalse(result["results"][0]["ok"])
        self.assertIn("boom", result["results"][0]["error"])


if __name__ == "__main__":
    unittest.main()
