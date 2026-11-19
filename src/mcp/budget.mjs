// Budżet odpowiedzi narzędzi (ADR 0008): JSON bez wcięć, twardy limit znaków, jawne przycięcie (czyste).

/** Długość wyniku tak, jak trafi do agenta. */
export const size = v => JSON.stringify(v)?.length ?? 0;

/** Domyślny twardy limit znaków jednej odpowiedzi narzędzia. */
export const DEFAULT_MAX_CHARS = 20000;

const LONG_TEXT = 200; // krótszych tekstów nie skracamy

/** Największy element do przycięcia: tablica z co najmniej dwoma elementami albo długi tekst. */
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
 * Dopasowuje wynik do limitu znaków. Przycina najpierw największe tablice od początku
 * (tablice są uporządkowane od najstarszych, więc zostają najnowsze elementy), potem najdłuższe teksty.
 * Wynik przycięty jest obiektem z `truncated: true` i wskazówką, jak zawęzić zapytanie.
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

/** Skraca długi query string w URL (pełny URL zwraca get_server_request). */
export function shortUrl(url, maxQuery = 80) {
  if (typeof url !== 'string') return url;
  const i = url.indexOf('?');
  return i < 0 || url.length - i - 1 <= maxQuery ? url : url.slice(0, i) + '?…';
}
