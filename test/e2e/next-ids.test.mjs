// Współpraca z Next DevTools MCP: identyfikatory żądań Next przy żądaniu strony (złączenie z get_request_insights),
// port HTTP aplikacji w inspector_status. Pomijanie wewnętrznych żądań Next sprawdza test/unit/hook.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario } from '../helpers/scenario.mjs';

const APP = { name: '@acme/web', dir: 'web' };

test('next_request_id i next_html_request_id z nagłówków, filtr, http_ports', async () => {
  const sc = await startScenario({ apps: [APP] });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(APP.inspect) }, stderr: 'ignore' });
  try {
    await m.waitForApps(1);
    await m.call('clear_server_requests');
    await sc.hit(sc.apps[0], '/seq', { headers: { 'x-nextjs-request-id': 'rq-123', 'x-nextjs-html-request-id': 'html-9' } });
    await sc.hit(sc.apps[0], '/par');

    const { requests } = await m.call('list_server_requests', { next_request_id: 'rq-123' });
    assert.equal(requests.length, 3, JSON.stringify(requests));
    assert.ok(requests.every(r => r.next_request_id === 'rq-123' && r.page === 'GET /seq'));
    assert.equal((await m.call('list_server_requests', { next_html_request_id: 'html-9' })).requests.length, 3);

    const a = (await m.call('analyze_server_timeline', { app: '@acme/web', settle_ms: 200 }))['@acme/web'];
    const seq = a.pages.find(p => p.page === 'GET /seq');
    assert.equal(seq.next_request_id, 'rq-123');
    assert.equal(seq.next_html_request_id, 'html-9');
    assert.equal(a.pages.find(p => p.page === 'GET /par').next_request_id, undefined, 'bez nagłówka bez pola');

    const { apps } = await m.call('inspector_status');
    assert.ok(apps[0].http_ports.includes(APP.port), JSON.stringify(apps[0].http_ports));
    assert.ok(!apps[0].http_ports.includes(APP.inspect), 'bez portu inspektora');
  } finally { m.close(); sc.stop(); }
});
