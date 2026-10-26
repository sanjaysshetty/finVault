"""
S3-triggered Lambda — Python port of the original Node app.js (Part 7
step 10). Fires when a user uploads a tax document to TaxDocsBucket.

Key format: {accountId}/{year}/{docId}/{filename}

Steps:
  1. Parse accountId / year / docId from the S3 key
  2. Look up the DynamoDB record to get docType
  3. Download the file from S3
  4. Best-effort pre-call PII redaction (image uploads only -- see
     finvault_agent_core.redaction.redact_image_pii's own docstring for
     the documented PDF gap) before the file ever reaches Claude
  5. Call Claude with a docType-specific tool_use schema
  6. Post-extraction output redaction (defense-in-depth, covers anything
     that leaked into a free-text field regardless of step 4's outcome)
  7. Merge extracted fields into the existing record, set status="extracted"

None of the SCHEMAS below ask for an SSN/EIN field -- that's the
strongest layer of this plan's PII redaction design (schema minimization):
finVault is a net-worth tracker, not a tax filer, and income/deduction/
employer figures are sufficient without ever prompting Claude for an SSN.

Required env vars:
  FIN_ASSETS_TABLE — finAssets DynamoDB table name

Secrets (fetched at runtime via finvault_agent_core.structured_call ->
client_factory.get_secret, not baked into env vars):
  /finvault/anthropic/api-key
"""

import logging
import os
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal

import boto3

from finvault_agent_core import structured_call, redact_image_pii, redact_json

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
dynamodb = boto3.resource("dynamodb")

with open(os.path.join(os.path.dirname(__file__), "prompts", "extract_tax_document.md")) as f:
    SYSTEM_PROMPT = f.read()

SCHEMAS = {
    "PAYSLIP": {
        "description": "employee pay stub / paycheck",
        "fields": {
            "employer": {"type": ["string", "null"], "description": "Employer name"},
            "payPeriodStart": {"type": ["string", "null"], "description": "Pay period start date YYYY-MM-DD"},
            "payPeriodEnd": {"type": ["string", "null"], "description": "Pay period end date YYYY-MM-DD"},
            "grossPay": {"type": ["number", "null"], "description": "Total gross wages before deductions"},
            "federalWithheld": {"type": ["number", "null"], "description": "Federal income tax withheld"},
            "ssWithheld": {"type": ["number", "null"], "description": "Social Security (OASDI) tax withheld"},
            "medicareWithheld": {"type": ["number", "null"], "description": "Medicare tax withheld"},
            "stateWithheld": {"type": ["number", "null"], "description": "State income tax withheld (0 for Texas)"},
        },
        "required": ["employer", "grossPay", "federalWithheld"],
    },
    "W2": {
        "description": "IRS Form W-2 Wage and Tax Statement",
        "fields": {
            "employer": {"type": ["string", "null"], "description": "Employer name (Box c)"},
            "wages": {"type": ["number", "null"], "description": "Box 1 — Wages, tips, other compensation"},
            "federalWithheld": {"type": ["number", "null"], "description": "Box 2 — Federal income tax withheld"},
            "ssWages": {"type": ["number", "null"], "description": "Box 3 — Social Security wages"},
            "ssWithheld": {"type": ["number", "null"], "description": "Box 4 — Social Security tax withheld"},
            "medicareWages": {"type": ["number", "null"], "description": "Box 5 — Medicare wages and tips"},
            "medicareWithheld": {"type": ["number", "null"], "description": "Box 6 — Medicare tax withheld"},
        },
        "required": ["employer", "wages", "federalWithheld"],
    },
    "1099-INT": {
        "description": "IRS Form 1099-INT Interest Income",
        "fields": {
            "payer": {"type": ["string", "null"], "description": "Payer name (bank or financial institution)"},
            "interestIncome": {"type": ["number", "null"], "description": "Box 1 — Interest income"},
            "federalWithheld": {"type": ["number", "null"], "description": "Box 4 — Federal income tax withheld (often 0)"},
        },
        "required": ["payer", "interestIncome"],
    },
    "1099-DIV": {
        "description": "IRS Form 1099-DIV Dividends and Distributions",
        "fields": {
            "payer": {"type": ["string", "null"], "description": "Payer name (brokerage or fund)"},
            "ordinaryDividends": {"type": ["number", "null"], "description": "Box 1a — Total ordinary dividends"},
            "qualifiedDividends": {"type": ["number", "null"], "description": "Box 1b — Qualified dividends (subset of ordinary)"},
            "federalWithheld": {"type": ["number", "null"], "description": "Box 4 — Federal income tax withheld"},
        },
        "required": ["payer", "ordinaryDividends", "qualifiedDividends"],
    },
    "1099-B": {
        "description": "IRS Form 1099-B Proceeds from Broker and Barter Exchange Transactions (summary totals, not individual trades)",
        "fields": {
            "payer": {"type": ["string", "null"], "description": "Brokerage name"},
            "shortTermProceeds": {"type": ["number", "null"], "description": "Total short-term proceeds (Box 1d aggregate)"},
            "shortTermBasis": {"type": ["number", "null"], "description": "Total short-term cost or other basis (Box 1e aggregate)"},
            "shortTermGain": {"type": ["number", "null"], "description": "Net short-term gain or loss (proceeds minus basis; negative = loss)"},
            "longTermProceeds": {"type": ["number", "null"], "description": "Total long-term proceeds"},
            "longTermBasis": {"type": ["number", "null"], "description": "Total long-term cost or other basis"},
            "longTermGain": {"type": ["number", "null"], "description": "Net long-term gain or loss (negative = loss)"},
        },
        "required": ["payer"],
    },
    "5498-SA": {
        "description": "IRS Form 5498-SA HSA, Archer MSA, or Medicare Advantage MSA Information",
        "fields": {
            "payer": {"type": ["string", "null"], "description": "HSA trustee or custodian name"},
            "hsaContributions": {"type": ["number", "null"], "description": "Box 2 — Total HSA contributions (employee + employer combined)"},
            "employerContributions": {"type": ["number", "null"], "description": "Box 9 — Employer contributions (may not appear; use 0 if not shown)"},
        },
        "required": ["payer", "hsaContributions"],
    },
    "1099-SA": {
        "description": "IRS Form 1099-SA Distributions from an HSA",
        "fields": {
            "payer": {"type": ["string", "null"], "description": "HSA trustee or custodian name"},
            "distributions": {"type": ["number", "null"], "description": "Box 1 — Gross distribution"},
            "qualifiedDistributions": {"type": ["number", "null"], "description": "Amount used for qualified medical expenses (not taxable); estimate if not printed"},
        },
        "required": ["payer", "distributions"],
    },
}


def _to_decimal(obj):
    """Local copy, same deliberate duplication precedent as
    recommendations_repo.py/job_cache.py/receipt-extractor's own copies."""
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


def guess_mime_type(content_type, key):
    if content_type and content_type != "application/octet-stream":
        return content_type
    lower = (key or "").lower()
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        return "image/jpeg"
    if lower.endswith(".png"):
        return "image/png"
    return "application/octet-stream"


def extract_with_claude(file_bytes, mime_type, doc_type, schema):
    import base64

    is_pdf = mime_type == "application/pdf"
    if not is_pdf:
        # Best-effort pre-call redaction -- image uploads only, see
        # redact_image_pii's own docstring for the documented PDF gap.
        file_bytes = redact_image_pii(file_bytes, mime_type)

    b64 = base64.b64encode(file_bytes).decode("ascii")
    media_block = (
        {"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64}}
        if is_pdf
        else {"type": "image", "source": {"type": "base64", "media_type": mime_type, "data": b64}}
    )
    input_schema = {"type": "object", "properties": schema["fields"], "required": schema["required"]}
    user_message = [
        media_block,
        {
            "type": "text",
            "text": f"This is a {schema['description']}. Extract all relevant fields and call "
            "the extract_tax_document tool with the structured data.",
        },
    ]
    return structured_call(
        system_prompt=SYSTEM_PROMPT,
        user_message=user_message,
        output_schema=input_schema,
        tool_name="extract_tax_document",
        tool_description=f"Extract structured data from a {schema['description']}",
        max_tokens=1024,
    )


def process_record(table, rec):
    bucket = rec["s3"]["bucket"]["name"]
    key = urllib.parse.unquote_plus(str(rec["s3"]["object"]["key"]))

    logger.info(f"Processing s3://{bucket}/{key}")

    # Key format: {accountId}/{year}/{docId}/{filename}
    parts = key.split("/")
    if len(parts) < 4:
        logger.info(f"Key format unexpected — skipping: {key}")
        return {"skipped": True, "reason": "unexpected-key-format", "key": key}
    account_id, year, doc_id = parts[0], parts[1], parts[2]

    resp = table.get_item(Key={"userId": account_id, "assetId": f"TAX_DOC#{year}#{doc_id}"})
    existing = resp.get("Item")
    if not existing:
        logger.info(f"No DDB record found — skipping: {key}")
        return {"skipped": True, "reason": "no-ddb-record", "key": key}

    doc_type = existing.get("docType")
    schema = SCHEMAS.get(doc_type)
    if not schema:
        logger.info(f'No extraction schema for docType="{doc_type}" — skipping')
        return {"skipped": True, "reason": f"unknown-docType:{doc_type}", "key": key}

    obj = s3.get_object(Bucket=bucket, Key=key)
    file_bytes = obj["Body"].read()
    mime_type = guess_mime_type(obj.get("ContentType"), key)
    logger.info(f"Downloaded {len(file_bytes)}B mimeType={mime_type} docType={doc_type}")

    if mime_type != "application/pdf" and not mime_type.startswith("image/"):
        logger.info(f"Unsupported mimeType — skipping: {mime_type}")
        return {"skipped": True, "reason": f"unsupported-mime:{mime_type}", "key": key}

    extracted = extract_with_claude(file_bytes, mime_type, doc_type, schema)
    extracted = redact_json(extracted)

    # Merge into existing data (preserves s3Key + any manual edits that
    # differ from extraction). Null-extracted fields do NOT overwrite
    # existing non-null manual values.
    merged_data = dict(existing.get("data") or {})
    for k, v in extracted.items():
        if v is not None:
            merged_data[k] = v
        elif k not in merged_data:
            merged_data[k] = None
    existing_s3_key = (existing.get("data") or {}).get("s3Key")
    if existing_s3_key:
        merged_data["s3Key"] = existing_s3_key

    updated_item = {
        **existing,
        "data": _to_decimal(merged_data),
        "status": "extracted",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }
    table.put_item(Item=updated_item)

    logger.info("DDB updated — status=extracted")
    return {"ok": True, "docType": doc_type, "docId": doc_id, "accountId": account_id, "fieldsExtracted": len(extracted)}


def handler(event, context=None):
    records = event.get("Records") or []
    if not records:
        logger.info("No S3 records — nothing to process")
        return {"ok": True, "processed": 0}

    table = dynamodb.Table(require_env("FIN_ASSETS_TABLE"))

    results = []
    for rec in records:
        try:
            results.append(process_record(table, rec))
        except Exception as err:
            # Don't rethrow -- log the failure and process remaining records,
            # same posture as the original Node version. The DLQ captures
            # this invocation's failure if all records fail.
            logger.error(f"processRecord failed: {err}", exc_info=True)
            results.append({"ok": False, "error": str(err)})

    return {"ok": True, "results": results}
