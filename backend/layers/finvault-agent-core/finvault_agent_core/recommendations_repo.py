"""
AgentRecommendationsTable read/write helper — shared by Opportunity
Engine (creates recommendations) and Deep Dive (reads one for the
pre-seeded entry path, creates one for the standalone entry path, records
scenario runs, and transitions status on approval).

Key shape (template.yaml): PK=accountId, SK="REC#<recId>" for the header,
"REC#<recId>#SCENARIO#<ts>" for each scenario run — see the Part 5/6 plan
§6.4. Mirrors the Node-side agentRecommendationsRepo.js (used by the
opportunity-engine-read API) in Python for the Lambdas that need direct
boto3 access rather than going through that HTTP route.
"""

import datetime
import uuid
from decimal import Decimal

from boto3.dynamodb.conditions import Key


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


def put_screened_recommendation(
    table,
    account_id,
    *,
    ticker,
    fundamental_score,
    fundamentals_summary,
    note,
    source="opportunity_engine_scan",
):
    """Lightweight record for a shortlisted-but-not-deep-dived candidate --
    zero Anthropic spend, since this candidate never went through Tower 2.
    No tower2Research/probabilityOfProfit/strategyDetail keys -- absent
    entirely, not None-filled, so a reader can't mistake this for a
    deep-dived recommendation that merely found nothing."""
    recommendation_id = str(uuid.uuid4())
    now = datetime.datetime.utcnow().isoformat() + "Z"
    item = _to_decimal({
        "accountId": account_id,
        "sk": f"REC#{recommendation_id}",
        "recommendationId": recommendation_id,
        "status": "SCREENED_ONLY",
        "source": source,
        "ticker": ticker,
        "fundamentalScore": fundamental_score,
        "fundamentalsSummary": fundamentals_summary,
        "note": note,
        "createdAt": now,
        "updatedAt": now,
    })
    table.put_item(Item=item)
    return recommendation_id


def put_scan_run(table, account_id, week_key, **fields):
    """Upsert the one ScanRun summary item per account+week -- written
    once at scan start (status=IN_PROGRESS) and once at completion
    (status=COMPLETE, with the final counts/cost). Not conditional --
    try_claim_job is the race-safe gate for whether a scan runs at all;
    this is just the human/UI-facing summary record, safely overwritten
    by whichever single invocation actually won that claim."""
    now = datetime.datetime.utcnow().isoformat() + "Z"
    item = _to_decimal({
        "accountId": account_id,
        "sk": f"SCANRUN#{week_key}",
        "weekKey": week_key,
        "updatedAt": now,
        **fields,
    })
    table.put_item(Item=item)
    return week_key


def get_scan_run_for_week(table, account_id, week_key):
    resp = table.get_item(Key={"accountId": account_id, "sk": f"SCANRUN#{week_key}"})
    return resp.get("Item")


def get_recommendation_with_history(table, account_id, recommendation_id):
    """Header plus every scenario-run item, in one query — exactly what the
    pre-seeded Deep Dive entry path (?recommendationId=) needs to resume
    work on an existing opportunity. Returns (header, scenario_runs);
    header is None if not found."""
    resp = table.query(
        KeyConditionExpression=Key("accountId").eq(account_id) & Key("sk").begins_with(f"REC#{recommendation_id}"),
    )
    items = resp.get("Items", [])
    header = next((it for it in items if it["sk"] == f"REC#{recommendation_id}"), None)
    scenario_runs = [it for it in items if it["sk"] != f"REC#{recommendation_id}"]
    scenario_runs.sort(key=lambda it: it.get("ranAt", ""))
    return header, scenario_runs


def put_scenario_run(table, account_id, recommendation_id, *, scenario_input, scenario_output, narrative_summary=None):
    """Records one simulate_scenario call under a recommendation (standalone
    or pre-seeded) — the history save_scenario_run persists."""
    scenario_id = str(uuid.uuid4())
    now = datetime.datetime.utcnow().isoformat() + "Z"
    item = _to_decimal({
        "accountId": account_id,
        "sk": f"REC#{recommendation_id}#SCENARIO#{now}",
        "recommendationId": recommendation_id,
        "scenarioId": scenario_id,
        "ranAt": now,
        "scenarioInput": scenario_input,
        "scenarioOutput": scenario_output,
        "narrativeSummary": narrative_summary,
    })
    table.put_item(Item=item)
    # status transition NEW -> SCENARIO_RUN/REVIEWING is a best-effort side
    # effect of running a scenario -- don't fail the scenario-run write if
    # the header doesn't exist yet or this update loses a race.
    try:
        table.update_item(
            Key={"accountId": account_id, "sk": f"REC#{recommendation_id}"},
            UpdateExpression="SET #status = :status, updatedAt = :now",
            ConditionExpression="attribute_exists(accountId) AND #status = :new_status",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": "SCENARIO_RUN", ":now": now, ":new_status": "NEW"},
        )
    except Exception:
        pass
    return scenario_id


def update_status(table, account_id, recommendation_id, status, extra_fields=None):
    """Transitions a recommendation's status (e.g. NEW -> APPROVED on
    approve_scenario, or -> DISMISSED). Raises if the recommendation
    doesn't exist -- callers must not silently no-op on a bad id."""
    now = datetime.datetime.utcnow().isoformat() + "Z"
    updates = _to_decimal({"status": status, "updatedAt": now, **(extra_fields or {})})
    set_exprs = []
    attr_names = {}
    attr_values = {}
    for k, v in updates.items():
        set_exprs.append(f"#{k} = :{k}")
        attr_names[f"#{k}"] = k
        attr_values[f":{k}"] = v
    table.update_item(
        Key={"accountId": account_id, "sk": f"REC#{recommendation_id}"},
        UpdateExpression="SET " + ", ".join(set_exprs),
        ExpressionAttributeNames=attr_names,
        ExpressionAttributeValues=attr_values,
        ConditionExpression="attribute_exists(accountId)",
    )
