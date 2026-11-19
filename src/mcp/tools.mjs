// Definicje narzędzi MCP: schematy wejścia i wywołania kolektora.
import { row, details } from './render.mjs';
import { analyze } from '../analyze/findings.mjs';

const sel = {
  app: { type: 'string', description: 'Nazwa aplikacji (z inspector_status) lub port inspektora. Pomiń, aby objąć wszystkie.' },
  url_contains: { type: 'string', description: 'Filtr: fragment URL zapytania wychodzącego' },
  page_contains: { type: 'string', description: 'Filtr: fragment żądania strony, które wywołało zapytanie, np. "/checkout"' },
  last_ms: { type: 'number', description: 'Tylko zapytania z ostatnich N milisekund' },
  since_id: { type: 'number', description: 'Tylko zapytania o id większym niż podane' },
};

/**
 * @param {{ store: any, status: () => object, now: () => number, ensureBody: (r: any) => Promise<any> }} collector
 */
export function createTools(collector) {
  const { store } = collector;
  return {
    inspector_status: {
      description: 'Lista podłączonych procesów/aplikacji (nazwa, port inspektora, pid, katalog) i liczba zebranych zapytań. Wywołaj najpierw, aby poznać nazwy aplikacji.',
      inputSchema: { type: 'object', properties: {} },
      run: () => collector.status(),
    },
    list_server_requests: {
      description: 'Lista zapytań HTTP wykonanych przez procesy Node (fetch i node:http): aplikacja, metoda, URL, status, czas trwania, miejsce w kodzie.',
      inputSchema: { type: 'object', properties: { ...sel, limit: { type: 'number', description: 'Maks. liczba wyników (domyślnie 50, najnowsze)' } } },
      run: (a) => store.select(a, collector.now()).slice(-(a.limit || 50)).map(r => row(r)),
    },
    get_server_request: {
      description: 'Szczegóły jednego zapytania: nagłówki żądania i odpowiedzi, treść odpowiedzi, stos wywołań.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' }, max_body_chars: { type: 'number' } }, required: ['id'] },
      run: async ({ id, max_body_chars = 4000 }) => {
        const r = store.byId(id);
        if (!r) throw new Error(`Brak zapytania o id ${id}`);
        return details(await collector.ensureBody(r), max_body_chars);
      },
    },
    analyze_server_timeline: {
      description: 'Analiza osi czasu ruchu serwera, osobno dla każdej aplikacji: serie zapytań, wykrywanie sekwencyjnych (waterfall) i równoległych, możliwy zysk z Promise.all, błędy 4xx/5xx i zerwane połączenia.',
      inputSchema: { type: 'object', properties: { ...sel,
        idle_gap_ms: { type: 'number', description: 'Przerwa rozdzielająca serie (domyślnie 250)' },
        seq_gap_ms: { type: 'number', description: 'Maks. odstęp „zaraz po poprzednim” (domyślnie 15)' } } },
      run: (args = {}) => analyze(store.select(args, collector.now()), args, store.appsSeen()),
    },
    clear_server_requests: {
      description: 'Czyści bufor zapytań (wszystkich albo jednej aplikacji), np. przed odtworzeniem scenariusza.',
      inputSchema: { type: 'object', properties: { app: sel.app } },
      run: ({ app } = {}) => ({ cleared: store.clear({ app }), last_id: store.lastId }),
    },
  };
}
