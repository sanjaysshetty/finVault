"""
Unit tests for calibration-check/app.py — the days_to_expiry fallback
chain, the stale-recommendation expiry logic, the approved/expired
outcome evaluators (especially that an unresolved/ambiguous paper-trade
leg is never silently counted), and the decile-bucketing's minimum
sample size gate.

Run with: python3 -m unittest tests.test_app -v
(from backend/crud/calibration-check/, with the finvault_agent_core
layer and this directory both on PYTHONPATH)
"""

import datetime
import unittest
from unittest.mock import MagicMock, patch

import app


def _header(**overrides):
    base = {
        "accountId": "acct1",
        "recommendationId": "rec1",
        "status": "NEW",
        "ticker": "AAPL",
        "createdAt": "2026-01-01T00:00:00Z",
        "probabilityOfProfit": 0.65,
        "strategyDetail": [{"type": "STOCK", "side": "LONG", "qty": 100, "entry_price": 100.0}],
    }
    base.update(overrides)
    return base


class TestGetDaysToExpiry(unittest.TestCase):
    def test_prefers_approval_snapshot(self):
        header = _header(approvalSnapshot={"scenarioOutput": {"days_to_expiry": 10}}, tower2Research={"scenario_output": {"days_to_expiry": 99}})
        self.assertEqual(app.get_days_to_expiry(header, []), 10)

    def test_falls_back_to_tower2_research(self):
        header = _header(tower2Research={"scenario_output": {"days_to_expiry": 30}})
        self.assertEqual(app.get_days_to_expiry(header, []), 30)

    def test_falls_back_to_most_recent_scenario_run(self):
        header = _header()
        scenario_runs = [
            {"ranAt": "t1", "scenarioOutput": {"days_to_expiry": 20}},
            {"ranAt": "t2", "scenarioOutput": {"days_to_expiry": 45}},
        ]
        self.assertEqual(app.get_days_to_expiry(header, scenario_runs), 45)

    def test_returns_none_when_nothing_found(self):
        self.assertIsNone(app.get_days_to_expiry(_header(), []))


class TestIsPastResolution(unittest.TestCase):
    def test_uses_default_horizon_when_no_days_to_expiry_found(self):
        header = _header(createdAt="2026-01-01T00:00:00Z")
        now = datetime.datetime(2026, 1, 1) + datetime.timedelta(days=app.DEFAULT_HORIZON_DAYS + 1)
        self.assertTrue(app.is_past_resolution(header, [], now=now))

    def test_not_past_resolution_before_horizon(self):
        header = _header(createdAt="2026-01-01T00:00:00Z", tower2Research={"scenario_output": {"days_to_expiry": 30}})
        now = datetime.datetime(2026, 1, 10)
        self.assertFalse(app.is_past_resolution(header, [], now=now))

    def test_past_resolution_after_horizon(self):
        header = _header(createdAt="2026-01-01T00:00:00Z", tower2Research={"scenario_output": {"days_to_expiry": 30}})
        now = datetime.datetime(2026, 2, 5)
        self.assertTrue(app.is_past_resolution(header, [], now=now))


class TestExpireStaleRecommendations(unittest.TestCase):
    @patch("app.update_status")
    @patch("app.get_recommendation_with_history")
    @patch("app.query_by_status")
    def test_expires_only_items_past_horizon(self, mock_query, mock_get, mock_update):
        stale_item = {"accountId": "acct1", "recommendationId": "stale1"}
        fresh_item = {"accountId": "acct1", "recommendationId": "fresh1"}

        def query_side_effect(table, status):
            return [stale_item, fresh_item] if status == "NEW" else []

        mock_query.side_effect = query_side_effect

        def get_side_effect(table, account_id, rec_id):
            if rec_id == "stale1":
                return _header(createdAt="2020-01-01T00:00:00Z"), []
            return _header(createdAt="2099-01-01T00:00:00Z"), []

        mock_get.side_effect = get_side_effect

        table = MagicMock()
        count = app.expire_stale_recommendations(table, now=datetime.datetime(2026, 1, 1))

        self.assertEqual(count, 1)
        mock_update.assert_called_once_with(table, "acct1", "stale1", "EXPIRED")

    @patch("app.update_status")
    @patch("app.get_recommendation_with_history")
    @patch("app.query_by_status", return_value=[])
    def test_no_table_configured_returns_zero(self, mock_query, mock_get, mock_update):
        self.assertEqual(app.expire_stale_recommendations(None), 0)
        mock_query.assert_not_called()

    @patch("app.update_status")
    @patch("app.get_recommendation_with_history")
    @patch("app.query_by_status")
    def test_dry_run_counts_without_updating(self, mock_query, mock_get, mock_update):
        # query_by_status is called once per status in STALE_STATUSES
        # (NEW, REVIEWING, SCENARIO_RUN) -- only the first call should
        # surface the one stale item, or the count would triple-count it.
        mock_query.side_effect = [[{"accountId": "acct1", "recommendationId": "stale1"}], [], []]
        mock_get.return_value = (_header(createdAt="2020-01-01T00:00:00Z"), [])
        count = app.expire_stale_recommendations(MagicMock(), now=datetime.datetime(2026, 1, 1), dry_run=True)
        self.assertEqual(count, 1)
        mock_update.assert_not_called()


class TestEvaluateApprovedOutcome(unittest.TestCase):
    def test_returns_none_without_staged_orders(self):
        header = _header(approvalSnapshot={})
        self.assertIsNone(app.evaluate_approved_outcome(header, MagicMock()))

    @patch("app._get_paper_trade")
    def test_returns_none_when_leg_still_open(self, mock_get_trade):
        header = _header(approvalSnapshot={"stagedOrders": [{"tradeId": "PAPER_1"}]})
        mock_get_trade.return_value = {"status": "SUBMITTED"}
        self.assertIsNone(app.evaluate_approved_outcome(header, MagicMock()))

    @patch("app._get_paper_trade")
    def test_returns_none_when_expired_without_clean_pnl(self, mock_get_trade):
        # Deliberate gap: EXPIRED legs (worthless/assigned) have no clean
        # realizedPnl field -- must not be silently counted with a guessed number.
        header = _header(approvalSnapshot={"stagedOrders": [{"tradeId": "PAPER_1"}]})
        mock_get_trade.return_value = {"status": "EXPIRED", "expiredResult": "WORTHLESS"}
        self.assertIsNone(app.evaluate_approved_outcome(header, MagicMock()))

    @patch("app._get_paper_trade")
    def test_evaluates_closed_single_leg(self, mock_get_trade):
        header = _header(approvalSnapshot={"stagedOrders": [{"tradeId": "PAPER_1"}]})
        mock_get_trade.return_value = {"status": "CLOSED", "realizedPnl": 150.0}
        outcome = app.evaluate_approved_outcome(header, MagicMock())
        self.assertEqual(outcome["realized_pnl"], 150.0)
        self.assertTrue(outcome["realized_win"])
        self.assertEqual(outcome["source"], "paper_trade_fill")

    @patch("app._get_paper_trade")
    def test_sums_pnl_across_vertical_spread_legs_only_when_both_resolved(self, mock_get_trade):
        header = _header(approvalSnapshot={"stagedOrders": [{"tradeId": "PAPER_1"}, {"tradeId": "PAPER_2"}]})
        trades = {"PAPER_1": {"status": "CLOSED", "realizedPnl": 100.0}, "PAPER_2": {"status": "CLOSED", "realizedPnl": -40.0}}
        mock_get_trade.side_effect = lambda table, acct, tid: trades[tid]
        outcome = app.evaluate_approved_outcome(header, MagicMock())
        self.assertEqual(outcome["realized_pnl"], 60.0)

    @patch("app._get_paper_trade")
    def test_returns_none_if_only_one_of_two_legs_resolved(self, mock_get_trade):
        header = _header(approvalSnapshot={"stagedOrders": [{"tradeId": "PAPER_1"}, {"tradeId": "PAPER_2"}]})
        trades = {"PAPER_1": {"status": "CLOSED", "realizedPnl": 100.0}, "PAPER_2": {"status": "SUBMITTED"}}
        mock_get_trade.side_effect = lambda table, acct, tid: trades[tid]
        self.assertIsNone(app.evaluate_approved_outcome(header, MagicMock()))


class TestEvaluateExpiredOutcome(unittest.TestCase):
    @patch("app._fetch_historical_price", return_value=120.0)
    def test_recomputes_payoff_against_historical_price(self, mock_price):
        header = _header(
            strategyDetail=[{"type": "STOCK", "side": "LONG", "qty": 100, "entry_price": 100.0}],
            tower2Research={"scenario_output": {"days_to_expiry": 30}},
        )
        outcome = app.evaluate_expired_outcome(header)
        self.assertEqual(outcome["realized_pnl"], 2000.0)
        self.assertTrue(outcome["realized_win"])
        self.assertEqual(outcome["source"], "historical_price_replay")

    def test_returns_none_without_legs(self):
        header = _header(strategyDetail=[])
        self.assertIsNone(app.evaluate_expired_outcome(header))

    @patch("app._fetch_historical_price", return_value=None)
    def test_returns_none_when_price_unavailable(self, mock_price):
        header = _header()
        self.assertIsNone(app.evaluate_expired_outcome(header))


class TestBucketIntoDeciles(unittest.TestCase):
    def test_marks_insufficient_data_below_min_sample_size(self):
        results = [{"probabilityOfProfit": 0.65, "realizedWin": True}] * 5
        report = app.bucket_into_deciles(results)
        self.assertTrue(report["60-70%"]["insufficientData"])
        self.assertEqual(report["60-70%"]["sampleSize"], 5)

    def test_computes_win_rate_at_sufficient_sample_size(self):
        wins = [{"probabilityOfProfit": 0.75, "realizedWin": True}] * 15
        losses = [{"probabilityOfProfit": 0.75, "realizedWin": False}] * 10
        report = app.bucket_into_deciles(wins + losses)
        self.assertFalse(report["70-80%"]["insufficientData"])
        self.assertEqual(report["70-80%"]["sampleSize"], 25)
        self.assertEqual(report["70-80%"]["realizedWinRate"], 0.6)

    def test_boundary_probability_one_goes_into_top_decile_not_overflow(self):
        results = [{"probabilityOfProfit": 1.0, "realizedWin": True}] * 20
        report = app.bucket_into_deciles(results)
        self.assertEqual(report["90-100%"]["sampleSize"], 20)

    def test_skips_results_with_no_probability(self):
        results = [{"probabilityOfProfit": None, "realizedWin": True}]
        report = app.bucket_into_deciles(results)
        total = sum(v["sampleSize"] for v in report.values())
        self.assertEqual(total, 0)


if __name__ == "__main__":
    unittest.main()
