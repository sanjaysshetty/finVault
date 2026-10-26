"""
calibration-check — weekly confidence-calibration job (Part 5/6 plan §6.6).

Plain Python, no Claude call — validating whether the agentic engine's
stated probabilities are honest doesn't require reasoning about
anything, just arithmetic against real outcomes. Deliberately lives in
backend/crud/, not backend/ai-services/, for exactly that reason (same
precedent as OptionMarksFunction — a Python crud function).

Two phases, run every invocation:
  1. expire_stale_recommendations — NEW/REVIEWING/SCENARIO_RUN items
     whose scenario horizon has passed get transitioned to EXPIRED.
     Nothing else in the system does this transition.
  2. evaluate_resolved_recommendations — every APPROVED or EXPIRED item
     not yet evaluated: APPROVED reads the real realized P&L from its
     linked PaperTrades order(s) (ground truth from the proven fill
     engine); EXPIRED (never acted on) re-fetches the actual historical
     price and recomputes payoff_at_price against the recommendation's
     own legs. Results are bucketed by probability-at-decision into
     deciles, win-rate computed per decile, written per-account to
     AnalyticsBucket — gated on a minimum sample size so an early run
     doesn't show a misleadingly precise number.
"""

import datetime
import json
import logging
import os

import boto3
from finvault_agent_core.recommendations_repo import (
    get_recommendation_with_history,
    mark_calibration_evaluated,
    query_by_status,
    update_status,
)
from finvault_agent_core.scenario_math import Leg, LegSide, LegType, payoff_at_price

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

AGENT_RECOMMENDATIONS_TABLE = os.environ.get("AGENT_RECOMMENDATIONS_TABLE", "")
PAPER_TRADES_TABLE = os.environ.get("PAPER_TRADES_TABLE", "")
ANALYTICS_BUCKET = os.environ.get("ANALYTICS_BUCKET", "")
CALIBRATION_PREFIX = "CalibrationReports/"

DEFAULT_HORIZON_DAYS = 90  # fallback only -- used when no days_to_expiry can be found anywhere
MIN_DECILE_SAMPLE_SIZE = 20
STALE_STATUSES = ("NEW", "REVIEWING", "SCENARIO_RUN")

_ddb = boto3.resource("dynamodb")
_recommendations_table = _ddb.Table(AGENT_RECOMMENDATIONS_TABLE) if AGENT_RECOMMENDATIONS_TABLE else None
_paper_trades_table = _ddb.Table(PAPER_TRADES_TABLE) if PAPER_TRADES_TABLE else None
_s3 = boto3.client("s3")


def _parse_iso(ts):
    return datetime.datetime.fromisoformat(ts.rstrip("Z"))


def get_days_to_expiry(header, scenario_runs):
    """Checked in order: approvalSnapshot (every APPROVED item has this --
    it only ever comes from Deep Dive's approve_scenario), the header's
    own tower2Research (Opportunity-Engine-originated items set this at
    creation), then the most recent scenario-run sub-item (covers
    standalone Deep Dive items, whose header never carries scenario_output
    directly). Returns None if nothing is found anywhere."""
    approval = header.get("approvalSnapshot") or {}
    dte = (approval.get("scenarioOutput") or {}).get("days_to_expiry")
    if dte is not None:
        return dte

    t2 = header.get("tower2Research") or {}
    dte = (t2.get("scenario_output") or {}).get("days_to_expiry")
    if dte is not None:
        return dte

    for run in reversed(scenario_runs or []):
        dte = (run.get("scenarioOutput") or {}).get("days_to_expiry")
        if dte is not None:
            return dte

    return None


def resolution_date(header, days_to_expiry):
    horizon = days_to_expiry if days_to_expiry is not None else DEFAULT_HORIZON_DAYS
    return _parse_iso(header["createdAt"]) + datetime.timedelta(days=horizon)


def is_past_resolution(header, scenario_runs, now=None):
    now = now or datetime.datetime.utcnow()
    dte = get_days_to_expiry(header, scenario_runs)
    return now >= resolution_date(header, dte)


def expire_stale_recommendations(recommendations_table, now=None, dry_run=False):
    """Phase 1. Returns the count of recommendations transitioned to EXPIRED."""
    if not recommendations_table:
        return 0
    expired_count = 0
    for status in STALE_STATUSES:
        for item in query_by_status(recommendations_table, status):
            account_id = item.get("accountId")
            rec_id = item.get("recommendationId")
            if not account_id or not rec_id:
                continue
            header, scenario_runs = get_recommendation_with_history(recommendations_table, account_id, rec_id)
            if not header:
                continue
            if is_past_resolution(header, scenario_runs, now=now):
                if not dry_run:
                    update_status(recommendations_table, account_id, rec_id, "EXPIRED")
                expired_count += 1
    return expired_count


def _get_paper_trade(paper_trades_table, account_id, trade_id):
    if not paper_trades_table:
        return None
    try:
        resp = paper_trades_table.get_item(Key={"accountId": account_id, "tradeId": trade_id})
        return resp.get("Item")
    except Exception as e:
        logger.warning(f"Failed to read paper trade {trade_id}: {e}")
        return None


def evaluate_approved_outcome(header, paper_trades_table):
    """Only counts a recommendation as resolved once EVERY staged leg is
    explicitly CLOSED with a realizedPnl field -- an EXPIRED paper-trade
    leg (worthless/assigned) has no clean realizedPnl to read, and
    approximating one risks silently corrupting the calibration signal
    with a wrong number. Known, deliberate narrower-but-correct gap:
    those legs just aren't counted yet, and get re-checked next week."""
    approval = header.get("approvalSnapshot") or {}
    staged_orders = approval.get("stagedOrders") or []
    if not staged_orders:
        return None

    total_pnl = 0.0
    any_found = False
    for order_result in staged_orders:
        trade_id = (order_result.get("order") or {}).get("tradeId") or order_result.get("tradeId")
        if not trade_id:
            return None
        trade = _get_paper_trade(paper_trades_table, header["accountId"], trade_id)
        if not trade:
            return None
        any_found = True
        if trade.get("status") == "CLOSED" and trade.get("realizedPnl") is not None:
            total_pnl += float(trade["realizedPnl"])
        else:
            return None  # at least one leg unresolved (or expired without a clean P&L) -- try again next week

    if not any_found:
        return None
    return {"realized_pnl": round(total_pnl, 2), "realized_win": total_pnl > 0, "source": "paper_trade_fill"}


def _fetch_historical_price(ticker, target_date):
    import yfinance as yf
    try:
        start = (target_date - datetime.timedelta(days=4)).date().isoformat()
        end = (target_date + datetime.timedelta(days=4)).date().isoformat()
        hist = yf.Ticker(ticker).history(start=start, end=end)
        if hist.empty:
            return None
        hist = hist.tz_localize(None) if hist.index.tz is not None else hist
        idx = hist.index.get_indexer([target_date], method="nearest")[0]
        return float(hist.iloc[idx]["Close"])
    except Exception as e:
        logger.warning(f"Historical price fetch failed for {ticker}: {e}")
        return None


def evaluate_expired_outcome(header):
    """Never-approved recommendations: re-fetch the actual historical
    price at the resolution date and recompute payoff_at_price against
    the recommendation's own stored legs -- validates ranking/direction
    quality independent of whether the user ever acted on it."""
    legs_raw = header.get("strategyDetail") or []
    ticker = header.get("ticker")
    if not legs_raw or not ticker:
        return None

    dte = get_days_to_expiry(header, [])
    target_date = resolution_date(header, dte)
    historical_price = _fetch_historical_price(ticker, target_date)
    if historical_price is None:
        return None

    legs = [
        Leg(
            type=LegType(leg["type"]),
            side=LegSide(leg["side"]),
            qty=float(leg["qty"]),
            entry_price=float(leg["entry_price"]),
            strike=float(leg["strike"]) if leg.get("strike") is not None else None,
        )
        for leg in legs_raw
    ]
    pnl = payoff_at_price(legs, historical_price)
    return {
        "realized_pnl": round(pnl, 2),
        "realized_win": pnl > 0,
        "source": "historical_price_replay",
        "resolved_price": historical_price,
    }


def evaluate_resolved_recommendations(recommendations_table, paper_trades_table, now=None):
    """Phase 2. Returns a list of {recommendationId, accountId, status,
    probabilityOfProfit, realizedWin, realizedPnl} for every newly-evaluated
    recommendation this run."""
    if not recommendations_table:
        return []
    results = []
    for status, evaluator in (("APPROVED", "approved"), ("EXPIRED", "expired")):
        for item in query_by_status(recommendations_table, status):
            if item.get("calibrationEvaluated"):
                continue
            account_id = item.get("accountId")
            rec_id = item.get("recommendationId")
            if not account_id or not rec_id:
                continue

            header, scenario_runs = get_recommendation_with_history(recommendations_table, account_id, rec_id)
            if not header:
                continue
            if not is_past_resolution(header, scenario_runs, now=now):
                continue  # resolved status but horizon hasn't actually passed yet (e.g. just approved)

            outcome = (
                evaluate_approved_outcome(header, paper_trades_table)
                if evaluator == "approved"
                else evaluate_expired_outcome(header)
            )
            if outcome is None:
                continue  # couldn't evaluate yet -- try again next week, not an error

            mark_calibration_evaluated(recommendations_table, account_id, rec_id, outcome)
            results.append({
                "recommendationId": rec_id,
                "accountId": account_id,
                "status": status,
                "probabilityOfProfit": header.get("probabilityOfProfit"),
                "realizedWin": outcome["realized_win"],
                "realizedPnl": outcome["realized_pnl"],
            })
    return results


def bucket_into_deciles(results):
    """Buckets by probability-at-decision into 10 deciles, computing
    realized win-rate per decile -- gated on MIN_DECILE_SAMPLE_SIZE so an
    early run with few resolved recommendations shows "insufficient data"
    rather than a misleadingly precise win rate from 2 samples."""
    deciles = {i: [] for i in range(10)}
    for r in results:
        p = r.get("probabilityOfProfit")
        if p is None:
            continue
        idx = min(int(float(p) * 10), 9)
        deciles[idx].append(r)

    report = {}
    for idx in range(10):
        items = deciles[idx]
        label = f"{idx * 10}-{idx * 10 + 10}%"
        n = len(items)
        if n < MIN_DECILE_SAMPLE_SIZE:
            report[label] = {"sampleSize": n, "insufficientData": True}
        else:
            wins = sum(1 for i in items if i["realizedWin"])
            report[label] = {"sampleSize": n, "insufficientData": False, "realizedWinRate": round(wins / n, 4)}
    return report


def write_calibration_report(bucket, account_id, report, generated_at):
    if not bucket:
        return
    key = f"{CALIBRATION_PREFIX}{account_id}/latest.json"
    _s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=json.dumps({"generatedAt": generated_at, "deciles": report}, indent=2),
        ContentType="application/json",
        CacheControl="no-store",
    )
    logger.info(f"Wrote calibration report s3://{bucket}/{key}")


def handler(event=None, context=None):
    now = datetime.datetime.utcnow()
    generated_at = now.isoformat() + "Z"

    expired_count = expire_stale_recommendations(_recommendations_table, now=now)
    logger.info(f"Expired {expired_count} stale recommendation(s)")

    results = evaluate_resolved_recommendations(_recommendations_table, _paper_trades_table, now=now)
    logger.info(f"Evaluated {len(results)} newly-resolved recommendation(s)")

    by_account = {}
    for r in results:
        by_account.setdefault(r["accountId"], []).append(r)

    for account_id, account_results in by_account.items():
        report = bucket_into_deciles(account_results)
        write_calibration_report(ANALYTICS_BUCKET, account_id, report, generated_at)

    return {
        "statusCode": 200,
        "body": json.dumps({
            "expiredCount": expired_count,
            "evaluatedCount": len(results),
            "accountsReported": list(by_account.keys()),
        }),
    }
