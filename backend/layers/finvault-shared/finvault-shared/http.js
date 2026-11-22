function baseHeaders() {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  };
}

function json(statusCode, body) {
  if (statusCode === 204) return { statusCode, headers: baseHeaders() };
  return { statusCode, headers: baseHeaders(), body: JSON.stringify(body ?? {}) };
}

function badRequest(message, details) {
  return json(400, { message, details });
}

function notFound(message = "Not found") {
  return json(404, { message });
}

module.exports = { json, badRequest, notFound };
