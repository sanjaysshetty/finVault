"use strict";

/**
 * getSecret — fetches a value from SSM Parameter Store via the AWS
 * Parameters and Secrets Lambda Extension's local cache, instead of baking
 * secrets into CloudFormation-managed Lambda environment variables (which
 * CloudFormation resolves to plaintext and echoes back via
 * DescribeStackEvents / the console).
 *
 * Requires the function to have the extension layer attached and
 * ssm:GetParameter IAM permission on the parameter's ARN.
 */

const EXTENSION_PORT = process.env.PARAMETERS_SECRETS_EXTENSION_HTTP_PORT || "2773";

// name -> Promise<string>. A rejected promise is removed so the next call
// retries instead of a transient failure poisoning the whole container.
const cache = new Map();

async function fetchSecret(name) {
  const url =
    `http://localhost:${EXTENSION_PORT}/systemsmanager/parameters/get` +
    `?name=${encodeURIComponent(name)}&withDecryption=true`;

  const res = await fetch(url, {
    headers: { "X-Aws-Parameters-Secrets-Token": process.env.AWS_SESSION_TOKEN || "" },
  });
  if (!res.ok) {
    throw new Error(`getSecret(${name}) failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return body.Parameter.Value;
}

function getSecret(name) {
  if (!cache.has(name)) {
    const promise = fetchSecret(name);
    promise.catch(() => cache.delete(name));
    cache.set(name, promise);
  }
  return cache.get(name);
}

module.exports = { getSecret };
