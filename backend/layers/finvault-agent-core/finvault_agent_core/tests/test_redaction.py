"""
Unit tests for redaction.py -- SSN/EIN/account-number masking, recursive
JSON redaction, and best-effort pre-call image redaction (mocked Textract +
real Pillow round-trip, no network calls).

Run with: python3 -m unittest finvault_agent_core.tests.test_redaction -v
"""

import io
import unittest
from unittest.mock import MagicMock

from finvault_agent_core import redaction


class TestRedactText(unittest.TestCase):
    def test_masks_ssn_with_dashes(self):
        self.assertEqual(redaction.redact_text("SSN: 123-45-6789"), "SSN: [REDACTED-SSN]")

    def test_masks_bare_nine_digit_ssn(self):
        self.assertEqual(redaction.redact_text("id 123456789 on file"), "id [REDACTED-SSN] on file")

    def test_masks_ein(self):
        self.assertEqual(redaction.redact_text("EIN 12-3456789"), "EIN [REDACTED-EIN]")

    def test_masks_long_account_number_keeping_last_4(self):
        self.assertEqual(redaction.redact_text("card 4111111111111111"), "card ************1111")

    def test_leaves_short_numbers_alone(self):
        self.assertEqual(redaction.redact_text("qty 1234567"), "qty 1234567")

    def test_passes_through_non_string_unchanged(self):
        self.assertIsNone(redaction.redact_text(None))
        self.assertEqual(redaction.redact_text(42), 42)

    def test_passes_through_text_with_no_pii(self):
        self.assertEqual(redaction.redact_text("Organic Bananas"), "Organic Bananas")


class TestRedactJson(unittest.TestCase):
    def test_recurses_into_nested_structure(self):
        obj = {
            "payer": "First National Bank",
            "notes": ["acct 4111111111111111", "SSN 123-45-6789"],
            "amount": 1234.56,
            "withheld": None,
        }
        result = redaction.redact_json(obj)
        self.assertEqual(result["payer"], "First National Bank")
        self.assertEqual(result["notes"][0], "acct ************1111")
        self.assertEqual(result["notes"][1], "SSN [REDACTED-SSN]")
        self.assertEqual(result["amount"], 1234.56)
        self.assertIsNone(result["withheld"])


class TestRedactImagePii(unittest.TestCase):
    def test_passes_through_unsupported_mime_type(self):
        result = redaction.redact_image_pii(b"fake-pdf-bytes", "application/pdf")
        self.assertEqual(result, b"fake-pdf-bytes")

    def test_degrades_gracefully_on_textract_error(self):
        client = MagicMock()
        client.detect_document_text.side_effect = RuntimeError("Textract unavailable")
        original = b"not-a-real-image"
        result = redaction.redact_image_pii(original, "image/png", textract_client=client)
        self.assertEqual(result, original)

    def test_returns_original_when_no_pii_hits(self):
        from PIL import Image

        img = Image.new("RGB", (100, 50), color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        original = buf.getvalue()

        client = MagicMock()
        client.detect_document_text.return_value = {
            "Blocks": [{"BlockType": "LINE", "Text": "Acme Corp", "Geometry": {"BoundingBox": {}}}]
        }
        result = redaction.redact_image_pii(original, "image/png", textract_client=client)
        self.assertEqual(result, original)

    def test_blacks_out_region_matching_ssn(self):
        from PIL import Image

        img = Image.new("RGB", (200, 100), color="white")
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        original = buf.getvalue()

        client = MagicMock()
        client.detect_document_text.return_value = {
            "Blocks": [
                {
                    "BlockType": "LINE",
                    "Text": "SSN: 123-45-6789",
                    "Geometry": {"BoundingBox": {"Left": 0.1, "Top": 0.1, "Width": 0.3, "Height": 0.1}},
                }
            ]
        }
        result = redaction.redact_image_pii(original, "image/png", textract_client=client)
        self.assertNotEqual(result, original)

        redacted_img = Image.open(io.BytesIO(result))
        # Pixel in the middle of the reported bounding box should now be black.
        px = redacted_img.getpixel((int(0.25 * 200), int(0.15 * 100)))
        self.assertEqual(px[:3], (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
