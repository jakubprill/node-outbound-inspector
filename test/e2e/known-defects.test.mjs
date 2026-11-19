// Wady prototypu (docs/architecture.md, rozdz. 2). Naprawione mają zwykłe testy regresji;
// pozostałe są oznaczone `todo` z numerem kamienia milowego, w którym zostaną naprawione.
// Porty 47xx: unikamy portów blokowanych przez fetch (np. 5060/5061 — SIP), inaczej zapytania
// aplikacji testowej są odrzucane, a jej odpowiedź nigdy się nie kończy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';

const app = (port, inspect, extra = {}) => ({ name: '@acme/web', dir: 'web', port, inspect, ...extra });

async function withApp(a, fn, { servicesPort } = {}) {
  const sc = await startScenario({ servicesPort: servicesPort ?? a.port - 1, apps: [a] });
  const mcps = [];
  try { return await fn(sc, async (env = {}) => { const m = await startMcp({ env: { INSPECTOR_PORTS: String(a.inspect), ...env }, stderr: 'ignore' }); mcps.push(m); return m; }); }
  finally { mcps.forEach(m => m.close()); sc.stop(); }
}

test('wada 1: dwa kolektory naraz — oba widzą przypisanie do stron', { todo: 'M4: dziennik haka opróżniany przez pierwszy kolektor (splice)' }, () =>
  withApp(app(4731, 9631), async (sc, mcp) => {
    const [m1, m2] = [await mcp(), await mcp()];
    await m1.waitForApps(1); await m2.waitForApps(1);
    await sc.hit(sc.apps[0], '/seq'); await sleep(1500);
    for (const m of [m1, m2]) {
      const reqs = await m.call('list_server_requests');
      assert.equal(reqs.length, 3);
      assert.ok(reqs.every(r => r.page === 'GET /seq'), JSON.stringify(reqs.map(r => r.page)));
    }
  }));

test('wada 2: proces bez --experimental-network-inspection — status to pokazuje i podaje powód', () =>
  withApp(app(4741, 9641, { flags: [] }), async (sc, mcp) => {
    const m = await mcp();
    for (let i = 0; i < 40 && !(await m.call('inspector_status')).apps[0]?.ready; i++) await sleep(250);
    const [s] = (await m.call('inspector_status')).apps;
    assert.equal(s.network_inspection, false);
    assert.match(s.warnings.join(' '), /bez --experimental-network-inspection/);
  }));

test('wada 3: restart aplikacji na tym samym porcie — rekordy sprzed restartu zostają', () =>
  withApp(app(4751, 9651), async (sc, mcp) => {
    const m = await mcp();
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/seq'); await sleep(300);
    sc.apps[0].proc.kill(); await sleep(500);
    const again = await startScenario({ servicesPort: 4752, apps: [app(4751, 9651)] });
    try {
      for (let i = 0; i < 40 && (await m.call('inspector_status')).apps.length < 1; i++) await sleep(250);
      await sleep(1500);
      await again.hit(again.apps[0], '/seq'); await sleep(300);
      assert.equal((await m.call('list_server_requests')).length, 6);
    } finally { again.stop(); }
  }, { servicesPort: 4750 }));

test('wada 5: analiza dużego ruchu mieści się w budżecie odpowiedzi', { todo: 'M6: brak budżetu — 132 zapytania ≈ 65–88 tys. znaków' }, () =>
  withApp(app(4761, 9661), async (sc, mcp) => {
    const m = await mcp();
    await m.waitForApps(1);
    for (let i = 0; i < 44; i++) await sc.hit(sc.apps[0], '/par');
    await sleep(500);
    const raw = await m.rpc('tools/call', { name: 'analyze_server_timeline', arguments: {} });
    assert.ok(raw.result.content[0].text.length <= 20000, `${raw.result.content[0].text.length} znaków`);
  }));

test('wada 6: sekrety z nagłówków nie występują w żadnym wyniku żadnego narzędzia', () =>
  withApp(app(4771, 9671, { script: 'secrets-app.mjs' }), async (sc, mcp) => {
    const m = await mcp();
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/'); await sleep(300);
    const [r] = await m.call('list_server_requests', { url_contains: '/secure' });
    const outputs = [];
    for (const [name, args] of [['inspector_status', {}], ['list_server_requests', {}], ['analyze_server_timeline', {}],
      ['get_server_request', { id: r.id }], ['list_server_requests', { url_contains: 'secure' }]]) {
      outputs.push((await m.rpc('tools/call', { name, arguments: args })).result.content[0].text);
    }
    const all = outputs.join('\n');
    for (const secret of ['secret-token', 'session=abc']) assert.ok(!all.includes(secret), `wyciek: ${secret}`);
    const d = await m.call('get_server_request', { id: r.id });
    assert.match(d.requestHeaders.authorization, /^\[zredagowano: Bearer · 19 zn\. · #[0-9a-f]{6}\]$/);
  }));

test('OUTBOUND_REDACT=0: wartości bez zmian i ostrzeżenie w statusie', () =>
  withApp(app(4831, 9721, { script: 'secrets-app.mjs' }), async (sc, mcp) => {
    const m = await mcp({ OUTBOUND_REDACT: '0' });
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/'); await sleep(300);
    const [r] = await m.call('list_server_requests', { url_contains: '/secure' });
    assert.equal((await m.call('get_server_request', { id: r.id })).requestHeaders.authorization, 'Bearer secret-token');
    const st = await m.call('inspector_status');
    assert.equal(st.redaction, false);
    assert.match(st.warnings.join(' '), /Redakcja sekretów wyłączona/);
  }));
