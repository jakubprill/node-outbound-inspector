// Programowe API huba (issue #9): import przez `exports`, statusy zamiast process.exit, close() zawsze bezpieczne.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startHub } from 'node-outbound-inspector/hub'; // samoodwołanie przez pole `exports` w package.json
import { startScenario, sleep } from '../helpers/scenario.mjs';

const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

test('startHub: listening, znalezione aplikacje, drugi hub → already-running, close() idempotentne', async () => {
  const apps = [{ name: '@acme/web', dir: 'web' }];
  const sc = await startScenario({ apps });
  const logs = [];
  const hub = await startHub({ port: 0, ports: [apps[0].inspect], scanIntervalMs: 200, log: m => logs.push(m) });
  try {
    assert.equal(hub.status, 'listening');
    assert.match(hub.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    let found = [];
    for (let i = 0; i < 50 && !found.length; i++) { await sleep(100); found = hub.apps(); }
    assert.deepEqual(found.map(a => a.app), ['web']);
    assert.ok(logs.some(l => l.includes('found app="web"')), logs.join('\n'));
    const list = await (await fetch(`${hub.url}/json/list`)).json();
    assert.equal(list[0].title, 'web');

    const second = await startHub({ port: hub.port, ports: [] });
    assert.equal(second.status, 'already-running');
    assert.match(second.holder, /^outbound-hub /);
    assert.deepEqual(second.apps(), []);
    await second.close();
    assert.ok((await fetch(`${hub.url}/json/version`)).ok, 'close() drugiego nie zamyka pierwszego');
  } finally {
    await hub.close(); await hub.close(); sc.stop();
  }
  assert.deepEqual(hub.apps(), []);
});

test('startHub: port zajęty przez inny proces → port-taken z informacją, kto go trzyma', async () => {
  const fakeInspector = http.createServer((req, res) => res.end(JSON.stringify({ Browser: 'node.js/v24.1.0', 'Protocol-Version': '1.1' })));
  const other = http.createServer((req, res) => res.end('nope'));
  const [p1, p2] = [await listen(fakeInspector), await listen(other)];
  try {
    const a = await startHub({ port: p1, ports: [] });
    assert.deepEqual([a.status, a.holder], ['port-taken', 'node.js/v24.1.0']);
    const b = await startHub({ port: p2, ports: [] });
    assert.deepEqual([b.status, b.holder], ['port-taken', null]);
    await a.close(); await b.close();
  } finally { fakeInspector.close(); other.close(); }
});

test('startHub: ports i appNames także jako tekst jak w zmiennych środowiskowych', async () => {
  const apps = [{ name: '@acme/web', dir: 'web' }];
  const sc = await startScenario({ apps });
  const hub = await startHub({ port: 0, ports: `${apps[0].inspect}`, appNames: `${apps[0].inspect}=frontend`, scanIntervalMs: 200 });
  try {
    let found = [];
    for (let i = 0; i < 50 && !found.length; i++) { await sleep(100); found = hub.apps(); }
    assert.deepEqual(found.map(a => a.app), ['frontend']);
  } finally { await hub.close(); sc.stop(); }
});

const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
test('startHub pod Bunem: hub wykrywa aplikację i przepuszcza DevTools (skrypt dev uruchamiany przez bun run)', { skip: bun.status !== 0 && 'brak bun' }, async () => {
  const apps = [{ name: '@acme/web', dir: 'web' }];
  const sc = await startScenario({ apps });
  try {
    const script = fileURLToPath(new URL('../fixtures/bun-hub.mjs', import.meta.url));
    const r = spawnSync('bun', [script], { encoding: 'utf8', timeout: 20000, env: { ...process.env, INSPECT_PORT: String(apps[0].inspect) } });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), { status: 'listening', apps: ['web'], evaluate: 42 });
  } finally { sc.stop(); }
});
