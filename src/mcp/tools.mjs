// Definicje narzędzi MCP: schematy wejścia i wywołania kolektora.
import { row, details } from './render.mjs';
import { analyze } from '../analyze/findings.mjs';

const sel = {
  app: { type: 'string', description: 'App name (from inspector_status) or inspector port. Omit to include all apps.' },
  url_contains: { type: 'string', description: 'Filter: substring of the outbound request URL' },
  page_contains: { type: 'string', description: 'Filter: substring of the page request that triggered the request, e.g. "/checkout"' },
  last_ms: { type: 'number', description: 'Only requests from the last N milliseconds' },
  since_id: { type: 'number', description: 'Only requests with an id greater than this one' },
};

/**
 * @param {{ store: any, status: () => object, now: () => number, ensureBody: (r: any) => Promise<any> }} collector
 */
export function createTools(collector) {
  const { store } = collector;
  return {
    inspector_status: {
      description: 'Connected processes/apps (name, inspector port, pid, directory, warnings) and the number of collected requests. Call this first to learn the app names.',
      inputSchema: { type: 'object', properties: {} },
      run: () => collector.status(),
    },
    list_server_requests: {
      description: 'HTTP requests made by Node processes (fetch and node:http): app, page, method, URL, status, duration, code location.',
      inputSchema: { type: 'object', properties: { ...sel, limit: { type: 'number', description: 'Max number of results (default 50, newest first)' } } },
      run: (a) => store.select(a, collector.now()).slice(-(a.limit || 50)).map(r => row(r)),
    },
    get_server_request: {
      description: 'Details of one request: request and response headers, response body with its state, call stack.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' }, max_body_chars: { type: 'number' } }, required: ['id'] },
      run: async ({ id, max_body_chars = 4000 }) => {
        const r = store.byId(id);
        if (!r) throw new Error(`No request with id ${id}`);
        return details(await collector.ensureBody(r), max_body_chars);
      },
    },
    analyze_server_timeline: {
      description: 'Timeline analysis of server traffic, per app and per page request: request bursts, sequential (waterfall) vs parallel requests, potential gain from Promise.all (respecting data dependencies), 4xx/5xx errors and dropped connections.',
      inputSchema: { type: 'object', properties: { ...sel,
        idle_gap_ms: { type: 'number', description: 'Idle gap that separates bursts, in ms (default 250)' },
        seq_gap_ms: { type: 'number', description: 'Max gap in ms for "started right after the previous one" (default 15)' } } },
      run: (args = {}) => analyze(store.select(args, collector.now()), args, store.appsSeen()),
    },
    clear_server_requests: {
      description: 'Clears the request buffer (all apps or one app), e.g. before reproducing a scenario.',
      inputSchema: { type: 'object', properties: { app: sel.app } },
      run: ({ app } = {}) => ({ cleared: store.clear({ app }), last_id: store.lastId }),
    },
  };
}
