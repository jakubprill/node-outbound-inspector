// Normalizacja wyników narzędzi do porównań golden: usuwa wartości zmienne (id, pid, porty, czasy,
// ścieżki bezwzględne) i porządkuje elementy, których kolejność zależy od wyścigu współbieżnych zapytań.
const VOLATILE_NUM = new Set(['id', 'pid', 'port', 'start_ms', 'duration_ms', 'wall_ms', 'sum_of_durations_ms',
  'if_parallel_ms', 'potential_saving_ms', 'potential_saving_ms_if_fully_parallel', 'last_id', 'since_id']);
const VOLATILE_STR = new Set(['since', 'wallStart', 'page_request_id', 'connectedAt']);

const key = v => JSON.stringify(v);

export function normalize(value, root = process.cwd()) {
  if (Array.isArray(value)) {
    const items = value.map(v => normalize(v, root));
    return items.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      const v = value[k];
      if (VOLATILE_NUM.has(k) && typeof v === 'number') out[k] = '<num>';
      else if (VOLATILE_STR.has(k) && v != null) out[k] = '<str>';
      else if (k === 'responseHeaders' && v) out[k] = Object.fromEntries(Object.entries(v).filter(([h]) => !/^(date|keep-alive|connection)$/i.test(h)).sort());
      else out[k] = normalize(v, root);
    }
    return out;
  }
  if (typeof value === 'string') {
    return value
      .split(root).join('<root>')
      .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
      .replace(/\(\d+ ms\)/g, '(<n> ms)');
  }
  return value;
}
