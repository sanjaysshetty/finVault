"""
Unit tests for Deep Dive's worker_handler — the idempotency guard
short-circuit, the standalone vs pre-seeded context-building, and that a
failure still gets reported to the cache (so the frontend's poll doesn't
hang forever on a dead job).

Run with: python3 -m unittest tests.test_handler -v
(from backend/ai-services/deep-dive/, with the finvault_agent_core layer
and this directory both on PYTHONPATH)
"""

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import handler


class TestWorkerHandlerIdempotency(unittest.TestCase):
    @patch("handler.try_claim_job", return_value=False)
    @patch("handler.AgentLoop")
    def test_skips_run_when_job_already_claimed(self, mock_agent_loop_cls, mock_try_claim):
        handler.worker_handler({"cacheKey": "key1", "accountId": "acct1", "message": "hi"})
        mock_agent_loop_cls.assert_not_called()


class TestWorkerHandlerSuccess(unittest.TestCase):
    @patch("handler.write_cache")
    @patch("handler.try_claim_job", return_value=True)
    @patch("handler._get_tower1_context", return_value={"robinhood": {"available": False}})
    @patch("handler._robinhood_access_token", return_value=None)
    @patch("handler.AgentLoop")
    def test_standalone_first_turn_includes_tower1_preamble(
        self, mock_agent_loop_cls, mock_token, mock_tower1, mock_claim, mock_write_cache,
    ):
        mock_loop = MagicMock()
        mock_loop.run.return_value = SimpleNamespace(final_text="Here's my analysis", status="done")
        mock_agent_loop_cls.return_value = mock_loop

        handler.worker_handler({"cacheKey": "key1", "accountId": "acct1", "message": "what about AAPL?"})

        messages = mock_loop.run.call_args.args[0]
        self.assertIn("Tower 1", messages[0]["content"])
        self.assertIn("what about AAPL?", messages[0]["content"])

        cache_call = mock_write_cache.call_args
        self.assertEqual(cache_call.args[2]["status"], "DONE")
        self.assertEqual(cache_call.args[2]["reply"], "Here's my analysis")

    @patch("handler.write_cache")
    @patch("handler.try_claim_job", return_value=True)
    @patch("handler._get_tower1_context", return_value={"robinhood": {"available": False}})
    @patch("handler._robinhood_access_token", return_value=None)
    @patch("handler.AgentLoop")
    def test_followup_turn_does_not_reinject_preamble(
        self, mock_agent_loop_cls, mock_token, mock_tower1, mock_claim, mock_write_cache,
    ):
        mock_loop = MagicMock()
        mock_loop.run.return_value = SimpleNamespace(final_text="follow-up answer", status="done")
        mock_agent_loop_cls.return_value = mock_loop

        history = [
            {"role": "user", "content": "Tower 1 — ...\n\nwhat about AAPL?"},
            {"role": "assistant", "content": "AAPL looks fine"},
        ]
        handler.worker_handler({"cacheKey": "key2", "accountId": "acct1", "message": "what about MSFT?", "history": history})

        messages = mock_loop.run.call_args.args[0]
        last_message = messages[-1]
        self.assertEqual(last_message["content"], "what about MSFT?")  # no preamble re-injected

    @patch("handler.get_recommendation_with_history", return_value=({"ticker": "AAPL", "strategyType": "LONG_EQUITY", "rationale": "x", "status": "NEW"}, []))
    @patch("handler.write_cache")
    @patch("handler.try_claim_job", return_value=True)
    @patch("handler._get_tower1_context", return_value={"robinhood": {"available": False}})
    @patch("handler._robinhood_access_token", return_value=None)
    @patch("handler.AgentLoop")
    def test_preseeded_entry_fetches_and_includes_recommendation(
        self, mock_agent_loop_cls, mock_token, mock_tower1, mock_claim, mock_write_cache, mock_get_rec,
    ):
        mock_loop = MagicMock()
        mock_loop.run.return_value = SimpleNamespace(final_text="continuing analysis", status="done")
        mock_agent_loop_cls.return_value = mock_loop

        handler.worker_handler({
            "cacheKey": "key3", "accountId": "acct1", "message": "run a scenario",
            "recommendationId": "rec1",
        })

        mock_get_rec.assert_called_once()
        messages = mock_loop.run.call_args.args[0]
        self.assertIn("existing recommendation", messages[0]["content"])
        self.assertIn("AAPL", messages[0]["content"])


class TestWorkerHandlerFailure(unittest.TestCase):
    @patch("handler.write_cache")
    @patch("handler.try_claim_job", return_value=True)
    @patch("handler._get_tower1_context", side_effect=RuntimeError("tower1 blew up"))
    def test_exception_writes_worker_error_to_cache(self, mock_tower1, mock_claim, mock_write_cache):
        handler.worker_handler({"cacheKey": "key4", "accountId": "acct1", "message": "hi"})

        cache_call = mock_write_cache.call_args
        self.assertTrue(cache_call.args[2]["workerError"])
        self.assertIn("tower1 blew up", cache_call.args[2]["errorMessage"])


if __name__ == "__main__":
    unittest.main()
