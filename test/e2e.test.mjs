// End-to-end test: two "apps" started in parallel (as in a monorepo), each with its own inspector port,
// one MCP server. Checks app recognition, assignment of requests to app and page,
// detection of sequential/parallel requests and of errors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMcp } from './helpers/mcp-client.mjs';

const fx = p => fileURLToPath(new URL(`./fixtures/${p}`, import.meta.url));
const SERVICES_PORT = 4711;
const APPS = [
  { name: '@acme/web', dir: fx('apps/web'), port: 4721, inspect: 9331 },
  { name: '@acme/admin', dir: fx('apps/admin'), port: 4722, inspect: 9341 },
];
const procs = [];
let mcp;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hit = (app, path) => fetch(`http://127.0.0.1:${app.port}${path}`).then(r => r.text());

before(async () => {
  procs.push(spawn(process.execPath, [fx('services.mjs')], { env: { ...process.env, PORT: SERVICES_PORT }, stdio: 'ignore' }));
  for (const a of APPS) {
    // cwd = the app directory with package.json → the MCP server determines the app name itself
    procs.push(spawn(process.execPath, ['--experimental-network-inspection', `--inspect=127.0.0.1:${a.inspect}`, fx('fake-app.mjs')],
      { cwd: a.dir, env: { ...process.env, PORT: a.port, SERVICES_PORT, npm_package_name: '' }, stdio: 'ignore' }));
  }
  await sleep(800);
  mcp = await startMcp({ env: { INSPECTOR_PORTS: APPS.map(a => a.inspect).join(',') }, stderr: 'ignore' });
  await mcp.waitForApps(APPS.length);
});

after(() => { mcp?.close(); procs.forEach(p => p.kill()); });

test('recognizes both apps by package.json in cwd', async () => {
  const s = await mcp.call('inspector_status');
  assert.deepEqual(s.apps.map(a => a.app).sort(), ['admin', 'web']);
  assert.ok(s.apps.every(a => a.network_inspection && a.page_correlation));
});

test('assigns requests to the right app and page when everything happens at once', async () => {
  const [web, admin] = APPS;
  await mcp.call('clear_server_requests');
  // the same URL /user called by both apps and by two pages of one app at the same time
  await Promise.all([hit(web, '/seq'), hit(web, '/err'), hit(admin, '/par'), hit(admin, '/seq'), hit(admin, '/http')]);
  await sleep(500);
  const reqs = (await mcp.call('list_server_requests', { limit: 100 })).requests;
  const pick = (app, page) => reqs.filter(r => r.app === app && r.page === page).map(r => new URL(r.url).pathname).sort();
  assert.deepEqual(pick('web', 'GET /seq'), ['/offers', '/orders', '/user']);
  assert.deepEqual(pick('web', 'GET /err'), ['/payments']);
  assert.deepEqual(pick('admin', 'GET /par'), ['/audit', '/reports', '/user']);
  assert.deepEqual(pick('admin', 'GET /seq'), ['/offers', '/orders', '/user']);
  assert.deepEqual(pick('admin', 'GET /http'), ['/legacy'], 'node:http is assigned to the page too');
  assert.equal(reqs.length, 11, "web: 3 + 1, admin: 3 + 3 + 1");
});

test('detects waterfall, parallelism and errors separately for every page', async () => {
  const res = await mcp.call('analyze_server_timeline', { detail: 'full' });
  const page = (app, p) => res[app].by_page_request.find(x => x.page === p);

  const webSeq = page('web', 'GET /seq');
  assert.equal(webSeq.max_concurrency, 1);
  assert.match(webSeq.verdict, /SEQUENTIAL/);
  assert.equal(webSeq.sequential_chains[0].length, 3);
  assert.ok(webSeq.sequential_chains[0].potential_saving_ms > 250, 'a saving of about 2 × 150 ms');

  const adminPar = page('admin', 'GET /par');
  assert.equal(adminPar.max_concurrency, 3);
  assert.match(adminPar.verdict, /PARALLEL/);
  assert.equal(adminPar.sequential_chains.length, 0);

  assert.deepEqual(res['web'].errors.map(e => [new URL(e.url).pathname, e.status]), [['/payments', 500]]);
  assert.equal(res['admin'].errors.length, 0);
});

test('returns request details with headers', async () => {
  const [err] = ((await mcp.call('list_server_requests', { app: '@acme/web', url_contains: '/payments' })).requests);
  const d = await mcp.call('get_server_request', { id: err.id });
  assert.equal(d.method, 'POST');
  assert.equal(d.status, 500);
  assert.equal(d.requestHeaders['x-request-id'], 'req-123');
  assert.equal(d.responseHeaders['content-type'], 'application/json');
});

test('the app filter and clear work per app', async () => {
  const before = ((await mcp.call('list_server_requests', { app: '@acme/admin', limit: 100 })).requests).length;
  assert.ok(before > 0);
  await mcp.call('clear_server_requests', { app: '@acme/admin' });
  assert.equal(((await mcp.call('list_server_requests', { app: '@acme/admin' })).requests).length, 0);
  assert.ok(((await mcp.call('list_server_requests', { app: '@acme/web' })).requests).length > 0);
});
