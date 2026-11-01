"""
Unit tests for secrets.py -- direct boto3 SSM fetch with in-process
caching (switched off the AWS Parameters and Secrets Lambda Extension,
which has no container-image-compatible distribution -- see module
docstring).

Run with: python3 -m unittest finvault_agent_core.tests.test_secrets -v
(from backend/layers/finvault-agent-core/)
"""

import unittest
from unittest.mock import MagicMock, patch

import finvault_agent_core.secrets as secrets_module
from finvault_agent_core.secrets import get_secret


class TestGetSecret(unittest.TestCase):
    def setUp(self):
        secrets_module._cache.clear()

    @patch("finvault_agent_core.secrets._ssm")
    def test_fetches_and_returns_value(self, mock_ssm):
        mock_ssm.get_parameter.return_value = {"Parameter": {"Value": "sk-ant-fake"}}

        value = get_secret("/finvault/anthropic/api-key")

        self.assertEqual(value, "sk-ant-fake")
        mock_ssm.get_parameter.assert_called_once_with(Name="/finvault/anthropic/api-key", WithDecryption=True)

    @patch("finvault_agent_core.secrets._ssm")
    def test_caches_across_calls_no_second_ssm_fetch(self, mock_ssm):
        mock_ssm.get_parameter.return_value = {"Parameter": {"Value": "sk-ant-fake"}}

        get_secret("/finvault/anthropic/api-key")
        get_secret("/finvault/anthropic/api-key")

        self.assertEqual(mock_ssm.get_parameter.call_count, 1)

    @patch("finvault_agent_core.secrets._ssm")
    def test_failed_fetch_is_not_cached_and_retries_next_call(self, mock_ssm):
        mock_ssm.get_parameter.side_effect = [Exception("throttled"), {"Parameter": {"Value": "sk-ant-fake"}}]

        with self.assertRaises(Exception):
            get_secret("/finvault/anthropic/api-key")

        value = get_secret("/finvault/anthropic/api-key")
        self.assertEqual(value, "sk-ant-fake")
        self.assertEqual(mock_ssm.get_parameter.call_count, 2)

    @patch("finvault_agent_core.secrets._ssm")
    def test_different_names_cached_independently(self, mock_ssm):
        mock_ssm.get_parameter.side_effect = [
            {"Parameter": {"Value": "anthropic-key"}},
            {"Parameter": {"Value": "robinhood-token"}},
        ]

        a = get_secret("/finvault/anthropic/api-key")
        b = get_secret("/finvault/robinhood/mcp-access-token")

        self.assertEqual(a, "anthropic-key")
        self.assertEqual(b, "robinhood-token")


if __name__ == "__main__":
    unittest.main()
