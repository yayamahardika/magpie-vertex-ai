import { checkedRegion } from "./regions.mjs"

const RETRY_STATUS = new Set([404, 429, 500, 502, 503, 504])
// 400/403 mean "this region" only with one of these phrases; otherwise the request itself is wrong.
const REGION_TEXT = /only available|not available in|not servable|not supported in this region|RESOURCE_EXHAUSTED/i

// The regions to try, in order. A pinned region is the only one; otherwise the
// caller's preferred region goes first when the model serves it.
export function regionsFor(entry, ctx, pinned) {
  const regions = entry.regions ?? []
  for (const region of regions) checkedRegion(region)
  if (pinned) {
    checkedRegion(pinned)
    if (!regions.includes(pinned)) throw new Error("The model does not serve the pinned region")
    return [pinned]
  }
  const preferred = ctx?.location
  if (preferred && regions.includes(preferred)) return [preferred, ...regions.filter((r) => r !== preferred)]
  return [...regions]
}

export function retryable(status, bodyText = "") {
  if (RETRY_STATUS.has(status)) return true
  return (status === 400 || status === 403) && REGION_TEXT.test(bodyText)
}

// Tries attempt(region) in order. A retryable failure moves on to the next
// region; any other failure is returned at once, since another region would
// refuse it the same way. The last failure comes back as a Response with its
// status, body and content type.
export async function withRegions(regions, attempt, { signal } = {}) {
  if (!regions.length) throw new Error("no region serves this model")
  for (const region of regions) checkedRegion(region)
  let last = null
  for (const loc of regions) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError")
    const res = await attempt(loc)
    if (res.ok) return res
    const headers = new Headers(res.headers)
    headers.delete("content-length")
    headers.delete("content-encoding")
    last = { status: res.status, text: await res.text(), headers }
    if (!retryable(last.status, last.text)) break
  }
  return new Response(last.text, { status: last.status, headers: last.headers })
}
