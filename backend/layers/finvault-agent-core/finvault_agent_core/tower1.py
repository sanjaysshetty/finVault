"""
Tower 1 — Portfolio & Risk Context.

Deterministic, no Claude call — your positions/cash/margin are facts to
retrieve, not something requiring judgment. See the Part 5/6 plan §6.2 for
the full rationale.

Robinhood's OAuth grant for finVault's backend is not set up yet (a
separate, not-yet-completed step — see robinhood_mcp.py's
_default_token_provider docstring), so build_tower1_context degrades
gracefully: a RobinhoodMcpError is caught and logged, not raised, and the
context is returned with whatever it has (non-Robinhood holdings +
investor profile always work; Robinhood-sourced fields are simply absent,
flagged via `robinhood_available: False`, until that grant exists).
"""

import logging
from decimal import Decimal

from boto3.dynamodb.conditions import Key
from finvault_agent_core.robinhood_mcp import RobinhoodMcpError

logger = logging.getLogger(__name__)


def _decimal_to_native(value):
    """DynamoDB returns Decimal for all numbers — convert for JSON/float math."""
    if isinstance(value, Decimal):
        return float(value)
    return value


def fetch_portfolio(assets_table, user_id):
    """Non-Robinhood holdings (bullion/fixed-income/other/crypto/stocks tracked
    manually in finAssets) — relocated verbatim from asset-hub/handler.py's
    fetch_portfolio (handler.py:211-277), just re-parameterized to take an
    injected table resource instead of a module-level global."""
    if not assets_table or not user_id:
        return {}
    try:
        resp = assets_table.query(
            IndexName="GSI1",
            KeyConditionExpression=Key("gsi1pk").eq(user_id),
            Limit=400,
        )
        items = resp.get("Items", [])

        portfolio = {k: [] for k in ("stocks", "options", "crypto", "bullion", "futures", "fixed_income")}

        for it in items:
            atype = it.get("assetType", "")
            if atype == "STOCK_TX":
                portfolio["stocks"].append({
                    "ticker": it.get("ticker", ""),
                    "qty": _decimal_to_native(it.get("qty") or 0),
                    "avg_cost": _decimal_to_native(it.get("avgCost") or it.get("price") or 0),
                })
            elif atype == "OPTIONS_TX":
                portfolio["options"].append({
                    "ticker": it.get("ticker", ""),
                    "type": it.get("type", ""),
                    "event": it.get("event", ""),
                    "strike": _decimal_to_native(it.get("strikes") or 0),
                    "expiry": it.get("expiry", ""),
                    "qty": _decimal_to_native(it.get("qty") or 0),
                    "is_open": not bool(it.get("closeDate")),
                })
            elif atype == "CRYPTO_TX":
                portfolio["crypto"].append({
                    "ticker": it.get("ticker", ""),
                    "qty": _decimal_to_native(it.get("qty") or 0),
                    "avg_cost": _decimal_to_native(it.get("price") or it.get("avgCost") or 0),
                })
            elif atype == "BULLION_TX":
                portfolio["bullion"].append({
                    "metal": it.get("metal") or it.get("ticker", ""),
                    "oz": _decimal_to_native(it.get("oz") or it.get("qty") or 0),
                })
            elif atype == "FUTURES_TX":
                portfolio["futures"].append({
                    "ticker": it.get("ticker", ""),
                    "qty": _decimal_to_native(it.get("qty") or 0),
                })
            elif atype in ("FIXED_INCOME", "FIXEDINCOME"):
                portfolio["fixed_income"].append({
                    "name": it.get("name") or it.get("ticker", ""),
                    "value": _decimal_to_native(it.get("faceValue") or it.get("value") or it.get("amount") or 0),
                })

        total_invested = 0
        for s in portfolio["stocks"]:
            total_invested += s["qty"] * s["avg_cost"]
        for c in portfolio["crypto"]:
            total_invested += c["qty"] * c["avg_cost"]
        for fi in portfolio["fixed_income"]:
            total_invested += fi["value"]
        portfolio["total_invested"] = round(total_invested, 2)

        return portfolio
    except Exception as e:
        logger.warning(f"Portfolio fetch failed: {e}")
        return {}


def fetch_investor_profile(accounts_table, account_id):
    """Reads investorProfile from FinAccountsTable (new field, promoted from
    AdvisorChat's old client-only Goals panel — see accounts-api/app.js's
    PATCH /accounts/:accountId/investor-profile). Returns the default shape
    if the account hasn't set one yet."""
    default = {
        "riskTolerance": "Moderate",
        "objective": "Balanced Growth",
        "timeHorizon": "5-10 years",
        "targetAnnualReturnPct": None,
        "netWorthGoal": None,
        "monthlyContribution": None,
        "notes": "",
    }
    if not accounts_table or not account_id:
        return default
    try:
        resp = accounts_table.get_item(Key={"accountId": account_id})
        item = resp.get("Item") or {}
        profile = item.get("investorProfile")
        if not profile:
            return default
        return {
            "riskTolerance": profile.get("riskTolerance", default["riskTolerance"]),
            "objective": profile.get("objective", default["objective"]),
            "timeHorizon": profile.get("timeHorizon", default["timeHorizon"]),
            "targetAnnualReturnPct": _decimal_to_native(profile.get("targetAnnualReturnPct")),
            "netWorthGoal": (
                {
                    "amount": _decimal_to_native(profile["netWorthGoal"].get("amount")),
                    "byYear": _decimal_to_native(profile["netWorthGoal"].get("byYear")),
                }
                if profile.get("netWorthGoal")
                else None
            ),
            "monthlyContribution": _decimal_to_native(profile.get("monthlyContribution")),
            "notes": profile.get("notes", ""),
        }
    except Exception as e:
        logger.warning(f"Investor profile fetch failed: {e}")
        return default


def fetch_robinhood_context(robinhood_client):
    """Direct-client Robinhood lookups — cash, margin, current holdings.
    Degrades gracefully: returns `{"available": False}` if no client was
    constructed at all (handler.py passes None when no access token
    exists yet) or on any RobinhoodMcpError (expected until the
    finVault-specific OAuth grant is set up) — never fails the whole
    engine run over this."""
    if robinhood_client is None:
        return {"available": False}
    try:
        accounts = robinhood_client.get_accounts()
        portfolio = robinhood_client.get_portfolio()
        equity_positions = robinhood_client.get_equity_positions()
        option_positions = robinhood_client.get_option_positions()
        crypto_positions = robinhood_client.get_crypto_positions()
        realized_pnl = robinhood_client.get_realized_pnl()
        return {
            "available": True,
            "accounts": accounts,
            "portfolio": portfolio,
            "equity_positions": equity_positions,
            "option_positions": option_positions,
            "crypto_positions": crypto_positions,
            "realized_pnl": realized_pnl,
        }
    except RobinhoodMcpError as e:
        logger.warning(f"Robinhood context unavailable (OAuth grant likely not set up yet): {e}")
        return {"available": False}


def build_tower1_context(robinhood_client, assets_table, accounts_table, account_id):
    """Assembles the full Tower 1 snapshot. Non-Robinhood pieces always
    succeed (or return an empty/default shape); Robinhood pieces degrade
    gracefully per fetch_robinhood_context."""
    return {
        "robinhood": fetch_robinhood_context(robinhood_client),
        "manual_holdings": fetch_portfolio(assets_table, account_id),
        "investor_profile": fetch_investor_profile(accounts_table, account_id),
    }
