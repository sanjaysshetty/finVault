"""
AgentRecommendationsTable write helper.

Key shape (template.yaml): PK=accountId, SK="REC#<recId>" for the header,
"REC#<recId>#SCENARIO#<ts>" for each scenario run — see the Part 5/6 plan
§6.4. This module only handles the header write path (Opportunity Engine
creates new recommendations); Deep Dive's scenario-run/approval writes
land with that surface in a later phase.
"""

import datetime
import uuid
from decimal import Decimal


def _to_decimal(obj):
    """boto3's DynamoDB resource API rejects native floats (requires
    Decimal) — recursively convert so callers can build plain dicts with
    ordinary numbers, the same way the rest of this codebase's business
    logic already does."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: _to_decimal(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_decimal(v) for v in obj]
    return obj


def put_recommendation(
    table,
    account_id,
    *,
    ticker,
    strategy_type,
    strategy_detail,
    tower1_context,
    tower2_research,
    rationale,
    rank_score,
    probability_of_profit,
    source="opportunity_engine_scan",
):
    """Writes a new recommendation header with status=NEW. Returns the
    generated recommendationId."""
    recommendation_id = str(uuid.uuid4())
    now = datetime.datetime.utcnow().isoformat() + "Z"
    item = _to_decimal({
        "accountId": account_id,
        "sk": f"REC#{recommendation_id}",
        "recommendationId": recommendation_id,
        "status": "NEW",
        "source": source,
        "ticker": ticker,
        "strategyType": strategy_type,
        "strategyDetail": strategy_detail,
        "tower1Context": tower1_context,
        "tower2Research": tower2_research,
        "rationale": rationale,
        "rankScore": rank_score,
        "probabilityOfProfit": probability_of_profit,
        "createdAt": now,
        "updatedAt": now,
    })
    table.put_item(Item=item)
    return recommendation_id
