// Secret redaction at ingestion (before storing): headers, URL parameters and JSON body fields.
// The value is replaced by a description with the scheme, length and a short digest — the agent can tell
// whether two requests carried the same secret, but cannot read it. The digest is HMAC-SHA256 with a key
// drawn when the collector starts: comparable within a session, useless for guessing outside it.
import { createHmac, randomBytes } from 'node:crypto';

export const SENSITIVE_HEADERS = Object.freeze(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key']);
const SENSITIVE_NAME = /token|secret|password|passwd|session|api[-_]?key|(^|[-_])key($|[-_])|auth(?!or)|signature|credential/i;
// short names matched whole, so e.g. country_code is not caught (audit B-05)
const SENSITIVE_EXACT = /^(sig|code|pass|pwd|pin|otp|jwt|assertion|client_assertion|dsn|cookie|private_key)$/i;
// values recognizable by format, regardless of the field name (audit B-05, B-06)
const VALUE_PATTERNS = [
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g,                                  // JWT
  /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g,          // GitHub
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,                            // Stripe
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,                                        // Slack
  /\bAKIA[0-9A-Z]{16}\b/g,                                                  // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g,                                             // Google API key
  /\bbot\d{5,}:[\w-]{30,}/g,                                                // Telegram bot token
  /(?<=hooks\.slack\.com\/services\/)[\w/]+/g,                              // Slack webhook
  /(?<=discord(?:app)?\.com\/api\/webhooks\/)\d+\/[\w-]+/g,                  // Discord webhook
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, // klucz prywatny PEM
];
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`,;]+/g;
const FORM = /^[\w.%[\]-]+=[^&\s]*(&[\w.%[\]-]+=[^&\s]*)*$/;
/** camelCase → snake_case before checking the name (privateKey → private_key). */
const snake = name => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
// A JSON field with a scalar value: "name": "text" or "name": number. Objects and arrays are not redacted.
const JSON_FIELD = /"((?:[^"\\]|\\.){1,100})"(\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g;
const SCHEME = /^(Bearer|Basic|Digest|Negotiate|Token|ApiKey)\s/i;

/** Whether a name (parameter, field) looks like a secret — the same rule as for headers and URL parameters. */
const decodeURIComponentSafe = s => { try { return decodeURIComponent(s); } catch { return s; } };

// names that match the rule but carry no secrets (OAuth/OIDC): without them a token response loses readability
const NOT_SECRET = /^(token_type|token_endpoint|auth_time|authorization_endpoint|session_state|code_challenge_method|expires_in)$/i;

export const isSensitiveName = name => !NOT_SECRET.test(snake(name)) && (SENSITIVE_NAME.test(name) || SENSITIVE_EXACT.test(name) || SENSITIVE_EXACT.test(snake(name)) || SENSITIVE_NAME.test(snake(name)));

/**
 * @param {{ enabled?: boolean, extraHeaders?: readonly string[], key?: Buffer }} [opts]
 */
export function createRedactor({ enabled = true, extraHeaders = [], key = randomBytes(32) } = {}) {
  const names = new Set([...SENSITIVE_HEADERS, ...extraHeaders.map(h => h.toLowerCase())]);
  const hash = v => createHmac('sha256', key).update(String(v)).digest('hex').slice(0, 6);
  const isSensitive = name => typeof name === 'string' && (names.has(name.toLowerCase()) || isSensitiveName(name));
  const short = v => `[redacted · #${hash(v)}]`;

  /** Values with a recognizable format (JWT, GitHub/Stripe/Slack tokens, AWS keys, webhooks, PEM) in any text. */
  function values(text) {
    if (!enabled || typeof text !== 'string') return { text, count: 0 };
    let count = 0, out = text;
    for (const re of VALUE_PATTERNS) out = out.replace(re, m => { count++; return short(m); });
    return { text: out, count };
  }

  /** A description replacing the value, e.g. "[redacted: Bearer · 12 chars · #a1b2c3]". */
  function describe(value) {
    const v = String(value);
    const scheme = v.match(SCHEME)?.[1];
    return `[redacted: ${scheme ? scheme + ' · ' : ''}${v.length} chars · #${hash(v)}]`;
  }

  /** Headers: by name; in the others, URLs (Location, Link, Refresh…) and values of a known format (audit B-05). */
  function headers(h) {
    if (!enabled || !h) return h;
    const out = {};
    for (const [name, value] of Object.entries(h)) {
      if (isSensitive(name)) { out[name] = describe(value); continue; }
      out[name] = typeof value === 'string' ? values(value.replace(URL_IN_TEXT, m => url(m))).text : value;
    }
    return out;
  }

  /**
   * An absolute URL or a relative path (the page request address, e.g. `/callback?code=…`, audit B-02): query
   * and fragment parameters with secret names, the userinfo password, values of a known format in the path (audit B-05).
   */
  function url(u) {
    if (!enabled || typeof u !== 'string') return u;
    const relative = u.startsWith('/') && !u.startsWith('//');
    let parsed; try { parsed = relative ? new URL(u, 'http://relative.invalid') : new URL(u); } catch { return values(u).text; }
    let changed = false;
    for (const [name, value] of parsed.searchParams) {
      if (isSensitive(name)) { parsed.searchParams.set(name, short(value)); changed = true; }
    }
    if (parsed.password) { parsed.password = 'redacted'; changed = true; }
    if (parsed.hash.includes('=')) {
      const frag = new URLSearchParams(parsed.hash.slice(1));
      let fragChanged = false;
      for (const [name, value] of frag) if (isSensitive(name)) { frag.set(name, short(value)); fragChanged = true; }
      if (fragChanged) { parsed.hash = frag.toString(); changed = true; }
    }
    const path = values(decodeURIComponentSafe(parsed.pathname));
    if (path.count) changed = true;
    const pathOut = path.count ? path.text : parsed.pathname;
    const tail = parsed.search + parsed.hash;
    const built = !changed ? u : relative ? pathOut + tail
      : `${parsed.protocol}//${parsed.username ? parsed.username + (parsed.password ? ':' + parsed.password : '') + '@' : ''}${parsed.host}${pathOut}${tail}`;
    return values(built).text; // host-dependent patterns (Slack, Discord webhooks)
  }

  /**
   * A JSON body (also truncated): values of fields with secret names are replaced with a description. Works on text,
   * so it keeps formatting and does not need valid JSON. An unclosed secret value at the end
   * of a truncated body is replaced too (audit B-06).
   * @returns {{ text: string, count: number }}
   */
  function jsonBody(text) {
    if (!enabled || typeof text !== 'string' || !text.includes('"')) return { text, count: 0 };
    let count = 0;
    let out = text.replace(JSON_FIELD, (m, name, sep, val) => {
      if (!isSensitive(name)) return m;
      count++;
      let raw = val;
      if (val.startsWith('"')) { try { raw = JSON.parse(val); } catch { raw = val.slice(1, -1); } }
      return `"${name}"${sep}"${describe(raw)}"`;
    });
    out = out.replace(/"((?:[^"\\]|\\.){1,100})"(\s*:\s*)"((?:[^"\\]|\\.)*)$/, (m, name, sep, val) => {
      if (!isSensitive(name)) return m;
      count++;
      return `"${name}"${sep}"[redacted: cut value · ${val.length}+ chars]"`;
    });
    return { text: out, count };
  }

  /** JSON tree: a subtree under a secret key (also an object or array) is replaced with a description. */
  function jsonTree(node) {
    let count = 0;
    const walk = v => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => {
          if (isSensitive(k)) { count++; return [k, describe(typeof x === 'string' ? x : JSON.stringify(x))]; }
          return [k, walk(x)];
        }));
      }
      return v;
    };
    return { value: walk(node), count };
  }

  /**
   * A response body of any text type (audit B-06): JSON as a tree (truncated — as text),
   * form-urlencoded by names, and in every body, values of a known format.
   * @returns {{ text: string, count: number }}
   */
  function body(text, contentType = '') {
    if (!enabled || typeof text !== 'string' || !text) return { text, count: 0 };
    let out = text, count = 0;
    const trimmed = text.trimStart();
    if (/json/i.test(contentType) || trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed, ok = false;
      try { parsed = JSON.parse(text); ok = true; } catch {}
      if (ok) {
        const t = jsonTree(parsed);
        if (t.count) { out = JSON.stringify(t.value, null, /\n\s+"/.test(text) ? 2 : 0); count += t.count; }
      } else {
        const j = jsonBody(text); out = j.text; count += j.count;
      }
    } else if (/x-www-form-urlencoded/i.test(contentType) || FORM.test(text.trim())) {
      const form = new URLSearchParams(text.trim());
      let n = 0;
      for (const [name, value] of form) if (isSensitive(name)) { form.set(name, short(value)); n++; }
      if (n) { out = form.toString(); count += n; }
    }
    const v = values(out);
    return { text: v.text, count: count + v.count };
  }

  return { enabled, headers, url, jsonBody, body, values, describe, isSensitive };
}
