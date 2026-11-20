// Assigning outbound requests to the page request based on hook entries
// (method + URL + time; pure — time comes in as an argument).

/**
 * @param {any[]} pool the process's records without an assigned page
 * @param {{ url: string, method: string, page: object, t: number }[]} entries new hook entries
 * @param {any[]} pending entries that could not be matched earlier (modified in place)
 * @param {number} nowMs
 */
export function applyPageEntries(pool, entries, pending, nowMs) {
  for (const e of entries) {
    const norm = u => u.replace(/:(80|443)(?=\/)/, '');
    const cand = pool.filter(r => !r.page && r.method === e.method && (norm(r.url) === norm(e.url) || r.url.endsWith(e.url.replace(/^https?:\/\/[^/]+/, '')))
      && Math.abs(r.wallStart - e.t) < 3000).sort((a, b) => Math.abs(a.wallStart - e.t) - Math.abs(b.wallStart - e.t))[0];
    if (cand) cand.page = e.page; else pending.push(e);
  }
  // unassigned entries expire after 10 s, also under continuous traffic; at most 1000 (audit B-11)
  if (pending.length) { const keep = pending.filter(e => nowMs - e.t < 10000).slice(-1000); pending.splice(0, pending.length, ...keep); }
  // entries that arrived before the Network event — retry at the next poll
  if (pending.length && entries.length === 0) {
    const retry = pending.splice(0).filter(e => nowMs - e.t < 10000);
    for (const e of retry) {
      const c = pool.find(r => !r.page && r.method === e.method && Math.abs(r.wallStart - e.t) < 3000 && r.url.includes(e.url.replace(/^https?:\/\/[^/]+/, '')));
      if (c) c.page = e.page; else pending.push(e);
    }
  }
}
