// Analysis report: per app, per page request; errors (pure).
import { duration, bursts, maxConcurrency } from './timeline.mjs';
import { chains, describeChain, criticalPathMs } from './waterfall.mjs';
import { dependencyGraph } from './dependencies.mjs';
import { row } from '../mcp/render.mjs';

const isError = r => r.state === 'failed' || r.status >= 400;

const VERDICTS = {
  single: 'single request',
  sequential: 'SEQUENTIAL (waterfall) — each request waits for the previous one',
  parallel: 'PARALLEL — all requests at once',
  mixed: 'MIXED — some in parallel, some sequential',
};
const verdictCode = (n, conc) => n === 1 ? 'single' : conc === 1 ? 'sequential' : conc === n ? 'parallel' : 'mixed';

/** Analysis of one process's/app's requests: bursts, verdicts, chains, errors. */
export function analyzeApp(rs, { idle_gap_ms = 250, seq_gap_ms = 15 }) {
  rs = rs.filter(r => r.tsEnd != null).sort((a, b) => a.tsStart - b.tsStart);
  return {
    total_requests: rs.length,
    errors: rs.filter(isError).map(r => row(r)),
    bursts: bursts(rs, { idleGapMs: idle_gap_ms }).map((b, i) => {
      const t0 = b[0].tsStart, tEnd = Math.max(...b.map(r => r.tsEnd));
      const wall = Math.round((tEnd - t0) * 1000);
      const maxConc = maxConcurrency(b);
      // data dependencies (issue #6): without them the result is as before — wall minus the longest request
      const graph = dependencyGraph(b), check = graph.check(b);
      return {
        burst: i + 1, requests: b.length, wall_ms: wall, sum_of_durations_ms: b.reduce((s, r) => s + duration(r), 0), max_concurrency: maxConc,
        verdict: VERDICTS[verdictCode(b.length, maxConc)], verdict_code: verdictCode(b.length, maxConc),
        sequential_chains: chains(b, { seqGapMs: seq_gap_ms }).map(ch => describeChain(ch, graph)),
        potential_saving_ms_if_fully_parallel: Math.max(0, wall - criticalPathMs(b, graph.edges)),
        ...(graph.edges.length ? { dependencies: graph.edges.map(e => ({ from_id: e.from.id, to_id: e.to.id, evidence: e.evidence })) } : {}),
        ...(check ? { dependency_check: check } : {}),
        timeline: b.map(r => row(r, t0)),
      };
    }),
  };
}

/** How many items the summary shows (full data: `detail: "full"` or `page_request_id`). */
export const SUMMARY_LIMITS = Object.freeze({ pages: 20, errors: 5, inFlight: 5, bursts: 5, duplicates: 5, slow: 3, analyzedPages: 200 });

/** A hint added once to the summary (instead of repeating descriptions for every page). */
export const SUMMARY_HINT = 'Summary: one entry per page (repeated visits grouped), numbers and codes only. '
  + 'Pass page_request_id for one page request (timeline, waterfall steps, hints, data dependencies) or detail: "full" for everything.';

/** Saving from sequential steps accounting for data dependencies (sum over chains). */
const chainSaving = p => (p.sequential_chains ?? []).reduce((sum, c) => sum + (c.potential_saving_ms ?? 0), 0);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

/** A compact summary entry: repeated visits to the same page in one entry, data of the newest visit. */
function pageGroup(visits) {
  const last = visits.at(-1), saving = chainSaving(last), errors = last.errors ?? 0;
  return {
    page: last.page, visits: visits.length, page_request_id: last.page_request_id,
    ...(last.next_request_id ? { next_request_id: last.next_request_id } : {}), ...(last.next_html_request_id ? { next_html_request_id: last.next_html_request_id } : {}),
    requests: last.requests, wall_ms: last.wall_ms,
    ...(visits.length > 1 ? { wall_ms_median: median(visits.map(v => v.wall_ms)), wall_ms_max: Math.max(...visits.map(v => v.wall_ms)) } : {}),
    verdict_code: last.verdict_code, ...(saving > 0 ? { potential_saving_ms: saving } : {}), ...(errors ? { errors } : {}),
  };
}
const compactBurst = b => ({ requests: b.requests, wall_ms: b.wall_ms, verdict_code: b.verdict_code,
  ...(chainSaving(b) > 0 ? { potential_saving_ms: chainSaving(b) } : {}) });

/** The same requests (method and URL) more than once within one page request or burst. */
export function duplicates(groups) {
  const out = [];
  for (const { page, page_request_id, requests } of groups) {
    for (const [k, rs] of Map.groupBy(requests, r => `${r.method} ${r.url}`)) {
      if (rs.length > 1) out.push({ ...(page ? { page, page_request_id } : {}), request: k.length > 200 ? k.slice(0, 200) + '…' : k, count: rs.length, ids: rs.map(r => r.id) });
    }
  }
  return out;
}

/** Finished requests lasting at least `slowMs`, slowest first. */
export const slow = (rs, slowMs) => rs.filter(r => duration(r) >= slowMs).sort((a, b) => duration(b) - duration(a));

const pageLabel = r => `${r.page.method} ${r.page.url}`;

/**
 * Report for the selected requests: each app separately, and within it each page request separately,
 * while requests without a page are split into bursts. A summary by default (no timeline, the newest
 * page requests); `detail: "full"` or `page_request_id` gives the full report.
 */
export function analyze(rs, args = {}, appsSeen = []) {
  if (!rs.length) return { summary: 'No requests in the selected range.', apps_with_traffic: appsSeen };
  const full = args.detail === 'full' || (args.page_request_id != null && args.page_request_id !== '');
  const slowMs = args.slow_ms ?? 1000;
  const L = SUMMARY_LIMITS;
  const newest = (list, n) => full ? list : list.slice(-n);
  const byApp = Map.groupBy(rs, r => r.app);
  return Object.fromEntries([...byApp].map(([app, list]) => {
    const withPage = list.filter(r => r.page), without = list.filter(r => !r.page);
    const byPage = [...Map.groupBy(withPage, r => r.page.id)].map(([, reqs]) => reqs);
    const inFlight = list.filter(r => r.tsEnd == null);
    const errors = list.filter(isError);
    // every incoming page request analyzed separately — parallel rendering of other pages does not mix results
    const pages = newest(byPage, full ? Infinity : L.analyzedPages).map(reqs => {
      const a = analyzeApp(reqs, { ...args, idle_gap_ms: 1e9 });
      const b = a.bursts[0];
      const pg = reqs[0].page;
      return b && { page: pageLabel(reqs[0]), page_request_id: pg.id,
        ...(pg.nextRequestId ? { next_request_id: pg.nextRequestId } : {}), ...(pg.nextHtmlRequestId ? { next_html_request_id: pg.nextHtmlRequestId } : {}),
        requests: b.requests,
        wall_ms: b.wall_ms, max_concurrency: b.max_concurrency, verdict: b.verdict, verdict_code: b.verdict_code, sequential_chains: b.sequential_chains,
        potential_saving_ms_if_fully_parallel: b.potential_saving_ms_if_fully_parallel,
        ...(b.dependencies ? { dependencies: b.dependencies } : {}), ...(b.dependency_check ? { dependency_check: b.dependency_check } : {}),
        errors: reqs.filter(isError).length,
        timeline: b.timeline };
    }).filter(Boolean);
    // requests without a linked page (e.g. background jobs, server start) — split into time bursts
    const unattributed = without.length ? analyzeApp(without, args).bursts : [];
    const dup = duplicates([
      ...byPage.map(reqs => ({ page: pageLabel(reqs[0]), page_request_id: reqs[0].page.id, requests: reqs })),
      ...bursts(without.filter(r => r.tsEnd != null).sort((a, b) => a.tsStart - b.tsStart), { idleGapMs: args.idle_gap_ms ?? 250 }).map(requests => ({ requests })),
    ]);
    const slowRs = slow(list, slowMs);
    const findings = {
      ...(dup.length ? { duplicates: newest(dup, L.duplicates) } : {}),
      ...(slowRs.length ? { slow: (full ? slowRs : slowRs.slice(0, L.slow)).map(r => row(r)), slow_threshold_ms: slowMs } : {}),
    };
    return [app, {
      total_requests: list.length,
      // requests without a response do not enter the timeline — we show them separately instead of dropping them silently
      in_flight: inFlight.length,
      ...(inFlight.length ? { in_flight_requests: newest(inFlight, L.inFlight).map(r => row(r)) } : {}),
      errors: newest(errors, L.errors).map(r => row(r)),
      ...(!full && errors.length > L.errors ? { errors_total: errors.length } : {}),
      ...(full
        ? { by_page_request: pages.map(({ errors: _e, ...p }) => p), unattributed }
        : (() => {
          // groups in order of the last visit; the newest pages at the end, as in the other lists
          const groups = [...Map.groupBy(pages, p => p.page).values()].sort((a, b) => pages.indexOf(a.at(-1)) - pages.indexOf(b.at(-1)));
          return {
            pages: groups.slice(-L.pages).map(pageGroup),
            page_requests_total: byPage.length,
            ...(groups.length > L.pages ? { pages_total: groups.length } : {}),
            unattributed: newest(unattributed, L.bursts).map(compactBurst),
          };
        })()),
      ...(Object.keys(findings).length ? { findings } : {}),

    }];
  }));
}
