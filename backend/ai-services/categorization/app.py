"""
Categorization — the one shared categorization service (Part 5/6 plan,
migration order step 3).

Replaces 3 independently-drifted taxonomies with one: category-curator's
closed 10-category enum (strictly validated, the one actually "wins" in
production today since its daily batch run reclassifies everything last
regardless of what receipt-extractor or spending-api assigned first) is
adopted as the canonical set here — not a new taxonomy, to avoid a
disruptive retroactive recategorization of historical data or any
existing dashboard logic keyed to it.

Cuts over category-curator's batch job and spending-api's on-demand
/spending/categorize route (both call this Lambda directly, replacing
their own inline Claude calls). receipt-extractor's inline categorization
is deliberately NOT cut over yet — it categorizes as part of the same
vision tool_use call that extracts receipt line items, and decoupling
that is better done as part of receipt-extractor's own Python port
(Part 7 step 10), not bolted on here.

Uses StructuredCall (forced tool_choice + strict:true) instead of either
of the old free-text+regex approaches (both curator and spending-api had
one) — the exact gap this migration closes.
"""

import json
import logging
import os

from finvault_agent_core import structured_call
from finvault_agent_core.client_factory import MODELS

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

CATEGORIES = [
    "Groceries",
    "Dining & Takeout",
    "Household Supplies",
    "Personal Care",
    "Clothing & Footwear",
    "Home & Furniture",
    "Health & Pharmacy",
    "Electronics & Gadgets",
    "Transportation & Auto",
    "Miscellaneous / Other",
]

# Keep batches modest -- a single huge prompt both costs more per-item
# (larger context re-sent) and risks the model losing track of exact
# index alignment across hundreds of items in one shot.
MAX_BATCH_SIZE = 50

with open(os.path.join(os.path.dirname(__file__), "prompts", "categorize.md")) as f:
    SYSTEM_PROMPT = f.read()

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "categorizations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer", "description": "0-based index matching the input item's position"},
                    "category": {"type": "string", "enum": CATEGORIES},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["index", "category", "confidence"],
            },
        },
    },
    "required": ["categorizations"],
}


def _normalize_item(item):
    """Truncate to the same lengths category-curator's own normalizer
    used, so a very long description/store name can't blow out the
    batch prompt's size."""
    return {
        "storeName": str(item.get("storeName") or "")[:80],
        "productDescription": str(item.get("productDescription") or "")[:200],
        "productCode": str(item.get("productCode") or "")[:60],
    }


def categorize_batch(items, model=None):
    """items: list of {storeName?, productDescription?, productCode?}.
    Returns a list of {category, confidence} in the SAME order and
    length as the input -- callers index results positionally, not by
    re-reading the model's own stated index (that's only used internally
    to catch a misaligned/reordered response)."""
    if not items:
        return []

    results = [None] * len(items)
    for start in range(0, len(items), MAX_BATCH_SIZE):
        chunk = items[start : start + MAX_BATCH_SIZE]
        normalized = [_normalize_item(it) for it in chunk]
        user_message = json.dumps(
            [{"index": i, **n} for i, n in enumerate(normalized)],
            indent=2,
        )

        output = structured_call(
            system_prompt=SYSTEM_PROMPT,
            user_message=user_message,
            output_schema=OUTPUT_SCHEMA,
            tool_name="record_categorizations",
            tool_description="Record one category per item, in the same order as given.",
            model=model or MODELS["CATEGORIZATION"],
        )

        by_index = {c["index"]: c for c in output.get("categorizations", [])}
        for i in range(len(chunk)):
            c = by_index.get(i)
            global_idx = start + i
            if c is None:
                logger.warning(f"No categorization returned for batch-local index {i} (global {global_idx}) — defaulting to Miscellaneous / Other")
                results[global_idx] = {"category": "Miscellaneous / Other", "confidence": 0.0}
            else:
                results[global_idx] = {"category": c["category"], "confidence": c.get("confidence", 0.0)}

    return results


def handler(event, context=None):
    """Direct Lambda invoke only — no API Gateway route. Callers
    (CurateBatchFunction, SpendingApiFunction) invoke this synchronously
    (RequestResponse) and pass items=[{storeName?, productDescription?,
    productCode?}, ...]."""
    items = (event or {}).get("items") or []
    try:
        results = categorize_batch(items)
        return {"ok": True, "categorizations": results}
    except Exception as e:
        logger.error(f"Categorization batch failed: {e}", exc_info=True)
        return {"ok": False, "error": str(e)}
