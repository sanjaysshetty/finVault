"""
S3-triggered receipt extractor Lambda (images/PDFs) — Python port of the
original Node handler.js (Part 7 step 10).

receiptId format: <StoreName>_<MM-DD-YYYY>_<UniqueID>
Example: Costco_01-24-2026_feffa2087d299d5d

Required env vars:
  RECEIPT_LEDGER_TABLE
  CATEGORIZATION_FUNCTION

Secrets (fetched at runtime via finvault_agent_core.structured_call ->
client_factory.get_secret, not baked into env vars):
  /finvault/anthropic/api-key

Optional env vars:
  RECEIPT_KEY_PREFIX (default: receipts/ ; set to "" to disable prefix filtering)

Design change from the original Node version: category assignment is no
longer part of the same vision tool_use call that extracts line items.
It's a separate call to the shared CategorizationFunction (same taxonomy
category-curator already uses), which also means a successfully-categorized
item is written with needsCuration=False instead of always True — closing
one leg of the "needsCuration churn" where every receipt item used to get
reclassified again by the next curator batch run regardless of whether this
Lambda had already assigned something sensible. If the categorization call
fails, items fall back to "Miscellaneous / Other" with needsCuration=True so
curator's daily batch retries them later, rather than failing (and re-billing
the vision extraction call on Lambda retry) over a transient issue in a
separate service.

Summary rows (SUBTOTAL/TAX/TOTAL) are never curatable -- they get
needsCuration=False unconditionally. The original Node version set
needsCuration=True on these too, which meant category-curator's scan could
pick them up and overwrite their hardcoded "SUMMARY" category with a
guessed product category. Fixed here since this port already touches
every line of this write path.
"""

import hashlib
import json
import logging
import os
import re
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal

import boto3

from finvault_agent_core import structured_call, redact_text

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
lambda_client = boto3.client("lambda")
dynamodb = boto3.resource("dynamodb")

CATEGORIZATION_FUNCTION = os.environ.get("CATEGORIZATION_FUNCTION", "")
FALLBACK_CATEGORY = "Miscellaneous / Other"

with open(os.path.join(os.path.dirname(__file__), "prompts", "extract_receipt.md")) as f:
    SYSTEM_PROMPT = f.read()

RECEIPT_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "receipt": {
            "type": "object",
            "properties": {
                "store": {"type": ["string", "null"]},
                "purchaseDate": {"type": ["string", "null"], "description": "YYYY-MM-DD if present; otherwise null"},
                "currency": {"type": ["string", "null"], "description": "e.g., USD"},
            },
            "required": ["store", "purchaseDate", "currency"],
            "additionalProperties": False,
        },
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "lineId": {"type": "integer"},
                    "productCode": {"type": ["string", "null"]},
                    "productDescription": {"type": ["string", "null"]},
                    "amount": {"type": ["number", "null"]},
                    "rawText": {"type": ["string", "null"]},
                },
                "required": ["lineId", "productCode", "productDescription", "amount", "rawText"],
                "additionalProperties": False,
            },
        },
        "summaryLines": {
            "type": "array",
            "description": "Must include exactly: SUBTOTAL, TAX, TOTAL (amount can be null if missing).",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["SUBTOTAL", "TAX", "TOTAL"]},
                    "amount": {"type": ["number", "null"]},
                    "rawText": {"type": ["string", "null"]},
                },
                "required": ["type", "amount", "rawText"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["receipt", "lines", "summaryLines"],
    "additionalProperties": False,
}


def _to_decimal(obj):
    """boto3's DynamoDB resource API rejects native floats. Local copy, not
    shared with recommendations_repo.py's/job_cache.py's own copies --
    small, deliberate duplication to avoid cross-module coupling."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_decimal(v) for v in obj]
    return obj


def require_env(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v


def decode_s3_key(raw_key):
    return urllib.parse.unquote_plus(str(raw_key or ""))


def guess_mime_type(content_type, key):
    if content_type and "/" in content_type:
        return content_type
    lower = (key or "").lower()
    if lower.endswith(".png"):
        return "image/png"
    if lower.endswith(".webp"):
        return "image/webp"
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".pdf"):
        return "application/pdf"
    return "application/octet-stream"


def build_unique_id_from_s3(bucket, key):
    return hashlib.sha256(f"{bucket}:{key}".encode("utf-8")).hexdigest()[:16]


def simplify_store_name(store):
    raw = str(store or "").strip()
    if not raw:
        return "UnknownStore"

    upper = raw.upper()
    known = [
        ("COSTCO", "Costco"),
        ("WALMART", "Walmart"),
        ("WAL-MART", "Walmart"),
        ("TARGET", "Target"),
        ("KROGER", "Kroger"),
        ("WHOLE FOODS", "WholeFoods"),
        ("99", "99 Ranch"),
        ("HEB", "HEB"),
        ("H-E-B", "HEB"),
        ("TRIVENI", "Triveni"),
        ("IBC", "IBC"),
        ("KEEMAT", "Keemat"),
        ("ALDI", "Aldi"),
        ("TRADER JOE", "TraderJoes"),
        ("SAFEWAY", "Safeway"),
    ]
    for needle, name in known:
        if needle in upper:
            return name

    tokens = re.sub(r"[^a-zA-Z0-9 ]+", " ", raw).strip().split()
    if not tokens:
        return "UnknownStore"
    token = tokens[0]
    return token[0].upper() + token[1:].lower()


def format_receipt_date_mmddyyyy(purchase_date):
    s = str(purchase_date or "").strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", s)
    if not m:
        return "UnknownDate"
    yyyy, mm, dd = m.groups()
    return f"{mm}-{dd}-{yyyy}"


def get_current_date_yyyymmdd():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def is_yyyymmdd(value):
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", str(value or "").strip()))


def resolve_purchase_date(purchase_date):
    normalized = str(purchase_date or "").strip()
    if is_yyyymmdd(normalized):
        return normalized
    return get_current_date_yyyymmdd()


def build_receipt_id(store, purchase_date, unique_id):
    store_part = simplify_store_name(store)
    date_part = format_receipt_date_mmddyyyy(resolve_purchase_date(purchase_date))
    return f"{store_part}_{date_part}_{unique_id}"


def should_process_key(key):
    prefix = os.environ.get("RECEIPT_KEY_PREFIX", "receipts/")
    if prefix and not key.startswith(prefix):
        return False
    return True


def resolve_user_id_from_s3(bucket, key):
    try:
        head = s3.head_object(Bucket=bucket, Key=key)
        meta = head.get("Metadata") or {}
        if meta.get("userid"):
            return str(meta["userid"])
        if meta.get("userId"):
            return str(meta["userId"])
    except Exception as e:
        logger.info(f"HeadObject metadata lookup failed (continuing): {e}")

    parts = str(key or "").split("/")
    if "receipts" in parts:
        idx = parts.index("receipts")
        if idx + 1 < len(parts) and parts[idx + 1]:
            return parts[idx + 1]
    if len(parts) >= 2:
        return parts[1]
    return ""


def extract_receipt_from_image_bytes(image_bytes, mime_type):
    import base64

    b64 = base64.b64encode(image_bytes).decode("ascii")
    is_pdf = mime_type == "application/pdf"
    media_block = (
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
        if is_pdf
        else {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": b64}}
    )
    user_message = [
        media_block,
        {
            "type": "text",
            "text": "Extract all line items and summary totals from this receipt. "
            "Call the extract_receipt tool with the structured data.",
        },
    ]
    return structured_call(
        system_prompt=SYSTEM_PROMPT,
        user_message=user_message,
        output_schema=RECEIPT_TOOL_SCHEMA,
        tool_name="extract_receipt",
        tool_description="Output structured receipt data extracted from the receipt",
        max_tokens=4096,
    )


def categorize_items(items):
    """items: list of {storeName?, productDescription?, productCode?}.
    Raises on any failure -- the caller decides the fallback (default
    category + needsCuration=True so curator's daily batch retries later,
    rather than failing this receipt's whole write over a categorization
    hiccup)."""
    if not CATEGORIZATION_FUNCTION:
        raise RuntimeError("CATEGORIZATION_FUNCTION env var not configured")

    resp = lambda_client.invoke(
        FunctionName=CATEGORIZATION_FUNCTION,
        InvocationType="RequestResponse",
        Payload=json.dumps({"items": items}).encode("utf-8"),
    )
    payload = json.loads(resp["Payload"].read())
    if not payload.get("ok"):
        raise RuntimeError(f"Categorization service failed: {payload.get('error')}")
    return payload["categorizations"]


def normalize_summary_lines(summary_lines):
    base = {
        "SUBTOTAL": {"type": "SUBTOTAL", "amount": None, "rawText": None},
        "TAX": {"type": "TAX", "amount": None, "rawText": None},
        "TOTAL": {"type": "TOTAL", "amount": None, "rawText": None},
    }
    if isinstance(summary_lines, list):
        for s in summary_lines:
            t = (s or {}).get("type")
            if t in base:
                base[t] = {"type": t, "amount": s.get("amount"), "rawText": s.get("rawText")}
    return [base["SUBTOTAL"], base["TAX"], base["TOTAL"]]


def write_to_receipt_ledger_table(table, receipt_id, bucket, s3_key, extracted, categorizations, needs_curation, user_id):
    now = datetime.now(timezone.utc).isoformat()
    purchase_date = resolve_purchase_date((extracted.get("receipt") or {}).get("purchaseDate"))

    table.put_item(
        Item={
            "pk": f"RECEIPT#{receipt_id}",
            "sk": f"META#{receipt_id}",
            "receiptId": receipt_id,
            "userId": user_id,
            "date": purchase_date,
            "store": (extracted.get("receipt") or {}).get("store"),
            "currency": (extracted.get("receipt") or {}).get("currency") or "USD",
            "s3Bucket": bucket,
            "s3Key": s3_key,
            "status": "READY",
            "updatedAt": now,
        }
    )

    item_lines = extracted.get("lines") or []
    summary_lines = normalize_summary_lines(extracted.get("summaryLines"))

    with table.batch_writer() as batch:
        for idx, ln in enumerate(item_lines):
            line_id = ln.get("lineId") if isinstance(ln.get("lineId"), int) else idx + 1
            pk = f"RECEIPT#{receipt_id}"
            sk = f"ITEM#{str(line_id).zfill(4)}"
            category = (categorizations[idx] or {}).get("category", FALLBACK_CATEGORY) if idx < len(categorizations) else FALLBACK_CATEGORY
            item = _to_decimal(
                {
                    "pk": pk,
                    "sk": sk,
                    "receiptId": receipt_id,
                    "userId": user_id,
                    "date": purchase_date,
                    "productCode": ln.get("productCode"),
                    "productDescription": redact_text(ln.get("productDescription")),
                    "amount": ln.get("amount"),
                    "category": category,
                    "source": "scan",
                    "itemCount": 1,
                    "rawText": redact_text(ln.get("rawText")),
                    "updatedAt": now,
                    "needsCuration": needs_curation,
                    "curationKey": "CURATION",
                    "curationSort": f"NEEDS#{now}#{pk}#{sk}",
                }
            )
            batch.put_item(Item=item)

        for i, s in enumerate(summary_lines):
            pk = f"RECEIPT#{receipt_id}"
            sk = f"ITEM#9{str(i + 1).zfill(3)}"
            item = _to_decimal(
                {
                    "pk": pk,
                    "sk": sk,
                    "receiptId": receipt_id,
                    "userId": user_id,
                    "date": purchase_date,
                    "productCode": None,
                    "productDescription": s["type"],
                    "amount": s.get("amount"),
                    "category": "SUMMARY",
                    "source": "scan",
                    "itemCount": 1,
                    "rawText": redact_text(s.get("rawText")) or s["type"],
                    "updatedAt": now,
                    # Summary rows are never curatable -- no needsCuration/curationKey
                    # fields at all, so they can never enter curator's reclassification
                    # queue and have "SUMMARY" overwritten with a guessed category.
                    "needsCuration": False,
                }
            )
            batch.put_item(Item=item)


def mark_failed(table, receipt_id, bucket, s3_key, error_message, user_id):
    now = datetime.now(timezone.utc).isoformat()
    table.put_item(
        Item={
            "pk": f"RECEIPT#{receipt_id}",
            "sk": f"META#{receipt_id}",
            "receiptId": receipt_id,
            "userId": user_id or None,
            "s3Bucket": bucket,
            "s3Key": s3_key,
            "status": "FAILED",
            "error": str(error_message or "Unknown error")[:1000],
            "updatedAt": now,
        }
    )


def process_record(table, rec):
    bucket = (rec.get("s3") or {}).get("bucket", {}).get("name")
    key = decode_s3_key((rec.get("s3") or {}).get("object", {}).get("key"))

    if not bucket or not key:
        raise RuntimeError("Bad S3 event record: missing bucket or key")

    logger.info(f"Parsed S3 bucket/key: {bucket} {key}")

    if not should_process_key(key):
        logger.info(f"SKIPPED due to prefix filter. RECEIPT_KEY_PREFIX={os.environ.get('RECEIPT_KEY_PREFIX', 'receipts/')}")
        return {"ok": True, "skipped": True, "bucket": bucket, "key": key}

    unique_id = build_unique_id_from_s3(bucket, key)
    receipt_id = f"S3-{unique_id}"
    user_id = resolve_user_id_from_s3(bucket, key)

    try:
        obj = s3.get_object(Bucket=bucket, Key=key)
        body_bytes = obj["Body"].read()
        mime_type = guess_mime_type(obj.get("ContentType"), key)

        if mime_type != "application/pdf" and not mime_type.startswith("image/"):
            raise RuntimeError(f"Unsupported content type: {mime_type}. Expected an image or PDF.")

        extracted = extract_receipt_from_image_bytes(body_bytes, mime_type)

        store = (extracted.get("receipt") or {}).get("store")
        purchase_date = resolve_purchase_date((extracted.get("receipt") or {}).get("purchaseDate"))
        receipt_id = build_receipt_id(store, purchase_date, unique_id)

        item_lines = extracted.get("lines") or []
        cat_items = [
            {"storeName": store, "productDescription": ln.get("productDescription"), "productCode": ln.get("productCode")}
            for ln in item_lines
        ]
        try:
            categorizations = categorize_items(cat_items) if cat_items else []
            needs_curation = False
        except Exception as e:
            logger.warning(f"Categorization failed, falling back to '{FALLBACK_CATEGORY}' + needsCuration=True: {e}")
            categorizations = [{"category": FALLBACK_CATEGORY, "confidence": 0.0} for _ in item_lines]
            needs_curation = True

        write_to_receipt_ledger_table(table, receipt_id, bucket, key, extracted, categorizations, needs_curation, user_id)

        return {"ok": True, "receiptId": receipt_id, "bucket": bucket, "key": key, "userId": user_id, "lines": len(item_lines) + 3}
    except Exception as err:
        logger.error(f"FAILED: {err}", exc_info=True)
        mark_failed(table, receipt_id, bucket, key, str(err), user_id)
        raise


def handler(event, context=None):
    records = event.get("Records") or []
    if not records:
        raise RuntimeError("This Lambda is S3-triggered only. Expected an S3 ObjectCreated event.")

    table = dynamodb.Table(require_env("RECEIPT_LEDGER_TABLE"))

    results = [process_record(table, rec) for rec in records]
    return {"ok": True, "results": results}
