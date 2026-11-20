// Connection errors without a message (issue #3) and skipping OpenTelemetry export by default (issue #4).
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

test('refused connection: the status is never "FAILED: " without a message, details give the error kind', () =>
  withApp(app(), {}, async (sc, m) => {
    await sc.hit(sc.apps[0], '/refused'); await sc.hit(sc.apps[0], '/timeout'); await sleep(300);
    const [refused] = (await m.call('list_server_requests', { url_contains: '/api' })).requests;
    // Node 22 reports an AggregateError with an empty message here; if a newer Node adds one, the status shows it
    assert.match(refused.status, /^FAILED(: \S| \(no error text from the inspector\)$)/, refused.status);
    const d = await m.call('get_server_request', { id: refused.id });
    assert.ok(['unknown', 'connection_refused', 'other'].includes(d.error_kind), d.error_kind);
    if (d.error === '') assert.match(d.error_hint, /AggregateError/);
    const [timeout] = (await m.call('list_server_requests', { url_contains: '/slow' })).requests;
    assert.equal(timeout.status, 'FAILED: The operation was aborted due to timeout');
    assert.equal((await m.call('get_server_request', { id: timeout.id })).error_kind, 'timeout');
    const { errors } = (await m.call('analyze_server_timeline'))['web'];
    assert.equal(errors.length, 2);
    assert.ok(errors.every(e => e.status !== 'FAILED: '), JSON.stringify(errors));
  }));

test('OTLP export to :4318 skipped by default: not in the list or errors, visible in inspector_status', () =>
  withApp(app(), {}, async (sc, m) => {
    await sc.hit(sc.apps[0], '/otel'); await sleep(300);
    const rows = (await m.call('list_server_requests')).requests;
    assert.deepEqual(rows.map(r => new URL(r.url).pathname), ['/user'], 'only the ordinary request stays');
    assert.deepEqual((await m.call('analyze_server_timeline'))['web'].errors, []);
    const s = await m.call('inspector_status');
    assert.ok(s.ignored_otlp.includes('*:4318/v1/traces'));
    assert.equal(s.ignored_requests_total.otlp, 2, 'fetch i node:http');
  }));

test('OUTBOUND_IGNORE_OTLP=0: OTLP export visible as an error', () =>
  withApp(app(), { OUTBOUND_IGNORE_OTLP: '0' }, async (sc, m) => {
    await sc.hit(sc.apps[0], '/otel'); await sleep(300);
    const { errors } = (await m.call('analyze_server_timeline'))['web'];
    assert.deepEqual(errors.map(e => new URL(e.url).pathname).sort(), ['/v1/metrics', '/v1/traces']);
    const s = await m.call('inspector_status');
    assert.deepEqual(s.ignored_otlp, []);
    assert.equal(s.ignored_requests_total.otlp, 0);
  }));
