// Sequential chains (waterfall): a request starts at most seqGapMs after the previous one ends,
// and nothing else runs in between (pure). The saving accounts for data dependencies
// (dependencies.mjs): a dependent step cannot start before its source ends.
import { duration } from './timeline.mjs';

const TOL = 0.001;

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

/**
 * The shortest group time after parallelizing everything the dependencies allow (critical path), in ms.
 * A request without dependencies starts immediately; a dependent one — after the latest source ends plus the observed
 * gap before it (app work between a response and the next request). Without edges: the longest request's time.
 */
export function criticalPathMs(group, edges = []) {
  const sorted = [...group].sort((a, b) => a.tsStart - b.tsStart);
  const members = new Set(group), deps = new Map();
  for (const e of edges) if (members.has(e.from) && members.has(e.to)) (deps.get(e.to) ?? deps.set(e.to, []).get(e.to)).push(e.from);
  const byEnd = [...group].sort((a, b) => a.tsEnd - b.tsEnd);
  /** The latest end of another request at or before r starts (binary search). */
  const prevEnd = r => {
    let lo = 0, hi = byEnd.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (byEnd[mid].tsEnd <= r.tsStart + TOL) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1; i >= 0; i--) if (byEnd[i] !== r) return byEnd[i].tsEnd;
    return r.tsStart;
  };
  let finishMax = 0;
  const finish = new Map();
  for (const r of sorted) {
    const ds = deps.get(r);
    const start = ds ? Math.max(...ds.map(a => finish.get(a))) + Math.max(0, r.tsStart - prevEnd(r)) : 0;
    finish.set(r, start + (r.tsEnd - r.tsStart));
    finishMax = Math.max(finishMax, finish.get(r));
  }
  return Math.round(finishMax * 1000);
}

/** Whether step `to` depends (directly or through other steps) on step `from`. */
const reaches = (edges, from, to) => {
  const seen = new Set(), stack = [from];
  while (stack.length) {
    const x = stack.pop();
    for (const e of edges) if (e.from === x && !seen.has(e.to)) { if (e.to === to) return true; seen.add(e.to); stack.push(e.to); }
  }
  return false;
};

export const HINTS = Object.freeze({
  independent: 'If these requests do not depend on each other, Promise.all cuts this part down to the time of the slowest one.',
  dependent: 'Each step uses data from the previous response (see dependencies), so running them in parallel (Promise.all) is not possible. '
    + 'Only a change on the services side shortens this part, e.g. one request returning all the data, or faster responses.',
  partial: steps => `Steps ${steps} wait for data from earlier responses (see dependencies) and cannot start together with them. `
    + 'Run only mutually independent steps in parallel and start each dependent step right after its source, e.g. Promise.all([a().then(b), c()]) '
    + 'or a().then(x => Promise.all([b(x), c(x)])); potential_saving_ms takes these dependencies into account.',
});

/**
 * @param {any[]} ch chain steps
 * @param {ReturnType<import('./dependencies.mjs').dependencyGraph>} [graph] dependencies in the burst the chain comes from
 */
export function describeChain(ch, graph) {
  const w = Math.round((ch.at(-1).tsEnd - ch[0].tsStart) * 1000);
  const edges = (graph?.edges ?? []).filter(e => ch.includes(e.from) && ch.includes(e.to));
  const p = criticalPathMs(ch, edges);
  const serial = edges.length > 0 && ch.every((r, i) => i === 0 || reaches(edges, ch[i - 1], r));
  const dependentSteps = [...new Set(edges.map(e => ch.indexOf(e.to)))].sort((a, b) => a - b);
  const check = graph?.check(ch);
  return {
    length: ch.length, wall_ms: w, if_parallel_ms: p, potential_saving_ms: Math.max(0, w - p),
    steps: ch.map(r => `${r.method} ${r.url} (${duration(r)} ms)`),
    hint: !edges.length ? HINTS.independent : serial ? HINTS.dependent : HINTS.partial(dependentSteps.map(i => `steps[${i}]`).join(', ')),
    // steps counted from 0 in `steps`; id for get_server_request
    dependencies: edges.map(e => ({ from_step: ch.indexOf(e.from), to_step: ch.indexOf(e.to), from_id: e.from.id, to_id: e.to.id, evidence: e.evidence })),
    ...(check ? { dependency_check: check } : {}),
  };
}
