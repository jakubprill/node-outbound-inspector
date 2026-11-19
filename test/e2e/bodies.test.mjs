// Treści odpowiedzi (wada 4): jawny stan zamiast pustego łańcucha, zależność od wersji Node,
// limity bufora inspektora w procesie aplikacji i tryby eager/lazy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';

const app = () => ({ name: '@acme/web', dir: 'web', script: 'bodies-app.mjs' }); // porty przydziela startScenario

async function withApp(a, env, fn) {
  const sc = await startScenario({ apps: [a] });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(a.inspect), ...env }, stderr: 'ignore' });
  try { await m.waitForApps(1); return await fn(sc, m); } finally { m.close(); sc.stop(); }
}

test('fetch i node:http: treść albo jawny powód jej braku', () => withApp(app(), {}, async (sc, m) => {
  await sc.hit(sc.apps[0], '/fetch'); await sc.hit(sc.apps[0], '/http'); await sleep(400);
  const get = async path => {
    const rows = await m.call('list_server_requests', { url_contains: '/small' });
    const r = rows.find(x => x.page === `GET ${path}`) ?? rows[path === '/fetch' ? 0 : 1];
    return m.call('get_server_request', { id: r.id });
  };
  const viaHttp = await get('/http');
  assert.equal(viaHttp.body_state, 'available');
  assert.equal(viaHttp.body, '{"service":"/small"}');
  const viaFetch = await get('/fetch');
  assert.equal(viaFetch.body_state, 'available');
  assert.equal(viaFetch.body, '{"service":"/small"}');
  assert.ok(viaFetch.ttfb_ms >= 0 && viaFetch.ttfb_ms <= viaFetch.duration_ms);
}));

test('limit bufora inspektora: najstarsza z 40 odpowiedzi po 2 MB znika z Node (tryb lazy → evicted)',
  () => withApp(app(), { OUTBOUND_BODIES: 'lazy', OUTBOUND_INSPECTOR_BUFFER_MB: '32', OUTBOUND_INSPECTOR_RESOURCE_MB: '3' }, async (sc, m) => {
    await sc.hit(sc.apps[0], '/big?n=40'); await sleep(500);
    const rows = await m.call('list_server_requests', { url_contains: '/big', limit: 100 });
    assert.equal(rows.length, 40);
    const oldest = await m.call('get_server_request', { id: rows[0].id, max_body_chars: 10 });
    const newest = await m.call('get_server_request', { id: rows.at(-1).id, max_body_chars: 10 });
    assert.equal(newest.body_state, 'truncated', 'najnowsza dostępna, przycięta limitem kolektora 256 KB');
    assert.ok(newest.body_bytes > 2_000_000, String(newest.body_bytes));
    assert.equal(oldest.body_state, 'evicted', 'limit 32 MB dotarł do procesu aplikacji');
  }));

test('tryb eager: treść najstarszej odpowiedzi pobrana od razu, zanim Node ją usunie',
  () => withApp(app(), { OUTBOUND_INSPECTOR_BUFFER_MB: '32', OUTBOUND_INSPECTOR_RESOURCE_MB: '3' }, async (sc, m) => {
    await sc.hit(sc.apps[0], '/big?n=40'); await sleep(800);
    const rows = await m.call('list_server_requests', { url_contains: '/big', limit: 100 });
    const oldest = await m.call('get_server_request', { id: rows[0].id, max_body_chars: 10 });
    assert.equal(oldest.body_state, 'truncated');
    assert.ok(oldest.body_bytes > 2_000_000, String(oldest.body_bytes));
    assert.equal(oldest.body, '{"service"');
  }));

test('tryb off: treści nie są pobierane', () => withApp(app(), { OUTBOUND_BODIES: 'off' }, async (sc, m) => {
  await sc.hit(sc.apps[0], '/http'); await sleep(300);
  const [r] = await m.call('list_server_requests', { url_contains: '/small' });
  const d = await m.call('get_server_request', { id: r.id });
  assert.equal(d.body_state, 'skipped');
  assert.equal(d.body, null);
}));

test('node:http: treść gzip, br i deflate czytelna po dekompresji (issue #1)', () => withApp(app(), {}, async (sc, m) => {
  await sc.hit(sc.apps[0], '/gzip'); await sleep(400);
  const rows = await m.call('list_server_requests', { url_contains: '/packed' });
  assert.equal(rows.length, 4);
  const [gzip, br, deflate, charset] = await Promise.all(rows.map(r => m.call('get_server_request', { id: r.id })));
  for (const [d, enc] of [[gzip, 'gzip'], [br, 'br'], [deflate, 'deflate']]) {
    assert.equal(d.body_state, 'available', enc);
    assert.equal(d.body, '{"service":"/packed"}', enc);
    assert.equal(d.body_bytes, 21, `${enc}: rozmiar po dekompresji`);
    assert.equal(d.body_encoding, enc);
    assert.equal(d.body_encoded_bytes, Number(d.responseHeaders['content-length']), `${enc}: rozmiar na łączu`);
  }
  // content-type z charset: inspektor Node oddaje skompresowane bajty jako tekst UTF-8 (nieodwracalnie)
  assert.equal(charset.body_state, 'unavailable');
  assert.match(charset.body_reason, /zniekształcone/);
  assert.equal(charset.body, null);
}));
