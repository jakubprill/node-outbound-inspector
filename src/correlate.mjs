// Przypisanie zapytań wychodzących do żądania strony na podstawie wpisów haka
// (metoda + URL + czas; czyste — czas przychodzi jako argument).

/**
 * @param {any[]} pool rekordy procesu bez przypisanej strony
 * @param {{ url: string, method: string, page: object, t: number }[]} entries nowe wpisy haka
 * @param {any[]} pending wpisy, których nie udało się dopasować wcześniej (modyfikowane w miejscu)
 * @param {number} nowMs
 */
export function applyPageEntries(pool, entries, pending, nowMs) {
  for (const e of entries) {
    const norm = u => u.replace(/:(80|443)(?=\/)/, '');
    const cand = pool.filter(r => !r.page && r.method === e.method && (norm(r.url) === norm(e.url) || r.url.endsWith(e.url.replace(/^https?:\/\/[^/]+/, '')))
      && Math.abs(r.wallStart - e.t) < 3000).sort((a, b) => Math.abs(a.wallStart - e.t) - Math.abs(b.wallStart - e.t))[0];
    if (cand) cand.page = e.page; else pending.push(e);
  }
  // nieprzypisane wpisy wygasają po 10 s także pod ciągłym ruchem; najwyżej 1000 (audyt B-11)
  if (pending.length) { const keep = pending.filter(e => nowMs - e.t < 10000).slice(-1000); pending.splice(0, pending.length, ...keep); }
  // wpisy, które przyszły przed zdarzeniem Network — spróbuj ponownie przy następnym odpytaniu
  if (pending.length && entries.length === 0) {
    const retry = pending.splice(0).filter(e => nowMs - e.t < 10000);
    for (const e of retry) {
      const c = pool.find(r => !r.page && r.method === e.method && Math.abs(r.wallStart - e.t) < 3000 && r.url.includes(e.url.replace(/^https?:\/\/[^/]+/, '')));
      if (c) c.page = e.page; else pending.push(e);
    }
  }
}
