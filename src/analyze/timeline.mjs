// Oś czasu: czasy trwania, serie, współbieżność (czyste). Znaczniki czasu inspektora są w sekundach
// i monotoniczne w obrębie procesu — osie czasu różnych procesów analizujemy osobno.

/** Czas trwania zapytania w ms albo null, gdy jeszcze trwa. */
export const duration = r => (r.tsEnd != null && r.tsStart != null) ? Math.round((r.tsEnd - r.tsStart) * 1000) : null;

/** Dzieli zakończone zapytania (posortowane po tsStart) na serie oddzielone przerwą > idleGapMs. */
export function bursts(requests, { idleGapMs }) {
  const out = []; let cur = null, curEnd = -Infinity;
  for (const r of requests) {
    if (!cur || (r.tsStart - curEnd) * 1000 > idleGapMs) { cur = []; out.push(cur); curEnd = -Infinity; }
    cur.push(r); curEnd = Math.max(curEnd, r.tsEnd);
  }
  return out;
}

/** Największa liczba zapytań trwających jednocześnie. */
export function maxConcurrency(requests) {
  const ev = requests.flatMap(r => [[r.tsStart, 1], [r.tsEnd, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let c = 0, max = 0;
  for (const [, d] of ev) { c += d; max = Math.max(max, c); }
  return max;
}
