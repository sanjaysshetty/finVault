"""
get_secret — fetches a value from SSM Parameter Store directly via boto3,
instead of baking secrets into CloudFormation-managed Lambda environment
variables (which CloudFormation resolves to plaintext and echoes back via
DescribeStackEvents / the console).

Previously went through the AWS Parameters and Secrets Lambda Extension's
local HTTP cache instead of a direct boto3 call -- switched back to a
direct call because the extension has no supported container-image
distribution (it's a Lambda Layer only, and Layers aren't usable with
container-image-packaged functions at all, which several consumers of
this module now are). A direct SSM call works identically for container
and zip-packaged functions alike, so this isn't a container-only special
case -- it's just simpler, and the module-level `_cache` below already
gives the same "don't refetch within a warm container" behavior the
extension provided, without needing a sidecar process.

Requires ssm:GetParameter IAM permission on the parameter's ARN (same
permission the extension-based approach already required).
"""

import boto3

_ssm = boto3.client("ssm")

# name -> value. A failed fetch is never cached, so the next call retries
# instead of a transient failure poisoning the whole container.
_cache = {}


def get_secret(name):
    if name in _cache:
        return _cache[name]

    resp = _ssm.get_parameter(Name=name, WithDecryption=True)
    value = resp["Parameter"]["Value"]
    _cache[name] = value
    return value
