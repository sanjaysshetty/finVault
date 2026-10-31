"""
Unit tests for handler.py's orchestration -- the cost-guardrail
restructuring added after the 2026-10-26 incident (in-progress
concurrency claim, deep-dive-top-N split, budget-gated Tower 2
submission). The "already scanned within 7 days, run again anyway?"
decision lives entirely in the Node trigger route, NOT here -- this
handler only ever refuses to start a second CONCURRENT run.

run_tower2_for_candidate itself is mocked throughout (returns canned
(captured, cost) tuples) -- these tests verify handler()/run_tower2_pass's
own orchestration logic, not AgentLoop internals (already covered by
test_agent_loop.py).

Run with: python3 -m unittest tests.test_handler -v
(from backend/ai-services/opportunity-engine/, with the finvault_agent_core
layer and this directory both on PYTHONPATH)
"""

import unittest
from unittest.mock import MagicMock, patch

import handler


def _candidate(ticker, score):
    return {
        "ticker": ticker, "name": ticker, "sector": "Technology", "price": 100.0,
        "market_cap_b": 10.0, "rev_growth": 10.0, "gross_margin": 40.0, "fcf": 1_000_000_000,
        "de_ratio": 0.5, "roe": 15.0, "eps_growth": 10.0, "_fund_score": score,
    }


class TestInProgressClaim(unittest.TestCase):
    @patch("handler.try_claim_job", return_value=False)
    @patch("handler.prefilter")
    def test_already_running_bails_before_universe_fetch(self, mock_prefilter, mock_claim):
        result = handler.handler({"accountId": "acct1"})

        self.assertEqual(result["body"]["status"], "already_running")
        mock_prefilter.get_full_universe.assert_not_called()

    @patch("handler.try_claim_job", return_value=False)
    @patch("handler.prefilter")
    def test_claim_key_has_no_week_component(self, mock_prefilter, mock_claim):
        # Regression guard: the claim must be scoped to "is a scan
        # running right now," not to a calendar week -- a stale week-
        # scoped key would silently resurrect the old behavior this
        # whole change was meant to remove.
        handler.handler({"accountId": "acct1"})

        claim_key = mock_claim.call_args.args[1]
        self.assertEqual(claim_key, "oe-scan-running#acct1")
        self.assertNotIn("W", claim_key)

    @patch("handler.recommendations_repo")
    @patch("handler.try_claim_job", return_value=True)
    @patch("handler.prefilter")
    def test_claim_succeeds_proceeds_to_universe_fetch(self, mock_prefilter, mock_claim, mock_repo):
        mock_prefilter.get_full_universe.return_value = []
        handler.handler({"accountId": "acct1"})
        mock_prefilter.get_full_universe.assert_called_once()


class TestDeepDiveSplit(unittest.TestCase):
    def _run_with_shortlist(self, n_candidates, deep_dive_top_n, scan_budget_usd=0.20):
        candidates = [_candidate(f"T{i}", score=100 - i) for i in range(n_candidates)]

        with patch("handler.try_claim_job", return_value=True), \
             patch("handler.recommendations_repo") as mock_repo, \
             patch("handler.prefilter") as mock_prefilter, \
             patch("handler.summarize_tower1_context", return_value="summary"), \
             patch("handler.build_tower1_context", return_value={}), \
             patch("handler._robinhood_access_token", return_value=None), \
             patch("handler.DEEP_DIVE_TOP_N", deep_dive_top_n), \
             patch("handler.SCAN_BUDGET_USD", scan_budget_usd), \
             patch("handler.run_tower2_for_candidate") as mock_run_tower2:

            mock_prefilter.get_full_universe.return_value = [c["ticker"] for c in candidates]
            mock_prefilter.batch_fetch_fundamentals.return_value = candidates
            mock_prefilter.apply_hard_filters.return_value = candidates
            mock_prefilter.score_stock_fundamentals.side_effect = lambda s: s["_fund_score"]
            mock_prefilter.summarize_fundamentals.side_effect = lambda s: f"summary of {s['ticker']}"
            # Every deep-dive run "succeeds" cheaply and well under budget.
            mock_run_tower2.return_value = ({"strategy_type": "LONG_EQUITY", "legs": [], "portfolio_fit_rationale": "fits",
                                              "market_rationale": "strong", "rank_score": 80, "probability_of_profit": 0.6,
                                              "scenario_output": {}}, 0.01)

            result = handler.handler({"accountId": "acct1"})

        return result, mock_repo, mock_run_tower2

    def test_exactly_top_n_candidates_reach_tower2(self):
        result, mock_repo, mock_run_tower2 = self._run_with_shortlist(n_candidates=10, deep_dive_top_n=3)

        self.assertEqual(mock_run_tower2.call_count, 3)
        # The top-3-highest-score tickers (T0, T1, T2) are the ones deep-dived.
        called_tickers = {call.args[0]["ticker"] for call in mock_run_tower2.call_args_list}
        self.assertEqual(called_tickers, {"T0", "T1", "T2"})

    def test_remaining_candidates_get_screened_only_with_zero_tower2_calls(self):
        result, mock_repo, mock_run_tower2 = self._run_with_shortlist(n_candidates=10, deep_dive_top_n=3)

        self.assertEqual(mock_run_tower2.call_count, 3)
        # SHORTLIST_SIZE=25 doesn't truncate a 10-candidate universe, so
        # all 7 below the top-3 cutoff (T3..T9) are screened-only.
        screened_calls = [c for c in mock_repo.put_screened_recommendation.call_args_list]
        screened_tickers = {c.kwargs["ticker"] for c in screened_calls}
        self.assertEqual(screened_tickers, {f"T{i}" for i in range(3, 10)})

    def test_deep_dived_candidates_get_full_recommendation_persisted(self):
        result, mock_repo, mock_run_tower2 = self._run_with_shortlist(n_candidates=5, deep_dive_top_n=2)

        self.assertEqual(mock_repo.put_recommendation.call_count, 2)
        self.assertEqual(result["body"]["recorded"], 2)

    def test_response_body_reports_correct_counts(self):
        result, _, _ = self._run_with_shortlist(n_candidates=8, deep_dive_top_n=3)
        self.assertEqual(result["body"]["deep_dived"], 3)
        self.assertEqual(result["body"]["screened_only"], 5)


class TestBudgetExhaustionMidScan(unittest.TestCase):
    def test_candidates_past_budget_exhaustion_become_screened_only_not_tower2_calls(self):
        # 5 candidates eligible for deep-dive, but a tiny scan budget means
        # only the first couple can get a viable allocation before the
        # MIN_VIABLE_CANDIDATE_BUDGET_USD floor kicks in.
        candidates = [_candidate(f"T{i}", score=100 - i) for i in range(5)]

        with patch("handler.try_claim_job", return_value=True), \
             patch("handler.recommendations_repo") as mock_repo, \
             patch("handler.prefilter") as mock_prefilter, \
             patch("handler.summarize_tower1_context", return_value="summary"), \
             patch("handler.build_tower1_context", return_value={}), \
             patch("handler._robinhood_access_token", return_value=None), \
             patch("handler.DEEP_DIVE_TOP_N", 5), \
             patch("handler.SCAN_BUDGET_USD", 0.03), \
             patch("handler.PER_CANDIDATE_CEILING_USD", 0.10), \
             patch("handler.MIN_VIABLE_CANDIDATE_BUDGET_USD", 0.02), \
             patch("handler.run_tower2_for_candidate") as mock_run_tower2:

            mock_prefilter.get_full_universe.return_value = [c["ticker"] for c in candidates]
            mock_prefilter.batch_fetch_fundamentals.return_value = candidates
            mock_prefilter.apply_hard_filters.return_value = candidates
            mock_prefilter.score_stock_fundamentals.side_effect = lambda s: s["_fund_score"]
            mock_prefilter.summarize_fundamentals.side_effect = lambda s: f"summary of {s['ticker']}"
            # Each candidate spends its FULL allocation (worst case).
            mock_run_tower2.side_effect = lambda cand, t1, mcp, cap: (
                {"strategy_type": "LONG_EQUITY", "legs": [], "portfolio_fit_rationale": "fits",
                 "market_rationale": "strong", "rank_score": 80, "probability_of_profit": 0.6, "scenario_output": {}},
                cap,
            )

            result = handler.handler({"accountId": "acct1"})

        # Budget $0.03 / 5 candidates = $0.006 each -- below the $0.02 floor
        # immediately, so NO candidate should ever reach Tower 2 at all.
        self.assertEqual(mock_run_tower2.call_count, 0)
        self.assertEqual(result["body"]["deep_dived"], 0)
        self.assertEqual(result["body"]["screened_only"], 5)
        screened_notes = {c.kwargs["note"] for c in mock_repo.put_screened_recommendation.call_args_list}
        self.assertTrue(any("budget" in n.lower() for n in screened_notes))

    def test_total_spend_never_exceeds_scan_budget(self):
        candidates = [_candidate(f"T{i}", score=100 - i) for i in range(6)]

        with patch("handler.try_claim_job", return_value=True), \
             patch("handler.recommendations_repo") as mock_repo, \
             patch("handler.prefilter") as mock_prefilter, \
             patch("handler.summarize_tower1_context", return_value="summary"), \
             patch("handler.build_tower1_context", return_value={}), \
             patch("handler._robinhood_access_token", return_value=None), \
             patch("handler.DEEP_DIVE_TOP_N", 6), \
             patch("handler.SCAN_BUDGET_USD", 0.20), \
             patch("handler.PER_CANDIDATE_CEILING_USD", 0.10), \
             patch("handler.run_tower2_for_candidate") as mock_run_tower2:

            mock_prefilter.get_full_universe.return_value = [c["ticker"] for c in candidates]
            mock_prefilter.batch_fetch_fundamentals.return_value = candidates
            mock_prefilter.apply_hard_filters.return_value = candidates
            mock_prefilter.score_stock_fundamentals.side_effect = lambda s: s["_fund_score"]
            mock_prefilter.summarize_fundamentals.side_effect = lambda s: f"summary of {s['ticker']}"
            # Worst case: every candidate spends exactly its full allocation.
            mock_run_tower2.side_effect = lambda cand, t1, mcp, cap: (None, cap)

            result = handler.handler({"accountId": "acct1"})

        self.assertLessEqual(result["body"]["total_actual_cost_usd"], 0.20)


if __name__ == "__main__":
    unittest.main()
