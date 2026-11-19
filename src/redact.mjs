// Redakcja sekretów przy przyjęciu danych (przed zapisem do magazynu): nagłówki i parametry URL.
// Wartość zastępuje opis ze schematem, długością i krótkim skrótem — agent może stwierdzić,
// czy dwa zapytania niosły ten sam sekret, ale nie odczyta go. Skrót to HMAC-SHA256 z kluczem
// losowanym przy starcie kolektora: porównywalny w obrębie sesji, bezużyteczny do zgadywania poza nią.
import { createHmac, randomBytes } from 'node:crypto';

export const SENSITIVE_HEADERS = Object.freeze(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);
const SENSITIVE_NAME = /token|secret|password|passwd|session|api[-_]?key|(^|[-_])key($|[-_])|auth|signature|credential/i;
const SCHEME = /^(Bearer|Basic|Digest|Negotiate|Token|ApiKey)\s/i;

/**
 * @param {{ enabled?: boolean, extraHeaders?: readonly string[], key?: Buffer }} [opts]
 */
export function createRedactor({ enabled = true, extraHeaders = [], key = randomBytes(32) } = {}) {
  const names = new Set([...SENSITIVE_HEADERS, ...extraHeaders.map(h => h.toLowerCase())]);
  const hash = v => createHmac('sha256', key).update(String(v)).digest('hex').slice(0, 6);
  const isSensitive = name => names.has(name.toLowerCase()) || SENSITIVE_NAME.test(name);

  /** Opis zastępujący wartość, np. „[zredagowano: Bearer · 12 zn. · #a1b2c3]”. */
  function describe(value) {
    const v = String(value);
    const scheme = v.match(SCHEME)?.[1];
    return `[zredagowano: ${scheme ? scheme + ' · ' : ''}${v.length} zn. · #${hash(v)}]`;
  }

  function headers(h) {
    if (!enabled || !h) return h;
    const out = {};
    for (const [name, value] of Object.entries(h)) out[name] = isSensitive(name) ? describe(value) : value;
    return out;
  }

  function url(u) {
    if (!enabled || typeof u !== 'string' || !u.includes('?')) return u;
    let parsed; try { parsed = new URL(u); } catch { return u; }
    let changed = false;
    for (const [name, value] of parsed.searchParams) {
      if (isSensitive(name)) { parsed.searchParams.set(name, `[zredagowano · #${hash(value)}]`); changed = true; }
    }
    return changed ? parsed.toString() : u;
  }

  return { enabled, headers, url, describe, isSensitive };
}
