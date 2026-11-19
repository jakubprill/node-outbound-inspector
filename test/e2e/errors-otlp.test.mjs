// Błędy połączeń bez opisu (issue #3) i domyślne pomijanie eksportu OpenTelemetry (issue #4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';

const app = () => ({ name: '@acme/web', dir: 'web', script: 'errors-app.mjs' }); // porty przydziela startScenario

async function withApp(a, env, fn) {
  const sc = await startScenario({ apps: [a] });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(a.inspect), ...env }, stderr: 'ignore' });
  try { await m.waitForApps(1); return await fn(sc, m); } finally { m.close(); sc.stop(); }
}

test('odrzucone połączenie: status nigdy nie jest "FAILED: " bez opisu, szczegóły podają rodzaj błędu', () =>
  withApp(app(), {}, async (sc, m) => {
    await sc.hit(sc.apps[0], '/refused'); await sc.hit(sc.apps[0], '/timeout'); await sleep(300);
    const [refused] = await m.call('list_server_requests', { url_contains: '/api' });
    // Node 22 zgłasza tu AggregateError z pustym message; gdyby nowszy Node dodał opis, status go pokaże
    assert.match(refused.status, /^FAILED(: \S| \(brak opisu błędu od inspektora\)$)/, refused.status);
    const d = await m.call('get_server_request', { id: refused.id });
    assert.ok(['unknown', 'connection_refused', 'other'].includes(d.error_kind), d.error_kind);
    if (d.error === '') assert.match(d.error_hint, /AggregateError/);
    const [timeout] = await m.call('list_server_requests', { url_contains: '/slow' });
    assert.equal(timeout.status, 'FAILED: The operation was aborted due to timeout');
    assert.equal((await m.call('get_server_request', { id: timeout.id })).error_kind, 'timeout');
    const { errors } = (await m.call('analyze_server_timeline'))['@acme/web'];
    assert.equal(errors.length, 2);
    assert.ok(errors.every(e => e.status !== 'FAILED: '), JSON.stringify(errors));
  }));

test('eksport OTLP na :4318 domyślnie pomijany: brak w liście i błędach, widoczny w inspector_status', () =>
  withApp(app(), {}, async (sc, m) => {
    await sc.hit(sc.apps[0], '/otel'); await sleep(300);
    const rows = await m.call('list_server_requests');
    assert.deepEqual(rows.map(r => new URL(r.url).pathname), ['/user'], 'zostaje tylko zwykłe zapytanie');
    assert.deepEqual((await m.call('analyze_server_timeline'))['@acme/web'].errors, []);
    const s = await m.call('inspector_status');
    assert.ok(s.ignored_otlp.includes('*:4318/v1/traces'));
    assert.equal(s.ignored_requests_total.otlp, 2, 'fetch i node:http');
  }));

test('OUTBOUND_IGNORE_OTLP=0: eksport OTLP widoczny jako błąd', () =>
  withApp(app(), { OUTBOUND_IGNORE_OTLP: '0' }, async (sc, m) => {
    await sc.hit(sc.apps[0], '/otel'); await sleep(300);
    const { errors } = (await m.call('analyze_server_timeline'))['@acme/web'];
    assert.deepEqual(errors.map(e => new URL(e.url).pathname).sort(), ['/v1/metrics', '/v1/traces']);
    const s = await m.call('inspector_status');
    assert.deepEqual(s.ignored_otlp, []);
    assert.equal(s.ignored_requests_total.otlp, 0);
  }));
