#!/usr/bin/env node
// outbound-mcp: serwer MCP (stdio) dający agentowi wgląd w ruch sieciowy procesów Node
// uruchomionych z `--inspect=<port> --experimental-network-inspection` — także kilku naraz
// (np. monorepo z kilkoma aplikacjami Next.js uruchamianymi równolegle).
// Bez zależności: MCP (JSON-RPC 2.0 po stdio) + klient CDP po WebSocket. Wymaga Node >= 22.
// Repozytorium: https://github.com/jakubprill/node-outbound-inspector
//
// Podłączenie do agenta:  claude mcp add outbound -- node /ścieżka/src/outbound-mcp.mjs
//
// Zmienne środowiskowe:
//   INSPECTOR_PORTS  porty/zakresy inspektorów do skanowania, np. "9229-9249" (domyślnie) lub "9231,9241"
//   APP_NAMES        opcjonalne nazwy aplikacji po porcie, np. "9231=web,9241=admin"
//                    (domyślnie: npm_package_name procesu → name z package.json w cwd → nazwa katalogu)
//   IGNORE_HOSTS     hosty pomijane (domyślnie registry.npmjs.org)
//   PAGE_CORRELATION 0 = bez wstrzykiwania kodu korelującego zapytania z żądaniem strony
//   MAX_REQUESTS     rozmiar bufora (domyślnie 5000)

import { readFileSync } from 'node:fs';
import path from 'node:path';

const PORTS = (process.env.INSPECTOR_PORTS || '9229-9249').split(',').flatMap(part => {
  const [a, b] = part.trim().split('-').map(Number);
  return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
}).filter(Boolean);
const APP_NAMES = Object.fromEntries((process.env.APP_NAMES || '').split(',').filter(Boolean).map(kv => kv.split('=').map(s => s.trim())));
const IGNORE = (process.env.IGNORE_HOSTS ?? 'registry.npmjs.org').split(',').filter(Boolean);
const MAX = Number(process.env.MAX_REQUESTS || 5000);
const log = (...a) => process.stderr.write('[outbound-mcp] ' + a.join(' ') + '\n');

// ---------------------------------------------------------------- CDP
const sessions = new Map(); // wsUrl -> sesja
const requests = new Map(); // key -> rekord
let seq = 0;

function userFrames(initiator) {
  const frames = [];
  for (let st = initiator?.stack; st; st = st.parent) frames.push(...(st.callFrames ?? []));
  return frames
    .filter(f => f.url && !f.url.startsWith('node:')
      && !/node_modules[\\/](next|react|react-dom|undici)[\\/]/.test(f.url)
      && !/[\\/]\.next[\\/].*_next_dist_|[\\/]\.next[\\/]server[\\/](edge-)?runtime|next[\\/]dist[\\/]/.test(f.url)) // wnętrze Next.js
    .slice(0, 5)
    .map(f => `${f.functionName || '(anonymous)'} @ ${f.url.replace(/^file:\/\//, '')}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
}

// Kim jest proces po drugiej stronie inspektora? (w monorepo tytuł procesu bywa identyczny dla wszystkich aplikacji)
async function identify(sess) {
  const res = await sess.send('Runtime.evaluate', {
    expression: 'JSON.stringify({ cwd: process.cwd(), pkg: process.env.npm_package_name || null, pid: process.pid, argv: process.argv.slice(1).join(" ") })',
    returnByValue: true,
  });
  let info = {};
  try { info = JSON.parse(res?.result?.value ?? '{}'); } catch {}
  let pkgName = null;
  if (info.cwd) { try { pkgName = JSON.parse(readFileSync(path.join(info.cwd, 'package.json'), 'utf8')).name; } catch {} }
  sess.pid = info.pid; sess.cwd = info.cwd; sess.argv = info.argv;
  sess.app = APP_NAMES[sess.port] || info.pkg || pkgName || (info.cwd ? path.basename(info.cwd) : `port-${sess.port}`);
}

// Korelacja ze stroną: wstrzykiwany do procesu kod, który przy każdym przychodzącym żądaniu HTTP
// zapamiętuje je w AsyncLocalStorage, a przy każdym wychodzącym zapytaniu (fetch/undici, node:http)
// zapisuje, w kontekście którego żądania strony powstało. Bez zmian w kodzie aplikacji.
const PAGE_CORRELATION = process.env.PAGE_CORRELATION !== '0';
const INJECT = `(() => {
  if (globalThis.__outboundInspector) return 'already';
  const dc = process.getBuiltinModule('node:diagnostics_channel');
  const { AsyncLocalStorage } = process.getBuiltinModule('node:async_hooks');
  const als = new AsyncLocalStorage(); const log = []; let n = 0;
  globalThis.__outboundInspector = { log };
  dc.subscribe('http.server.request.start', ({ request }) => {
    als.enterWith({ id: process.pid + '-' + (++n), method: request.method, url: request.url, t: Date.now() });
  });
  const rec = (url, method) => { const s = als.getStore(); if (s) { log.push({ url, method, page: s, t: Date.now() }); if (log.length > 5000) log.shift(); } };
  dc.subscribe('undici:request:create', ({ request }) => rec(request.origin + request.path, request.method));
  dc.subscribe('http.client.request.start', ({ request }) => rec(request.protocol + '//' + request.host + (request.port ? '' : '') + request.path, request.method));
  return 'installed';
})()`;

async function pollPages(sess) {
  if (!PAGE_CORRELATION || !sess.pageCorrelation) return;
  const res = await sess.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__outboundInspector ? globalThis.__outboundInspector.log.splice(0) : [])', returnByValue: true });
  let entries = []; try { entries = JSON.parse(res?.result?.value ?? '[]'); } catch {}
  const pool = [...requests.values()].filter(r => r.port === sess.port && r.pid === sess.pid && !r.page);
  for (const e of entries) {
    const norm = u => u.replace(/:(80|443)(?=\/)/, '');
    const cand = pool.filter(r => !r.page && r.method === e.method && (norm(r.url) === norm(e.url) || r.url.endsWith(e.url.replace(/^https?:\/\/[^/]+/, '')))
      && Math.abs(r.wallStart - e.t) < 3000).sort((a, b) => Math.abs(a.wallStart - e.t) - Math.abs(b.wallStart - e.t))[0];
    if (cand) cand.page = e.page; else sess.pendingPages.push(e);
  }
  // wpisy, które przyszły przed zdarzeniem Network — spróbuj ponownie przy następnym odpytaniu
  if (sess.pendingPages.length && entries.length === 0) {
    const retry = sess.pendingPages.splice(0).filter(e => Date.now() - e.t < 10000);
    for (const e of retry) { const c = pool.find(r => !r.page && r.method === e.method && Math.abs(r.wallStart - e.t) < 3000 && r.url.includes(e.url.replace(/^https?:\/\/[^/]+/, ''))); if (c) c.page = e.page; else sess.pendingPages.push(e); }
  }
}
const pollAll = () => Promise.all([...sessions.values()].map(pollPages));
setInterval(pollAll, 1000).unref();

function onEvent(sess, method, p) {
  const key = `${sess.port}:${p.requestId}`;
  if (method === 'Network.requestWillBeSent') {
    let host = '';
    try { host = new URL(p.request.url).host; } catch {}
    if (IGNORE.some(h => host.includes(h))) return;
    if (PORTS.some(port => host === `127.0.0.1:${port}` || host === `localhost:${port}`)) return; // ruch do inspektorów
    if (requests.size >= MAX) requests.delete(requests.keys().next().value);
    requests.set(key, {
      id: ++seq, key, app: sess.app, port: sess.port, pid: sess.pid, requestId: p.requestId,
      method: p.request.method, url: p.request.url, requestHeaders: p.request.headers,
      wallStart: p.wallTime ?? Date.now(), tsStart: p.timestamp,
      origin: userFrames(p.initiator),
    });
    return;
  }
  const r = requests.get(key);
  if (!r) return;
  if (method === 'Network.responseReceived') {
    r.status = p.response.status; r.statusText = p.response.statusText;
    r.mimeType = p.response.mimeType; r.responseHeaders = p.response.headers; r.type = p.type;
  } else if (method === 'Network.loadingFinished') {
    r.tsEnd = p.timestamp; r.state = 'finished';
    sess.send('Network.getResponseBody', { requestId: p.requestId }).then(res => {
      if (res) r.body = res.base64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
    }).catch(() => {});
  } else if (method === 'Network.loadingFailed') {
    r.tsEnd = p.timestamp; r.state = 'failed'; r.error = p.errorText;
  }
}

async function attach(port) {
  let list;
  try { list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json(); }
  catch { return; }
  for (const t of list) {
    const url = t.webSocketDebuggerUrl;
    if (!url || sessions.has(url)) continue;
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    const sess = { ws, port, title: t.title, url, connectedAt: new Date().toISOString(), app: `port-${port}`,
      send: (method, params = {}) => new Promise(res => {
        if (ws.readyState !== 1) return res(null);
        const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
        setTimeout(() => { if (pending.delete(i)) res(null); }, 3000);
      }) };
    sessions.set(url, sess);
    ws.onopen = async () => {
      await identify(sess);
      sess.networkOk = !!(await sess.send('Network.enable'));
      sess.pendingPages = [];
      if (PAGE_CORRELATION) {
        const r = await sess.send('Runtime.evaluate', { expression: INJECT, returnByValue: true });
        sess.pageCorrelation = ['installed', 'already'].includes(r?.result?.value);
      }
      log(`podłączono app="${sess.app}" port=${port} pid=${sess.pid} cwd=${sess.cwd} korelacja_stron=${!!sess.pageCorrelation}${sess.networkOk ? '' : ' (Network.enable bez odpowiedzi — brak --experimental-network-inspection?)'}`);
    };
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.error ? null : m.result); pending.delete(m.id); return; }
      if (m.method?.startsWith('Network.')) onEvent(sess, m.method, m.params);
    };
    ws.onclose = () => { sessions.delete(url); log(`rozłączono app="${sess.app}" port=${port}`); };
    ws.onerror = () => {};
  }
}
const scan = () => PORTS.forEach(attach);
setInterval(scan, 1500).unref();
scan();

// ---------------------------------------------------------------- analiza
const dur = r => (r.tsEnd != null && r.tsStart != null) ? Math.round((r.tsEnd - r.tsStart) * 1000) : null;
const appsSeen = () => [...new Set([...requests.values()].map(r => r.app))];

function select({ app, url_contains, page_contains, last_ms, since_id } = {}) {
  let rs = [...requests.values()];
  if (app) rs = rs.filter(r => r.app === app || String(r.port) === String(app));
  if (url_contains) rs = rs.filter(r => r.url.includes(url_contains));
  if (page_contains) rs = rs.filter(r => r.page && `${r.page.method} ${r.page.url}`.includes(page_contains));
  if (since_id) rs = rs.filter(r => r.id > since_id);
  if (last_ms) { const cut = Date.now() - last_ms; rs = rs.filter(r => r.wallStart >= cut); }
  return rs.sort((a, b) => a.wallStart - b.wallStart || a.tsStart - b.tsStart);
}

function row(r, t0) {
  return {
    id: r.id, app: r.app, page: r.page ? `${r.page.method} ${r.page.url}` : null, method: r.method, url: r.url,
    status: r.state === 'failed' ? `FAILED: ${r.error}` : (r.status ?? 'pending'),
    start_ms: t0 != null ? Math.round((r.tsStart - t0) * 1000) : undefined,
    duration_ms: dur(r),
    origin: r.origin[0] ?? '(brak ramki z kodu aplikacji — np. fetch opakowany przez Next.js; szukaj po URL)',
  };
}

// Analiza jednej aplikacji (znaczniki czasu inspektora są monotoniczne w obrębie procesu,
// więc osie czasu różnych procesów analizujemy osobno).
function analyzeApp(rs, { idle_gap_ms = 250, seq_gap_ms = 15 }) {
  rs = rs.filter(r => r.tsEnd != null).sort((a, b) => a.tsStart - b.tsStart);
  const bursts = []; let cur = null, curEnd = -Infinity;
  for (const r of rs) {
    if (!cur || (r.tsStart - curEnd) * 1000 > idle_gap_ms) { cur = []; bursts.push(cur); curEnd = -Infinity; }
    cur.push(r); curEnd = Math.max(curEnd, r.tsEnd);
  }
  return {
    total_requests: rs.length,
    errors: rs.filter(r => r.state === 'failed' || r.status >= 400).map(r => row(r)),
    bursts: bursts.map((b, i) => {
      const t0 = b[0].tsStart, tEnd = Math.max(...b.map(r => r.tsEnd));
      const wall = Math.round((tEnd - t0) * 1000);
      const ev = b.flatMap(r => [[r.tsStart, 1], [r.tsEnd, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let c = 0, maxConc = 0; for (const [, d] of ev) { c += d; maxConc = Math.max(maxConc, c); }
      const chains = []; const used = new Set();
      for (const a of b) {
        if (used.has(a)) continue;
        const chain = [a]; let last = a;
        for (;;) {
          const next = b.find(n => !used.has(n) && n !== last && !chain.includes(n)
            && n.tsStart >= last.tsEnd - 0.001 && (n.tsStart - last.tsEnd) * 1000 <= seq_gap_ms
            && !b.some(o => o !== last && o !== n && o.tsStart < n.tsStart && o.tsEnd > last.tsEnd));
          if (!next) break; chain.push(next); last = next;
        }
        if (chain.length > 1) { chain.forEach(x => used.add(x)); chains.push(chain); }
      }
      const longest = Math.max(...b.map(dur));
      return {
        burst: i + 1, requests: b.length, wall_ms: wall, sum_of_durations_ms: b.reduce((s, r) => s + dur(r), 0), max_concurrency: maxConc,
        verdict: b.length === 1 ? 'pojedyncze zapytanie'
          : maxConc === 1 ? 'SEKWENCYJNIE (waterfall) — każde zapytanie czeka na poprzednie'
          : maxConc === b.length ? 'RÓWNOLEGLE — wszystkie zapytania naraz'
          : 'MIESZANE — część równolegle, część sekwencyjnie',
        sequential_chains: chains.map(ch => {
          const w = Math.round((ch.at(-1).tsEnd - ch[0].tsStart) * 1000), p = Math.max(...ch.map(dur));
          return { length: ch.length, wall_ms: w, if_parallel_ms: p, potential_saving_ms: w - p,
            steps: ch.map(r => `${r.method} ${r.url} (${dur(r)} ms)`),
            hint: 'Jeśli te zapytania nie zależą od siebie, Promise.all skróci ten fragment do czasu najwolniejszego z nich.' };
        }),
        potential_saving_ms_if_fully_parallel: wall - longest,
        timeline: b.map(r => row(r, t0)),
      };
    }),
  };
}

function analyze(args = {}) {
  const rs = select(args);
  if (!rs.length) return { summary: 'Brak zapytań w wybranym zakresie.', apps_with_traffic: appsSeen() };
  const byApp = Map.groupBy(rs, r => r.app);
  return Object.fromEntries([...byApp].map(([app, list]) => {
    const withPage = list.filter(r => r.page), without = list.filter(r => !r.page);
    const byPage = Map.groupBy(withPage, r => r.page.id);
    return [app, {
      total_requests: list.length,
      errors: list.filter(r => r.state === 'failed' || r.status >= 400).map(r => row(r)),
      // każde przychodzące żądanie strony analizowane osobno — równoległe renderowanie innych stron nie miesza wyników
      by_page_request: [...byPage].map(([, reqs]) => {
        const a = analyzeApp(reqs, { ...args, idle_gap_ms: 1e9 });
        const b = a.bursts[0];
        return b && { page: `${reqs[0].page.method} ${reqs[0].page.url}`, page_request_id: reqs[0].page.id, requests: b.requests,
          wall_ms: b.wall_ms, max_concurrency: b.max_concurrency, verdict: b.verdict, sequential_chains: b.sequential_chains,
          potential_saving_ms_if_fully_parallel: b.potential_saving_ms_if_fully_parallel, timeline: b.timeline };
      }).filter(Boolean),
      // zapytania bez powiązanej strony (np. zadania w tle, start serwera) — dzielone na serie czasowe
      unattributed: without.length ? analyzeApp(without, args).bursts : [],
    }];
  }));
}

// ---------------------------------------------------------------- narzędzia MCP
const sel = {
  app: { type: 'string', description: 'Nazwa aplikacji (z inspector_status) lub port inspektora. Pomiń, aby objąć wszystkie.' },
  url_contains: { type: 'string', description: 'Filtr: fragment URL zapytania wychodzącego' },
  page_contains: { type: 'string', description: 'Filtr: fragment żądania strony, które wywołało zapytanie, np. "/checkout"' },
  last_ms: { type: 'number', description: 'Tylko zapytania z ostatnich N milisekund' },
  since_id: { type: 'number', description: 'Tylko zapytania o id większym niż podane' },
};
const tools = {
  inspector_status: {
    description: 'Lista podłączonych procesów/aplikacji (nazwa, port inspektora, pid, katalog) i liczba zebranych zapytań. Wywołaj najpierw, aby poznać nazwy aplikacji.',
    inputSchema: { type: 'object', properties: {} },
    run: () => ({
      ports_scanned: `${PORTS[0]}-${PORTS.at(-1)} (${PORTS.length})`, ignored_hosts: IGNORE,
      apps: [...sessions.values()].map(s => ({ app: s.app, port: s.port, pid: s.pid, cwd: s.cwd, network_inspection: !!s.networkOk, page_correlation: !!s.pageCorrelation, since: s.connectedAt,
        buffered_requests: [...requests.values()].filter(r => r.app === s.app).length })),
      buffered_requests_total: requests.size, last_id: seq,
    }),
  },
  list_server_requests: {
    description: 'Lista zapytań HTTP wykonanych przez procesy Node (fetch i node:http): aplikacja, metoda, URL, status, czas trwania, miejsce w kodzie.',
    inputSchema: { type: 'object', properties: { ...sel, limit: { type: 'number', description: 'Maks. liczba wyników (domyślnie 50, najnowsze)' } } },
    run: (a) => select(a).slice(-(a.limit || 50)).map(r => row(r)),
  },
  get_server_request: {
    description: 'Szczegóły jednego zapytania: nagłówki żądania i odpowiedzi, treść odpowiedzi, stos wywołań.',
    inputSchema: { type: 'object', properties: { id: { type: 'number' }, max_body_chars: { type: 'number' } }, required: ['id'] },
    run: ({ id, max_body_chars = 4000 }) => {
      const r = [...requests.values()].find(x => x.id === id);
      if (!r) throw new Error(`Brak zapytania o id ${id}`);
      return { ...row(r), port: r.port, pid: r.pid, statusText: r.statusText, mimeType: r.mimeType,
        requestHeaders: r.requestHeaders, responseHeaders: r.responseHeaders,
        body: r.body?.slice(0, max_body_chars), body_truncated: (r.body?.length ?? 0) > max_body_chars,
        error: r.error, call_stack: r.origin, wallStart: new Date(r.wallStart).toISOString() };
    },
  },
  analyze_server_timeline: {
    description: 'Analiza osi czasu ruchu serwera, osobno dla każdej aplikacji: serie zapytań, wykrywanie sekwencyjnych (waterfall) i równoległych, możliwy zysk z Promise.all, błędy 4xx/5xx i zerwane połączenia.',
    inputSchema: { type: 'object', properties: { ...sel,
      idle_gap_ms: { type: 'number', description: 'Przerwa rozdzielająca serie (domyślnie 250)' },
      seq_gap_ms: { type: 'number', description: 'Maks. odstęp „zaraz po poprzednim” (domyślnie 15)' } } },
    run: analyze,
  },
  clear_server_requests: {
    description: 'Czyści bufor zapytań (wszystkich albo jednej aplikacji), np. przed odtworzeniem scenariusza.',
    inputSchema: { type: 'object', properties: { app: sel.app } },
    run: ({ app } = {}) => {
      let n = 0;
      for (const [k, r] of requests) if (!app || r.app === app || String(r.port) === String(app)) { requests.delete(k); n++; }
      return { cleared: n, last_id: seq };
    },
  },
};

// ---------------------------------------------------------------- MCP stdio (JSON-RPC 2.0, linia = wiadomość)
const out = msg => process.stdout.write(JSON.stringify(msg) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk; let i;
  while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(line); }
});
process.stdin.on('end', () => process.exit(0));

async function handle(line) {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return; // notyfikacje
  try {
    let result;
    if (method === 'initialize') result = {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'node-outbound-inspector', version: '0.3.0' },
    };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
    else if (method === 'tools/call') {
      const t = tools[params.name]; if (!t) throw new Error(`Nieznane narzędzie: ${params.name}`);
      await pollAll();
      try { result = { content: [{ type: 'text', text: JSON.stringify(await t.run(params.arguments || {}), null, 2) }] }; }
      catch (e) { result = { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
    } else return out({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    out({ jsonrpc: '2.0', id, result });
  } catch (e) { out({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } }); }
}
log(`start, skanuję porty ${PORTS[0]}-${PORTS.at(-1)}`);
