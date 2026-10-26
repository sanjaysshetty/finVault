"""
PII redaction helpers for receipt/tax document extraction (Part 5/6 plan
§6.7). Layered, not a single step:

  1. Schema minimization is the strongest control and lives in each
     extractor's own tool schema (never ask Claude for an SSN/EIN field
     unless there's a demonstrated need -- there isn't, for a net-worth
     tracker; confirmed with the user, default assumption is no SSN
     capture).
  2. redact_image_pii() -- best-effort PRE-CALL image redaction for tax
     documents specifically (the higher-risk document type). Textract
     locates SSN/EIN-shaped text regions; Pillow blacks them out before
     the main extraction call ever sees the image. Best-effort, not a
     guarantee -- a missed detection still sends the raw region. Image
     inputs only (JPEG/PNG); multi-page PDFs are a known, documented gap
     (Pillow can't open a PDF directly without poppler, which isn't
     available in this Lambda runtime).
  3. redact_text() / redact_json() -- POST-extraction output redaction,
     applied to whatever Claude returns before it's persisted or logged.
     Covers incidental PII leaking into a free-text field. Cheap enough
     to apply uniformly to both extractors even though receipt-extractor's
     own risk is much lower (card/loyalty numbers, not SSNs).
"""

import io
import logging
import re

logger = logging.getLogger(__name__)

SSN_PATTERN = re.compile(r"\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b")
EIN_PATTERN = re.compile(r"\b\d{2}-\d{7}\b")
# 8+ consecutive digits -- covers account/loyalty/card numbers. Deliberately
# NOT applied to structured numeric fields like productCode/UPC by callers
# of redact_text -- only to genuinely free-text fields (rawText, extracted
# descriptions) where a false-positive mask is a much smaller cost than a
# missed account number.
LONG_ACCOUNT_NUMBER_PATTERN = re.compile(r"\b\d{8,}\b")


def _mask_account(match):
    digits = match.group(0)
    return "*" * (len(digits) - 4) + digits[-4:]


def redact_text(text):
    """Masks SSN/EIN fully; long digit runs (8+) keep only the last 4.
    None or non-str input passes through unchanged."""
    if not isinstance(text, str) or not text:
        return text

    redacted = SSN_PATTERN.sub("[REDACTED-SSN]", text)
    redacted = EIN_PATTERN.sub("[REDACTED-EIN]", redacted)
    redacted = LONG_ACCOUNT_NUMBER_PATTERN.sub(_mask_account, redacted)
    return redacted


def redact_json(obj):
    """Recursively applies redact_text to every string leaf in a dict/list
    structure. Numbers/bools/None pass through untouched."""
    if isinstance(obj, dict):
        return {k: redact_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_json(v) for v in obj]
    if isinstance(obj, str):
        return redact_text(obj)
    return obj


def redact_image_pii(image_bytes, mime_type, textract_client=None):
    """Best-effort pre-call redaction for tax document IMAGES (JPEG/PNG
    only -- multi-page PDFs are a documented gap, not attempted here).
    Uses Textract to locate lines matching SSN/EIN patterns, then blacks
    out those regions with Pillow before the bytes ever reach Claude.

    Never raises -- any failure (unsupported format, Textract error,
    missing Pillow) logs a warning and returns the ORIGINAL bytes
    unmodified, the same degrade-gracefully posture used elsewhere in
    this codebase (e.g. tower1's Robinhood-unavailable fallback). This is
    defense-in-depth, not the only control -- schema minimization and
    post-extraction output redaction both still apply regardless of
    whether this step actually finds or redacts anything.
    """
    if mime_type not in ("image/jpeg", "image/png"):
        return image_bytes

    try:
        from PIL import Image, ImageDraw

        client = textract_client
        if client is None:
            import boto3

            client = boto3.client("textract")

        resp = client.detect_document_text(Document={"Bytes": image_bytes})

        hit_boxes = []
        for block in resp.get("Blocks", []):
            if block.get("BlockType") != "LINE":
                continue
            text = block.get("Text", "")
            if SSN_PATTERN.search(text) or EIN_PATTERN.search(text):
                bbox = block.get("Geometry", {}).get("BoundingBox")
                if bbox:
                    hit_boxes.append(bbox)

        if not hit_boxes:
            return image_bytes

        image = Image.open(io.BytesIO(image_bytes))
        width, height = image.size
        draw = ImageDraw.Draw(image)
        for bbox in hit_boxes:
            left = bbox["Left"] * width
            top = bbox["Top"] * height
            right = left + bbox["Width"] * width
            bottom = top + bbox["Height"] * height
            draw.rectangle([left, top, right, bottom], fill="black")

        out = io.BytesIO()
        image.save(out, format=image.format or "PNG")
        return out.getvalue()
    except Exception as e:
        logger.warning(f"Pre-call image PII redaction failed, proceeding with unredacted image: {e}")
        return image_bytes
