// The shape of a single request row in tool responses (pure).
import { duration } from '../analyze/timeline.mjs';
import { shortUrl } from './budget.mjs';

export const NO_ORIGIN = '(no frame from app code — e.g. fetch wrapped by Next.js; search by URL)';

/** Status of a failed request when the Node inspector gave an empty errorText (issue #3). */
export const FAILED_NO_TEXT = 'FAILED (no error text from the inspector)';
export const EMPTY_ERROR_HINT = 'The Node inspector reported an empty errorText (that is error.message). Most common cause: the host has several addresses '
  + '(e.g. localhost → ::1 and 127.0.0.1), the connection failed on all of them and Node reports an AggregateError without a message — '
  + 'usually nothing is listening at that address (ECONNREFUSED).';

// Error kind from the inspector's errorText. Order matters: "aborted due to timeout" is a timeout.
const ERROR_KINDS = [
  ['timeout', /timeout|timed out|ETIMEDOUT/i],
  ['aborted', /abort/i],
  ['connection_refused', /ECONNREFUSED/],
  ['connection_reset', /ECONNRESET|EPIPE|socket hang up|other side closed|UND_ERR_SOCKET/i],
  ['dns', /ENOTFOUND|EAI_AGAIN|EAI_FAIL|EAI_NONAME|getaddrinfo/i],
  ['tls', /certificate|CERT_|SSL|TLS/i],
];

/** @returns {'timeout'|'aborted'|'connection_refused'|'connection_reset'|'dns'|'tls'|'other'|'unknown'} */
export function errorKind(text) {
  if (!text?.trim()) return 'unknown';
  return ERROR_KINDS.find(([, re]) => re.test(text))?.[0] ?? 'other';
}

const failedStatus = error => error?.trim() ? `FAILED: ${error}` : FAILED_NO_TEXT;

/** @param {any} r request record  @param {number} [t0] timeline start (inspector seconds) */
export function row(r, t0) {
  return {
    id: r.id, app: r.app, page: r.page ? `${r.page.method} ${r.page.url}` : null,
    ...(r.page?.nextRequestId ? { next_request_id: r.page.nextRequestId } : {}),
    method: r.method, url: shortUrl(r.url),
    status: r.state === 'failed' ? failedStatus(r.error) : (r.status ?? 'pending'),
    start_ms: t0 != null ? Math.round((r.tsStart - t0) * 1000) : undefined,
    duration_ms: duration(r),
    origin: r.origin[0] ?? NO_ORIGIN,
  };
}

/** Time to the first response byte in ms. */
export const ttfb = r => (r.tsResponse != null && r.tsStart != null) ? Math.round((r.tsResponse - r.tsStart) * 1000) : null;

/** Details of one request (the get_server_request tool). Headers are already redacted at ingestion. */
export function details(r, maxBodyChars, bodyOffset = 0) {
  const data = r.body?.data;
  const off = Math.max(0, Math.floor(bodyOffset) || 0), end = off + maxBodyChars;
  const more = (data?.length ?? 0) > end;
  return {
    ...row(r), url: r.url, port: r.port, pid: r.pid, statusText: r.statusText, mimeType: r.mimeType,
    requestHeaders: r.requestHeaders, responseHeaders: r.responseHeaders,
    body: data == null ? null : data.slice(off, end), body_truncated: more,
    // M6: body paging (only when relevant)
    ...(off > 0 ? { body_offset: off } : {}), ...(more ? { body_next_offset: end } : {}),
    error: r.error, call_stack: r.origin, wallStart: new Date(r.wallStart).toISOString(),
    // M2: body state instead of an empty string; time to first byte
    body_state: r.body?.state ?? 'none', body_bytes: r.body?.bytes ?? null, body_reason: r.body?.reason ?? null,
    // only for bodies with content-encoding (no key otherwise): the encoding and the size before decompression
    body_encoding: r.body?.encoding, body_encoded_bytes: r.body?.encodedBytes,
    // number of JSON fields in the body replaced with a description (only when there were any)
    body_redacted_fields: r.body?.redactedFields,
    ttfb_ms: ttfb(r),
    // issue #3: error kind (only for failed ones) and an explanation of the empty message
    ...(r.state === 'failed' ? { error_kind: errorKind(r.error) } : {}),
    ...(r.state === 'failed' && !r.error?.trim() ? { error_hint: EMPTY_ERROR_HINT } : {}),
  };
}
