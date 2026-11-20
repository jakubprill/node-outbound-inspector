// Prototype defects (docs/architecture.md, section 2). Fixed ones have ordinary regression tests;
// the rest are marked `todo` with the number of the milestone that will fix them.
// Ports 47xx: we avoid ports blocked by fetch (e.g. 5060/5061 — SIP), otherwise the test app's
// requests are rejected, and its response never ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';

const app = (extra = {}) => ({ name: '@acme/web', dir: 'web', ...extra }); // porty przydziela startScenario

async function withApp(a, fn, { servicesPort } = {}) {
  const sc = await startScenario({ servicesPort, apps: [a] });
  const mcps = [];
  try { return await fn(sc, async (env = {}) => { const m = await startMcp({ env: { INSPECTOR_PORTS: String(a.inspect), ...env }, stderr: 'ignore' }); mcps.push(m); return m; }); }
  finally { mcps.forEach(m => m.close()); sc.stop(); }
}

test('defect 1: two collectors at once — both see page assignment', { todo: 'M4: the hook log is drained by the first collector (splice)' }, () =>
  withApp(app(), async (sc, mcp) => {
    const [m1, m2] = [await mcp(), await mcp()];
    await m1.waitForApps(1); await m2.waitForApps(1);
    await sc.hit(sc.apps[0], '/seq'); await sleep(1500);
    for (const m of [m1, m2]) {
      const reqs = (await m.call('list_server_requests')).requests;
      assert.equal(reqs.length, 3);
      assert.ok(reqs.every(r => r.page === 'GET /seq'), JSON.stringify(reqs.map(r => r.page)));
    }
  }));

test('defect 2: a process without --experimental-network-inspection (with OUTBOUND_INSPECT=1 consent) — the status shows it and gives the reason', () =>
  withApp(app({ flags: [], env: { OUTBOUND_INSPECT: '1' } }), async (sc, mcp) => {
    const m = await mcp();
    for (let i = 0; i < 40 && !(await m.call('inspector_status')).apps[0]?.ready; i++) await sleep(250);
    const [s] = (await m.call('inspector_status')).apps;
    assert.equal(s.network_inspection, false);
    assert.equal(s.skipped, undefined);
    assert.match(s.warnings.join(' '), /without --experimental-network-inspection/);
  }));

test('audit B-01: a process with an inspector but without consent is skipped — no hook, patches or Network.enable', () =>
  withApp(app({ flags: [] }), async (sc, mcp) => {
    const m = await mcp();
    for (let i = 0; i < 40 && !(await m.call('inspector_status')).apps[0]?.ready; i++) await sleep(250);
    const [s] = (await m.call('inspector_status')).apps;
    assert.equal(s.skipped, 'no_consent');
    assert.equal(s.network_inspection, false);
    assert.equal(s.page_correlation, false);
    assert.match(s.warnings[0], /no consent for inspection/);
    // the process state checked with our own connection to the inspector: nothing was injected
    const [t] = await (await fetch(`http://127.0.0.1:${sc.apps[0].inspect}/json/list`)).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });
    const value = await new Promise(r => {
      ws.onmessage = ({ data }) => { const msg = JSON.parse(data); if (msg.id === 1) r(msg.result.result.value); };
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'typeof globalThis.__outboundInspector + "," + (process.getBuiltinModule("node:inspector").Network?.dataReceived?.__outboundFix66551 === true)', returnByValue: true } }));
    });
    ws.close();
    assert.equal(value, 'undefined,false');
  }));

test('defect 3: app restart on the same port — records from before the restart stay', () =>
  withApp(app(), async (sc, mcp) => {
    const m = await mcp();
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/seq'); await sleep(300);
    sc.apps[0].proc.kill(); await sleep(500);
    const again = await startScenario({ apps: [app({ port: sc.apps[0].port, inspect: sc.apps[0].inspect })] }); // the same app and inspector port
    try {
      for (let i = 0; i < 40 && (await m.call('inspector_status')).apps.length < 1; i++) await sleep(250);
      await sleep(1500);
      await again.hit(again.apps[0], '/seq'); await sleep(300);
      assert.equal(((await m.call('list_server_requests')).requests).length, 6);
    } finally { again.stop(); }
  }));

test('defect 5: analysis of heavy traffic fits the response budget', () =>
  withApp(app(), async (sc, mcp) => {
    const m = await mcp();
    await m.waitForApps(1);
    for (let i = 0; i < 44; i++) await sc.hit(sc.apps[0], '/par');
    await sleep(500);
    const len = async args => (await m.rpc('tools/call', { name: 'analyze_server_timeline', arguments: args })).result.content[0].text.length;
    const summary = await len({}), full = await len({ detail: 'full' });
    assert.ok(summary <= 6000, `summary: ${summary} characters (ADR 0008 goal: 6000)`);
    assert.ok(full <= 20000, `full report: ${full} characters (hard limit 20,000)`);
    const listed = (await m.rpc('tools/call', { name: 'list_server_requests', arguments: { limit: 1000 } })).result.content[0].text;
    assert.ok(listed.length <= 20000, `list: ${listed.length} characters`);
    const truncated = JSON.parse((await m.rpc('tools/call', { name: 'analyze_server_timeline', arguments: { detail: 'full' } })).result.content[0].text);
    if (truncated.truncated) assert.match(truncated.truncation_hint, /page_request_id/);
  }));

test('defect 6: secrets from headers, JSON bodies and the page URL appear in no result of any tool', () =>
  withApp(app({ script: 'secrets-app.mjs' }), async (sc, mcp) => {
    const m = await mcp();
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/auth/callback?code=OAUTH_CODE_789&token=PAGE_URL_SECRET'); await sleep(300);
    const [r] = (await m.call('list_server_requests', { url_contains: '/secure' })).requests;
    assert.match(r.page, /^GET \/auth\/callback\?code=%5Bredacted\+%C2%B7\+%23[0-9a-f]{6}%5D&token=%5Bredacted\+%C2%B7\+%23[0-9a-f]{6}%5D$/, r.page);
    const outputs = [];
    for (const [name, args] of [['inspector_status', {}], ['list_server_requests', {}], ['analyze_server_timeline', {}],
      ['get_server_request', { id: r.id }], ['list_server_requests', { url_contains: 'secure' }]]) {
      outputs.push((await m.rpc('tools/call', { name, arguments: args })).result.content[0].text);
    }
    const all = outputs.join('\n');
    for (const secret of ['secret-token', 'session=abc', 'body-secret-tok', 'PAGE_URL_SECRET', 'OAUTH_CODE_789']) assert.ok(!all.includes(secret), `wyciek: ${secret}`);
    const d = await m.call('get_server_request', { id: r.id });
    assert.match(d.requestHeaders.authorization, /^\[redacted: Bearer · 19 chars · #[0-9a-f]{6}\]$/);
    assert.match(d.body, /"access_token":"\[redacted: 15 chars · #[0-9a-f]{6}\]","expires_in":60/);
    assert.equal(d.body_redacted_fields, 1);
  }));

test('OUTBOUND_REDACT=0: values unchanged and a warning in the status', () =>
  withApp(app({ script: 'secrets-app.mjs' }), async (sc, mcp) => {
    const m = await mcp({ OUTBOUND_REDACT: '0' });
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/'); await sleep(300);
    const [r] = (await m.call('list_server_requests', { url_contains: '/secure' })).requests;
    const d = await m.call('get_server_request', { id: r.id });
    assert.equal(d.requestHeaders.authorization, 'Bearer secret-token');
    assert.match(d.body, /body-secret-tok/);
    const st = await m.call('inspector_status');
    assert.equal(st.redaction, false);
    assert.match(st.warnings.join(' '), /Secret redaction is off/);
  }));
