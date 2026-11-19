// Łańcuchy sekwencyjne (waterfall): zapytanie startuje najpóźniej seqGapMs po zakończeniu poprzedniego,
// a w międzyczasie nic innego nie trwa (czyste).
import { duration } from './timeline.mjs';

export function chains(burst, { seqGapMs }) {
  const found = []; const used = new Set();
  for (const a of burst) {
    if (used.has(a)) continue;
    const chain = [a]; let last = a;
    for (;;) {
      const next = burst.find(n => !used.has(n) && n !== last && !chain.includes(n)
        && n.tsStart >= last.tsEnd - 0.001 && (n.tsStart - last.tsEnd) * 1000 <= seqGapMs
        && !burst.some(o => o !== last && o !== n && o.tsStart < n.tsStart && o.tsEnd > last.tsEnd));
      if (!next) break; chain.push(next); last = next;
    }
    if (chain.length > 1) { chain.forEach(x => used.add(x)); found.push(chain); }
  }
  return found;
}

export function describeChain(ch) {
  const w = Math.round((ch.at(-1).tsEnd - ch[0].tsStart) * 1000), p = Math.max(...ch.map(duration));
  return {
    length: ch.length, wall_ms: w, if_parallel_ms: p, potential_saving_ms: w - p,
    steps: ch.map(r => `${r.method} ${r.url} (${duration(r)} ms)`),
    hint: 'Jeśli te zapytania nie zależą od siebie, Promise.all skróci ten fragment do czasu najwolniejszego z nich.',
  };
}
