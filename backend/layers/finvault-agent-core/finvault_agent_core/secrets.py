"""
get_secret — fetches a value from SSM Parameter Store via the AWS Parameters
and Secrets Lambda Extension's local cache, instead of baking secrets into
CloudFormation-managed Lambda environment variables (which CloudFormation
resolves to plaintext and echoes back via DescribeStackEvents / the console).

Requires the function to have the extension layer attached and
ssm:GetParameter IAM permission on the parameter's ARN.
"""

import json
import os
import urllib.error
import urllib.parse
import urllib.request

import boto3

_EXTENSION_PORT = os.environ.get("PARAMETERS_SECRETS_EXTENSION_HTTP_PORT", "2773")

# name -> value. A failed fetch is never cached, so the next call retries
# instead of a transient failure poisoning the whole container.
_cache = {}


def get_secret(name):
    if name in _cache:
        return _cache[name]

    credentials = boto3.Session().get_credentials()
    if credentials is None:
        raise RuntimeError("Failed to resolve AWS credentials for secrets extension request")
    session_token = credentials.get_frozen_credentials().token

    url = (
        f"http://localhost:{_EXTENSION_PORT}/systemsmanager/parameters/get"
        f"?name={urllib.parse.quote(name, safe='')}&withDecryption=true"
    )
    req = urllib.request.Request(url, headers={"X-Aws-Parameters-Secrets-Token": session_token})
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.loads(resp.read())
    except urllib.error.URLError as e:
        raise RuntimeError(f"get_secret({name}) failed") from e

    value = body["Parameter"]["Value"]
    _cache[name] = value
    return value
