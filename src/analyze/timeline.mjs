// Timeline: durations, bursts, concurrency (pure). Inspector timestamps are in seconds
// and monotonic within a process — timelines of different processes are analyzed separately.

/** Request duration in ms, or null while still running. */
export const duration = r => (r.tsEnd != null && r.tsStart != null) ? Math.round((r.tsEnd - r.tsStart) * 1000) : null;

/** Splits finished requests (sorted by tsStart) into bursts separated by a gap > idleGapMs. */
export function bursts(requests, { idleGapMs }) {
  const out = []; let cur = null, curEnd = -Infinity;
  for (const r of requests) {
    if (!cur || (r.tsStart - curEnd) * 1000 > idleGapMs) { cur = []; out.push(cur); curEnd = -Infinity; }
    cur.push(r); curEnd = Math.max(curEnd, r.tsEnd);
  }
  return out;
}

/** The largest number of requests running at the same time. */
export function maxConcurrency(requests) {
  const ev = requests.flatMap(r => [[r.tsStart, 1], [r.tsEnd, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let c = 0, max = 0;
  for (const [, d] of ev) { c += d; max = Math.max(max, c); }
  return max;
}
