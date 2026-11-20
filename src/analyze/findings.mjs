// Raport analizy: per aplikacja, per żądanie strony; błędy (czyste).
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

/** Analiza zapytań jednego procesu/aplikacji: serie, werdykty, łańcuchy, błędy. */
export function analyzeApp(rs, { idle_gap_ms = 250, seq_gap_ms = 15 }) {
  rs = rs.filter(r => r.tsEnd != null).sort((a, b) => a.tsStart - b.tsStart);
  return {
    total_requests: rs.length,
    errors: rs.filter(isError).map(r => row(r)),
    bursts: bursts(rs, { idleGapMs: idle_gap_ms }).map((b, i) => {
      const t0 = b[0].tsStart, tEnd = Math.max(...b.map(r => r.tsEnd));
      const wall = Math.round((tEnd - t0) * 1000);
      const maxConc = maxConcurrency(b);
      // zależności danych (issue #6): bez nich wynik jak dawniej — wall minus najdłuższe zapytanie
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

/** Ile elementów pokazuje podsumowanie (pełne dane: `detail: "full"` albo `page_request_id`). */
export const SUMMARY_LIMITS = Object.freeze({ pages: 20, errors: 10, inFlight: 10, bursts: 10, duplicates: 10, slow: 5 });

/** Te same zapytania (metoda i URL) więcej niż raz w obrębie jednego żądania strony albo serii. */
export function duplicates(groups) {
  const out = [];
  for (const { page, page_request_id, requests } of groups) {
    for (const [k, rs] of Map.groupBy(requests, r => `${r.method} ${r.url}`)) {
      if (rs.length > 1) out.push({ ...(page ? { page, page_request_id } : {}), request: k.length > 200 ? k.slice(0, 200) + '…' : k, count: rs.length, ids: rs.map(r => r.id) });
    }
  }
  return out;
}

/** Zakończone zapytania trwające co najmniej `slowMs`, od najwolniejszego. */
export const slow = (rs, slowMs) => rs.filter(r => duration(r) >= slowMs).sort((a, b) => duration(b) - duration(a));

const pageLabel = r => `${r.page.method} ${r.page.url}`;
const stripTimeline = ({ timeline, ...rest }) => rest;

/**
 * Raport dla wybranych zapytań: osobno każda aplikacja, w niej osobno każde żądanie strony,
 * a zapytania bez strony dzielone na serie. Domyślnie podsumowanie (bez osi czasu, najnowsze
 * żądania stron); `detail: "full"` albo `page_request_id` daje pełny raport.
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
    // każde przychodzące żądanie strony analizowane osobno — równoległe renderowanie innych stron nie miesza wyników
    const pages = newest(byPage, L.pages).map(reqs => {
      const a = analyzeApp(reqs, { ...args, idle_gap_ms: 1e9 });
      const b = a.bursts[0];
      const pg = reqs[0].page;
      return b && { page: pageLabel(reqs[0]), page_request_id: pg.id,
        ...(pg.nextRequestId ? { next_request_id: pg.nextRequestId } : {}), ...(pg.nextHtmlRequestId ? { next_html_request_id: pg.nextHtmlRequestId } : {}),
        requests: b.requests,
        wall_ms: b.wall_ms, max_concurrency: b.max_concurrency, verdict: b.verdict, verdict_code: b.verdict_code, sequential_chains: b.sequential_chains,
        potential_saving_ms_if_fully_parallel: b.potential_saving_ms_if_fully_parallel,
        ...(b.dependencies ? { dependencies: b.dependencies } : {}), ...(b.dependency_check ? { dependency_check: b.dependency_check } : {}),
        timeline: b.timeline };
    }).filter(Boolean);
    // zapytania bez powiązanej strony (np. zadania w tle, start serwera) — dzielone na serie czasowe
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
      // zapytania bez odpowiedzi nie wchodzą do osi czasu — pokazujemy je osobno zamiast pomijać po cichu
      in_flight: inFlight.length,
      ...(inFlight.length ? { in_flight_requests: newest(inFlight, L.inFlight).map(r => row(r)) } : {}),
      errors: newest(errors, L.errors).map(r => row(r)),
      ...(!full && errors.length > L.errors ? { errors_total: errors.length } : {}),
      by_page_request: full ? pages : pages.map(stripTimeline),
      ...(!full && byPage.length > L.pages ? { page_requests_total: byPage.length } : {}),
      unattributed: full ? unattributed : newest(unattributed, L.bursts).map(stripTimeline),
      ...(Object.keys(findings).length ? { findings } : {}),
      ...(!full ? { detail: 'summary' } : {}),
    }];
  }));
}
