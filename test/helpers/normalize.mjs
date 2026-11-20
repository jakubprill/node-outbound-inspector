// Normalizacja wyników narzędzi do porównań golden: usuwa wartości zmienne (id, pid, porty, czasy,
// ścieżki bezwzględne) i porządkuje elementy, których kolejność zależy od wyścigu współbieżnych zapytań.
const VOLATILE_NUM = new Set(['id', 'pid', 'port', 'start_ms', 'duration_ms', 'wall_ms', 'sum_of_durations_ms',
  'if_parallel_ms', 'potential_saving_ms', 'potential_saving_ms_if_fully_parallel', 'last_id', 'since_id', 'next_since_id', 'ttfb_ms', 'waited_ms']);
const VOLATILE_STR = new Set(['since', 'http_ports', 'wallStart', 'page_request_id', 'connectedAt', 'node', 'ports_scanned']);
// Treść odpowiedzi i jej pochodne mogą różnić się między wersjami Node — sprawdzają je osobne testy e2e.
// Tak samo stan sprawdzenia zależności danych, który wynika z dostępności treści (issue #6).
const NODE_DEPENDENT = new Set(['body', 'body_state', 'body_bytes', 'body_reason', 'dependency_check']);
const NODE_WARNING = /^Node \d+: /;

const key = v => JSON.stringify(v);

/** Ścieżki z `\\` (Windows) zapisane jak na POSIX, żeby golden był ten sam na każdym systemie (issue #7). */
const slashes = s => s.replace(/\\/g, '/');

export function normalize(value, root = process.cwd()) {
  root = slashes(root).replace(/\/$/, ''); // katalog z końcowym separatorem (fileURLToPath na Windows)
  if (Array.isArray(value)) {
    const items = value.map(v => normalize(v, root));
    return items.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (NODE_DEPENDENT.has(k)) out[k] = '<node-dependent>';
      else if (k === 'warnings' && Array.isArray(v)) out[k] = normalize(v.filter(w => !NODE_WARNING.test(w)), root);
      else if (VOLATILE_NUM.has(k) && typeof v === 'number') out[k] = '<num>';
      else if (VOLATILE_STR.has(k) && v != null) out[k] = '<str>';
      else if (k === 'responseHeaders' && v) out[k] = Object.fromEntries(Object.entries(v).filter(([h]) => !/^(date|keep-alive|connection)$/i.test(h)).sort());
      else out[k] = normalize(v, root);
    }
    return out;
  }
  if (typeof value === 'string') {
    return slashes(value)
      .split(root).join('<root>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/\(\d+ ms\)/g, '(<n> ms)');
  }
  return value;
}
