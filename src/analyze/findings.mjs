// Raport analizy: per aplikacja, per żądanie strony; błędy (czyste).
import { duration, bursts, maxConcurrency } from './timeline.mjs';
import { chains, describeChain } from './waterfall.mjs';
import { row } from '../mcp/render.mjs';

const isError = r => r.state === 'failed' || r.status >= 400;

const VERDICTS = {
  single: 'pojedyncze zapytanie',
  sequential: 'SEKWENCYJNIE (waterfall) — każde zapytanie czeka na poprzednie',
  parallel: 'RÓWNOLEGLE — wszystkie zapytania naraz',
  mixed: 'MIESZANE — część równolegle, część sekwencyjnie',
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
      const longest = Math.max(...b.map(duration));
      return {
        burst: i + 1, requests: b.length, wall_ms: wall, sum_of_durations_ms: b.reduce((s, r) => s + duration(r), 0), max_concurrency: maxConc,
        verdict: VERDICTS[verdictCode(b.length, maxConc)], verdict_code: verdictCode(b.length, maxConc),
        sequential_chains: chains(b, { seqGapMs: seq_gap_ms }).map(describeChain),
        potential_saving_ms_if_fully_parallel: wall - longest,
        timeline: b.map(r => row(r, t0)),
      };
    }),
  };
}

/**
 * Raport dla wybranych zapytań: osobno każda aplikacja, w niej osobno każde żądanie strony,
 * a zapytania bez strony dzielone na serie.
 */
export function analyze(rs, args = {}, appsSeen = []) {
  if (!rs.length) return { summary: 'Brak zapytań w wybranym zakresie.', apps_with_traffic: appsSeen };
  const byApp = Map.groupBy(rs, r => r.app);
  return Object.fromEntries([...byApp].map(([app, list]) => {
    const withPage = list.filter(r => r.page), without = list.filter(r => !r.page);
    const byPage = Map.groupBy(withPage, r => r.page.id);
    const inFlight = list.filter(r => r.tsEnd == null);
    return [app, {
      total_requests: list.length,
      // zapytania bez odpowiedzi nie wchodzą do osi czasu — pokazujemy je osobno zamiast pomijać po cichu
      in_flight: inFlight.length,
      ...(inFlight.length ? { in_flight_requests: inFlight.map(r => row(r)) } : {}),
      errors: list.filter(isError).map(r => row(r)),
      // każde przychodzące żądanie strony analizowane osobno — równoległe renderowanie innych stron nie miesza wyników
      by_page_request: [...byPage].map(([, reqs]) => {
        const a = analyzeApp(reqs, { ...args, idle_gap_ms: 1e9 });
        const b = a.bursts[0];
        return b && { page: `${reqs[0].page.method} ${reqs[0].page.url}`, page_request_id: reqs[0].page.id, requests: b.requests,
          wall_ms: b.wall_ms, max_concurrency: b.max_concurrency, verdict: b.verdict, verdict_code: b.verdict_code, sequential_chains: b.sequential_chains,
          potential_saving_ms_if_fully_parallel: b.potential_saving_ms_if_fully_parallel, timeline: b.timeline };
      }).filter(Boolean),
      // zapytania bez powiązanej strony (np. zadania w tle, start serwera) — dzielone na serie czasowe
      unattributed: without.length ? analyzeApp(without, args).bursts : [],
    }];
  }));
}
