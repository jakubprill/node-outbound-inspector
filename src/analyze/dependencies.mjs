// Zależności danych między zapytaniami (heurystyka, czyste): czy zapytanie B użyło wartości z treści
// odpowiedzi A? Jeśli tak, B musi czekać na A i Promise.all tego fragmentu nie skróci (issue #6).
//
// Dowód zależności A → B: wartość „identyfikatorowa” z treści odpowiedzi A (liść albo klucz JSON-a,
// token tekstu) występuje w URL-u B (ścieżka, parametry — po dekodowaniu procentowym) albo w wartości
// nagłówka B, a żadne zapytanie wysłane przed końcem A jej nie niosło (wtedy aplikacja znała ją
// wcześniej, np. userId z adresu strony albo nagłówek x-request-id przekazywany dalej).
//
// Brak dowodu to nie dowód niezależności: gdy treści odpowiedzi A nie ma (fetch na Node < 24, tryb
// lazy/off, wyparcie), jest przycięta albo B wysłało treść żądania, której model nie zawiera,
// para jest „nieznana”, a check() zgłasza stan inny niż 'complete'. Dane są już po redakcji, więc
// sekrety (Authorization, parametry typu token) nigdy nie dają dopasowania.
import { isSensitiveName } from '../redact.mjs';

const TOL = 0.001; // s — ta sama tolerancja co w waterfall.chains
/** Ograniczenia kosztu: przeszukiwana długość treści, liczba kandydatów z jednej odpowiedzi, długość łańcucha w JSON-ie. */
export const LIMITS = Object.freeze({ scanChars: 256 * 1024, candidates: 2000, stringChars: 4096 });

const TOKEN = /[\w.~@-]+/g;
const PART = /[-_.~@]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Wartości pospolite: występują w wielu zapytaniach niezależnie od siebie.
const COMMON = [
  /^(.)\1+$/,                      // xxxxxxxx, 00000000 (wypełnienia)
  /^\d0+$/,                        // 100000, 1000000 (limity, okrągłe kwoty)
  /^\d{1,3}(\.\d{1,3}){3}$/,       // adres IPv4
  /^\d{4}-\d{2}-\d{2}/,            // data ISO (dzisiejsza data trafia do wielu zapytań)
  /^v?\d+(\.\d+){2,}/i,            // numer wersji
];
// Nagłówki techniczne B, w których zbieżność wartości nic nie znaczy.
const IGNORED_HEADERS = new Set(['host', 'user-agent', 'accept', 'accept-encoding', 'accept-language', 'content-type',
  'content-length', 'connection', 'keep-alive', 'te', 'cache-control', 'pragma', 'origin', 'referer']);
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Czy token może być identyfikatorem przekazanym dalej: ≥ 8 znaków z cyfrą, UUID, liczba ≥ 6 cyfr. */
export function isCandidate(t) {
  if (t.length > 256 || COMMON.some(re => re.test(t))) return false;
  if (/^\d+$/.test(t)) return t.length >= 6;
  if (t.length < 8) return false;
  return UUID.test(t) || /\d/.test(t) || (t.length >= 16 && /[a-z]/.test(t) && /[A-Z]/.test(t));
}

const decode = s => { try { return decodeURIComponent(s); } catch { return s; } };

/** Wartości wysłane przez zapytanie (URL bez hosta, nagłówki) → miejsce wystąpienia. Także części tokenu (ord-123456 → 123456). */
export function sentValues(r, base) {
  const out = new Map();
  const add = (s, where) => {
    for (const t of String(s).match(TOKEN) ?? []) {
      if (!out.has(t)) out.set(t, where);
      if (PART.test(t)) for (const p of t.split(PART)) if (p.length >= 6 && !out.has(p)) out.set(p, where);
    }
  };
  let u = null;
  try { u = new URL(r.url, base); } catch { add(decode(r.url ?? ''), 'url'); }
  if (u) {
    for (const seg of u.pathname.split('/')) add(decode(seg), 'path');
    for (const [k, v] of u.searchParams) add(v, `query:${k}`);
    if (u.hash) add(decode(u.hash.slice(1)), 'fragment');
  }
  for (const [name, v] of Object.entries(r.requestHeaders ?? {})) {
    const n = name.toLowerCase();
    if (!IGNORED_HEADERS.has(n)) add(v, `header:${n}`);
  }
  return out;
}

const bodyReason = b => b?.reason ?? (b?.state === 'none' || !b ? 'response body was not fetched (lazy mode or no response)' : `response body: ${b.state}`);

/**
 * Kandydaci z treści odpowiedzi: wartość → ścieżka JSON (albo null dla tekstu).
 * `complete: false`, gdy treści brak, jest przycięta albo przekroczono limit — wtedy brak dopasowania nic nie znaczy.
 */
export function responseValues(r) {
  const values = new Map();
  if (r.state === 'failed') return { values, complete: true }; // brak odpowiedzi — nie ma danych do użycia
  const body = r.body;
  if (body?.data == null || !['available', 'truncated'].includes(body.state)) return { values, complete: false, reason: bodyReason(body) };
  let complete = body.state === 'available', reason = complete ? undefined : bodyReason(body);
  let data = body.data;
  if (data.length > LIMITS.scanChars) { data = data.slice(0, LIMITS.scanChars); complete = false; reason = `only the first ${LIMITS.scanChars} characters of the body were scanned`; }
  const add = (s, path, max = LIMITS.stringChars) => {
    for (const t of String(s).slice(0, max).match(TOKEN) ?? []) {
      if (values.has(t) || !isCandidate(t)) continue;
      if (values.size >= LIMITS.candidates) { complete = false; reason = `limit of ${LIMITS.candidates} values per response`; return; }
      values.set(t, path);
    }
  };
  const json = /^\s*[[{]/.test(data) ? parseJson(data) : undefined;
  if (json === undefined) add(data, null, Infinity);
  else walk(json, '$', add, 0);
  return { values, complete, reason };
}

// Duże liczby całkowite (> 2^53) z tekstu źródłowego, bez utraty cyfr (JSON.parse z kontekstem, Node ≥ 21).
const parseJson = s => {
  try { return JSON.parse(s, (k, v, ctx) => (Number.isInteger(v) && !Number.isSafeInteger(v) && /^-?\d+$/.test(ctx?.source ?? '')) ? BigInt(ctx.source) : v); }
  catch { return undefined; } // np. treść przycięta — przeszukujemy jak tekst
};

function walk(v, path, add, depth) {
  if (depth > 64 || v == null) return;
  if (typeof v === 'string') add(v, path);
  else if (typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v))) add(String(v), path);
  else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, add, depth + 1));
  else if (typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { const p = `${path}.${k}`; add(k, p); walk(x, p, add, depth + 1); }
  }
}

/** Przycięty dowód; wartość spod klucza wyglądającego na sekret (na dowolnym poziomie ścieżki) nie jest pokazywana. */
function evidence(value, fromPath, foundIn) {
  let path = fromPath, shown = value.length > 24 ? `${value.slice(0, 20)}…` : value;
  const secret = fromPath?.match(/\.([^.[\]]+)/g)?.find(seg => isSensitiveName(seg.slice(1)));
  if (secret) { shown = `[redacted · ${value.length} chars]`; path = fromPath.slice(0, fromPath.indexOf(secret) + secret.length) + (fromPath.endsWith(secret) ? '' : '…'); }
  return { value: shown, ...(path ? { from_path: path.length > 60 ? `${path.slice(0, 59)}…` : path } : {}), found_in: foundIn };
}

/** Czy treść żądania B (niewidoczna w modelu) mogła nieść wartość z A. */
const hasHiddenBody = r => BODY_METHODS.has(String(r.method).toUpperCase())
  || Number(Object.entries(r.requestHeaders ?? {}).find(([k]) => k.toLowerCase() === 'content-length')?.[1]) > 0;

/**
 * Graf zależności danych w grupie zakończonych zapytań (seria albo żądanie strony).
 * Koszt ~ liczba wysłanych wartości × krótkie listy z indeksu; stan sprawdzenia liczony na żądanie.
 * @param {any[]} group
 * @returns {{ edges: { from: any, to: any, evidence: object }[], check(members: any[]): { status: string, reason?: string } | null }}
 */
export function dependencyGraph(group) {
  const done = group.filter(r => r.tsEnd != null);
  const sent = new Map(group.map(r => [r, sentValues(r, 'http://x')]));
  const produced = new Map(done.map(r => [r, responseValues(r)]));
  const producers = new Map(); // wartość → odpowiedzi, które ją zawierały, rosnąco po tsEnd
  for (const A of [...done].sort((x, y) => x.tsEnd - y.tsEnd)) for (const t of produced.get(A).values.keys()) (producers.get(t) ?? producers.set(t, []).get(t)).push(A);
  const firstSent = new Map(); // wartość → dwa najwcześniej wysłane zapytania z nią (drugie, gdy pierwszym jest samo B)
  for (const [r, m] of sent) for (const t of m.keys()) {
    const f = firstSent.get(t) ?? firstSent.set(t, []).get(t);
    f.push(r); f.sort((x, y) => x.tsStart - y.tsStart); if (f.length > 2) f.pop();
  }
  const pageKnown = new Set();
  for (const url of new Set(group.map(r => r.page?.url).filter(Boolean))) for (const t of sentValues({ url }, 'http://page').keys()) pageKnown.add(t);

  const before = (A, B) => A !== B && B.tsStart >= A.tsEnd - TOL;
  // wartość znana przed końcem A: z adresu strony, wysłana przez samo A albo przez zapytanie (poza B) rozpoczęte wcześniej
  const knownBefore = (t, A, B) => {
    const R = (firstSent.get(t) ?? []).find(x => x !== B);
    return pageKnown.has(t) || sent.get(A).has(t) || (R != null && R.tsStart < A.tsEnd - TOL);
  };
  const edges = [], dependent = new Map(); // B → Set(A)
  for (const B of group) {
    const found = new Map();
    for (const [t, where] of sent.get(B)) {
      // źródłem jest najwcześniejsza odpowiedź zawierająca wartość, której aplikacja wcześniej nie znała
      const A = producers.get(t)?.find(a => before(a, B) && !knownBefore(t, a, B));
      if (A && !found.has(A)) found.set(A, evidence(t, produced.get(A).values.get(t), where));
    }
    for (const [A, ev] of found) edges.push({ from: A, to: B, evidence: ev });
    if (found.size) dependent.set(B, new Set(found.keys()));
  }

  return {
    edges,
    /** Stan sprawdzenia par (A zakończone przed startem B) wśród `members`; null, gdy takich par nie ma. Sumy prefiksowe: O(n log n). */
    check(members) {
      const ms = members.filter(r => produced.has(r)).sort((x, y) => x.tsEnd - y.tsEnd);
      const index = new Map(ms.map((r, i) => [r, i]));
      const incomplete = [0], firstReason = new Map(); // liczba niepełnych treści w ms[0..i); powód → pierwszy indeks
      ms.forEach((r, i) => {
        const p = produced.get(r);
        incomplete.push(incomplete[i] + (p.complete ? 0 : 1));
        if (!p.complete && !firstReason.has(p.reason)) firstReason.set(p.reason, i);
      });
      let pairs = 0, unknown = 0;
      const reasons = new Set();
      for (const B of ms) {
        let lo = 0, hi = ms.length; // k = liczba zapytań zakończonych najpóźniej w chwili startu B
        while (lo < hi) { const mid = (lo + hi) >> 1; if (ms[mid].tsEnd <= B.tsStart + TOL) lo = mid + 1; else hi = mid; }
        const k = lo, self = index.get(B) < k ? 1 : 0;
        const deps = [...(dependent.get(B) ?? [])].filter(A => index.get(A) < k);
        const n = k - self - deps.length; // pary bez dowodu
        if (n <= 0) { pairs += deps.length; continue; }
        pairs += n + deps.length;
        if (hasHiddenBody(B)) { unknown += n; reasons.add(`${B.method} request body is not available in the model`); continue; }
        const inc = incomplete[k] - (self && !produced.get(B).complete ? 1 : 0) - deps.filter(A => !produced.get(A).complete).length;
        unknown += inc;
        if (inc > 0) for (const [reason, i] of firstReason) if (i < k && ms[i] !== B && reasons.size < 4) reasons.add(reason);
      }
      if (!pairs) return null;
      if (!unknown) return { status: 'complete' };
      const list = [...reasons];
      return { status: unknown === pairs ? 'unavailable' : 'partial', reason: list.slice(0, 3).join('; ') + (list.length > 3 ? '; …' : '') };
    },
  };
}
