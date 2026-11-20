// Tool response budget (ADR 0008): JSON without indentation, a hard character limit, explicit truncation (pure).

/** Result length as it reaches the agent. */
export const size = v => JSON.stringify(v)?.length ?? 0;

/** The default hard character limit of one tool response. */
export const DEFAULT_MAX_CHARS = 20000;

const LONG_TEXT = 200; // shorter texts are not shortened

/** The largest item to trim: an array with at least two elements or a long text. */
function largest(root) {
  let best = null;
  const visit = (node, parent, key) => {
    if (typeof node === 'string') {
      if (node.length > LONG_TEXT && (!best || node.length > best.bytes)) best = { node, parent, key, bytes: node.length };
      return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node) && node.length > 1) {
      const bytes = size(node);
      if (!best || bytes > best.bytes) best = { node, parent, key, bytes };
    }
    for (const [k, child] of Object.entries(node)) visit(child, node, k);
  };
  visit(root, null, null);
  return best;
}

/**
 * Fits the result to the character limit. It first trims the largest arrays from the start
 * (arrays are ordered oldest first, so the newest elements stay), then the longest texts.
 * A truncated result is an object with `truncated: true` and a hint on how to narrow the query.
 * @param {any} value  @param {{ limit?: number, hint: string }} opts
 */
export function fitToBudget(value, { limit = DEFAULT_MAX_CHARS, hint }) {
  if (size(value) <= limit) return value;
  const meta = { truncated: true, truncation_hint: hint };
  const room = limit - size(meta) - 16;
  let v = structuredClone(value);
  for (let guard = 0; guard < 1000 && size(v) > room; guard++) {
    const t = largest(v);
    if (!t) break;
    const excess = size(v) - room;
    if (typeof t.node === 'string') {
      t.parent[t.key] = t.node.slice(0, Math.max(LONG_TEXT, t.node.length - excess - 1)) + '…';
    } else {
      const n = t.node.length;
      t.node.splice(0, Math.min(n - 1, Math.max(1, Math.ceil(n * excess / t.bytes))));
    }
  }
  if (Array.isArray(v)) v = { items: v };
  const out = { ...v, ...meta };
  return size(out) <= limit ? out : meta;
}

/** Shortens a long query string in a URL (get_server_request returns the full URL). */
export function shortUrl(url, maxQuery = 80) {
  if (typeof url !== 'string') return url;
  const i = url.indexOf('?');
  return i < 0 || url.length - i - 1 <= maxQuery ? url : url.slice(0, i) + '?…';
}
