// outbound-hub: jedna lista celów dla chrome://inspect, przepięcie połączenia DevTools do właściwego procesu,
// ochrona przed DNS rebinding i przed użyciem huba jako pośrednika do dowolnego portu.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHub, allowedHost, rewriteTarget } from '../../src/hub/hub.mjs';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, freePorts, sleep } from '../helpers/scenario.mjs';

const HUB_BIN = fileURLToPath(new URL('../../bin/outbound-hub.mjs', import.meta.url));

/** Surowe żądanie HTTP z dowolnym nagłówkiem Host (fetch go nie pozwala ustawić). */
function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, res => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

/** Odpowiedź serwera na żądanie Upgrade: pierwsza linia (status). */
function rawUpgrade(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

/** Runtime.evaluate przez WebSocket (tak jak DevTools). */
function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    ws.onmessage = ({ data }) => { const m = JSON.parse(data); if (m.id === 1) { clearTimeout(t); ws.close(); resolve(m.result.result.value); } };
    ws.onerror = e => { clearTimeout(t); reject(new Error(e.message ?? 'ws error')); };
  });
}

test('allowedHost: IP i localhost tak, nazwy domen nie (DNS rebinding)', () => {
  for (const h of ['127.0.0.1:9229', 'localhost:9229', 'localhost', '[::1]:9229', '10.0.0.5']) assert.equal(allowedHost(h), true, h);
  for (const h of ['evil.example:9229', 'localhost.evil.example', '', undefined, 'attacker.test']) assert.equal(allowedHost(h), false, String(h));
});

test('rewriteTarget: adresy wskazują hub i ścieżkę /<port>/<id>', () => {
  const t = { id: 'abc-1', title: 'node', type: 'node', webSocketDebuggerUrl: 'ws://127.0.0.1:9231/abc-1',
    devtoolsFrontendUrl: 'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=127.0.0.1:9231/abc-1' };
  const r = rewriteTarget(t, { port: 9231, name: '@acme/web', hubHost: 'localhost:9229' });
  assert.equal(r.webSocketDebuggerUrl, 'ws://localhost:9229/9231/abc-1');
  assert.equal(r.devtoolsFrontendUrl, 'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=localhost:9229/9231/abc-1');
  assert.equal(r.title, '@acme/web');
  assert.equal(r.outboundHub, true);
});

test('hub: lista z nazwami, przepięcie DevTools, Host, tylko znalezione procesy, kolektor bez duplikatów', async () => {
  const apps = [{ name: '@acme/web', dir: 'web' }, { name: '@acme/admin', dir: 'admin' }];
  const sc = await startScenario({ apps });
  const [hubPort, stranger] = await freePorts(2);
  const hub = createHub({ port: hubPort, ports: [...apps.map(a => a.inspect), hubPort], scanIntervalMs: 200 });
  let m;
  try {
    await hub.listen();
    let list = [];
    for (let i = 0; i < 50 && list.length < 2; i++) { await sleep(100); list = JSON.parse((await rawGet(hubPort, '/json/list')).body); }
    assert.deepEqual(list.map(t => t.title).sort(), ['@acme/admin', '@acme/web'], 'nazwy z package.json, jak w kolektorze');
    const web = list.find(t => t.title === '@acme/web');
    assert.match(web.webSocketDebuggerUrl, new RegExp(`^ws://127\\.0\\.0\\.1:${hubPort}/${apps[0].inspect}/[\\w-]+$`));
    assert.match(web.devtoolsFrontendUrl, new RegExp(`ws=127\\.0\\.0\\.1:${hubPort}/${apps[0].inspect}/`));
    assert.equal(JSON.parse((await rawGet(hubPort, '/json')).body).length, 2, '/json to samo co /json/list');
    assert.ok(JSON.parse((await rawGet(hubPort, '/json/version')).body)['node-outbound-inspector-hub'], 'znacznik huba w /json/version');

    // DevTools przez hub trafia do właściwego procesu
    assert.match(await evaluate(web.webSocketDebuggerUrl, 'process.cwd()'), /apps[\\/]web$/);
    const admin = list.find(t => t.title === '@acme/admin');
    assert.match(await evaluate(admin.webSocketDebuggerUrl, 'process.cwd()'), /apps[\\/]admin$/);

    // DNS rebinding: obca nazwa w Host → 403, dla listy i dla Upgrade
    assert.equal((await rawGet(hubPort, '/json/list', { host: `evil.example:${hubPort}` })).status, 403);
    const path = new URL(web.webSocketDebuggerUrl).pathname;
    assert.equal(await rawUpgrade(hubPort, path, `evil.example:${hubPort}`), 403);
    // tylko procesy znalezione na skanowanych portach: nie dowolny port i nie nieznany cel
    assert.equal(await rawUpgrade(hubPort, `/${stranger}/abc`), 404, 'port spoza skanowania');
    assert.equal(await rawUpgrade(hubPort, `/${apps[0].inspect}/not-a-target`), 404, 'nieznany cel');
    assert.equal(await rawUpgrade(hubPort, path), 101, 'znany cel');

    // kolektor skanujący także port huba nie dubluje aplikacji
    m = await startMcp({ env: { INSPECTOR_PORTS: [...apps.map(a => a.inspect), hubPort].join(',') }, stderr: 'ignore' });
    await m.waitForApps(2);
    await sleep(1800); // jeden pełny cykl skanowania więcej
    const status = await m.call('inspector_status');
    assert.deepEqual(status.apps.map(a => a.app).sort(), ['@acme/admin', '@acme/web']);

    // proces znika z listy po zakończeniu
    sc.apps[1].proc.kill();
    for (let i = 0; i < 50 && list.length > 1; i++) { await sleep(100); list = JSON.parse((await rawGet(hubPort, '/json/list')).body); }
    assert.deepEqual(list.map(t => t.title), ['@acme/web']);
  } finally { m?.close(); await hub.close(); sc.stop(); }
});

test('outbound-hub: drugi hub na tym samym porcie kończy się bez błędu, obcy proces na porcie → kod 1', async () => {
  const [port] = await freePorts(1);
  const run = (env = {}) => new Promise(resolve => {
    const p = spawn(process.execPath, [HUB_BIN], { env: { ...process.env, OUTBOUND_HUB_PORT: String(port), INSPECTOR_PORTS: String(port), ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('exit', code => resolve({ code, err }));
    return p;
  });
  const first = spawn(process.execPath, [HUB_BIN], { env: { ...process.env, OUTBOUND_HUB_PORT: String(port), INSPECTOR_PORTS: String(port) }, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise(r => first.stderr.once('data', r));
    const second = await run();
    assert.equal(second.code, 0, second.err);
    assert.match(second.err, /already running/);
  } finally { first.kill(); await new Promise(r => first.on('exit', r)); }

  const blocker = http.createServer((q, s) => s.end('{}')).listen(port, '127.0.0.1');
  await new Promise(r => blocker.once('listening', r));
  try {
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.err, /taken by another process/);
  } finally { blocker.close(); }
});

test('odpowiedzi HTTP jak w inspektorze Node: Content-Length, bez chunked (wymóg chrome://inspect)', async () => {
  const [port] = await freePorts(1);
  const hub = createHub({ port, ports: [], identify: false });
  await hub.listen();
  try {
    const raw = await new Promise(r => {
      const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET /json/list?t=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`));
      let d = ''; sock.on('data', x => { d += x; }); sock.on('close', () => r(d));
    });
    assert.match(raw, /^HTTP\/1\.1 200/);
    assert.match(raw, /\r\nContent-Length: 2\r\n/i);
    assert.doesNotMatch(raw, /Transfer-Encoding: chunked/i);
    assert.ok(raw.endsWith('\r\n\r\n[]'), 'połączenie zamknięte po odpowiedzi; parametry w URL nie przeszkadzają');
    const version = JSON.parse((await rawGet(port, '/json/version')).body);
    assert.match(version.Browser, /^node\.js\//, 'chrome://inspect pokazuje cele node tylko pod node.js/…');
  } finally { await hub.close(); }
});
