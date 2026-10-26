"""
Job-result cache — Python port of advisorCacheRepo.js's read/write-cache
pattern (30-minute TTL, keyed by a hash of the request), extended with
try_claim_job: the idempotency guard the Part 5/6 plan explicitly calls
out as a known, unfixed gap in Advisor's existing Node async worker (no
MaximumRetryAttempts configured, no in-progress marker — harmless at
single-shot-call volume, but a real double-billing/race risk once a
worker does multi-step tool calling, which Deep Dive's AgentLoop does).

Shared by Deep Dive's worker (and reusable by any future async-worker
Lambda that wants the same guard) rather than re-implemented per-service.
"""

import datetime
import time
from decimal import Decimal

from botocore.exceptions import ClientError

CACHE_TTL_SECONDS = 30 * 60


def _to_decimal(obj):
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_decimal(v) for v in obj]
    return obj


def read_cache(table, cache_key):
    if not table:
        return None
    try:
        resp = table.get_item(Key={"cacheKey": cache_key})
        return resp.get("Item")
    except Exception:
        return None


def write_cache(table, cache_key, data):
    if not table:
        return
    expires_at = int(time.time()) + CACHE_TTL_SECONDS
    item = _to_decimal({
        "cacheKey": cache_key,
        **data,
        "expiresAt": expires_at,
        "updatedAt": datetime.datetime.utcnow().isoformat() + "Z",
    })
    table.put_item(Item=item)


def try_claim_job(table, cache_key):
    """Conditional put: returns True if this invocation successfully
    claimed the job (no entry existed yet for this cacheKey), False if
    another invocation already claimed or completed it.

    Callers MUST bail out without calling Claude again when this returns
    False — that's the actual guard. Without a table configured, returns
    True unconditionally (can't enforce the guard, but doesn't block
    work either — matches the pre-existing behavior rather than
    introducing a new failure mode when misconfigured).
    """
    if not table:
        return True
    expires_at = int(time.time()) + CACHE_TTL_SECONDS
    try:
        table.put_item(
            Item={
                "cacheKey": cache_key,
                "status": "IN_PROGRESS",
                "startedAt": datetime.datetime.utcnow().isoformat() + "Z",
                "expiresAt": expires_at,
            },
            ConditionExpression="attribute_not_exists(cacheKey)",
        )
        return True
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "ConditionalCheckFailedException":
            return False
        raise
