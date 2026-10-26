"""
Unit tests for job_cache.py — most importantly try_claim_job, the
idempotency guard the Part 5/6 plan explicitly calls out fixing as part
of Deep Dive's port (Advisor's existing Node worker has no such guard).

Run with: python3 -m unittest finvault_agent_core.tests.test_job_cache -v
(from backend/layers/finvault-agent-core/)
"""

import unittest
from unittest.mock import MagicMock

from botocore.exceptions import ClientError

from finvault_agent_core.job_cache import read_cache, try_claim_job, write_cache


def _conditional_check_failed():
    return ClientError(
        error_response={"Error": {"Code": "ConditionalCheckFailedException", "Message": "boom"}},
        operation_name="PutItem",
    )


class TestTryClaimJob(unittest.TestCase):
    def test_claims_successfully_when_no_prior_entry(self):
        table = MagicMock()
        self.assertTrue(try_claim_job(table, "key1"))
        table.put_item.assert_called_once()
        call_kwargs = table.put_item.call_args.kwargs
        self.assertEqual(call_kwargs["Item"]["status"], "IN_PROGRESS")
        self.assertEqual(call_kwargs["ConditionExpression"], "attribute_not_exists(cacheKey)")

    def test_returns_false_when_already_claimed(self):
        table = MagicMock()
        table.put_item.side_effect = _conditional_check_failed()
        self.assertFalse(try_claim_job(table, "key1"))

    def test_reraises_unrelated_client_errors(self):
        table = MagicMock()
        table.put_item.side_effect = ClientError(
            error_response={"Error": {"Code": "ProvisionedThroughputExceededException", "Message": "x"}},
            operation_name="PutItem",
        )
        with self.assertRaises(ClientError):
            try_claim_job(table, "key1")

    def test_returns_true_when_no_table_configured(self):
        # Can't enforce the guard without a table -- proceeds rather than
        # blocking all work, matching pre-existing (unguarded) behavior.
        self.assertTrue(try_claim_job(None, "key1"))


class TestReadWriteCache(unittest.TestCase):
    def test_write_then_read_roundtrip(self):
        table = MagicMock()
        write_cache(table, "key1", {"reply": "hello"})
        item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["cacheKey"], "key1")
        self.assertEqual(item["reply"], "hello")
        self.assertIn("expiresAt", item)

        table.get_item.return_value = {"Item": item}
        self.assertEqual(read_cache(table, "key1"), item)

    def test_read_returns_none_without_table(self):
        self.assertIsNone(read_cache(None, "key1"))

    def test_read_returns_none_on_exception(self):
        table = MagicMock()
        table.get_item.side_effect = RuntimeError("DynamoDB unavailable")
        self.assertIsNone(read_cache(table, "key1"))

    def test_write_converts_floats_to_decimal(self):
        from decimal import Decimal
        table = MagicMock()
        write_cache(table, "key1", {"score": 0.85})
        item = table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["score"], Decimal("0.85"))


if __name__ == "__main__":
    unittest.main()
