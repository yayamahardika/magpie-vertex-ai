// Error bodies in the shape each client's SDK parses.
const GEMINI_STATUS = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  429: "RESOURCE_EXHAUSTED",
  500: "INTERNAL",
  502: "UNAVAILABLE",
  503: "UNAVAILABLE",
  504: "DEADLINE_EXCEEDED",
}

function anthropicType(status) {
  return { 400: "invalid_request_error", 401: "authentication_error", 403: "permission_error", 404: "not_found_error", 429: "rate_limit_error" }[status] ?? "api_error"
}

function openaiType(status) {
  if (status === 401) return "authentication_error"
  if (status === 403) return "permission_error"
  if (status === 429) return "rate_limit_error"
  return status >= 500 ? "server_error" : "invalid_request_error"
}

export function jsonHeaders(source) {
  const headers = new Headers(source)
  headers.set("content-type", "application/json")
  for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) headers.delete(name)
  return headers
}

export function errorResponse(protocol, status, message, sourceHeaders) {
  const text = String(message ?? "")
  let body
  if (protocol === "gemini") {
    body = { error: { code: status, message: text, status: GEMINI_STATUS[status] ?? (status >= 500 ? "INTERNAL" : "UNKNOWN") } }
  } else if (protocol === "anthropic") {
    body = { type: "error", error: { type: anthropicType(status), message: text } }
  } else {
    body = { error: { message: text, type: openaiType(status), param: null, code: null } }
  }
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders(sourceHeaders) })
}
