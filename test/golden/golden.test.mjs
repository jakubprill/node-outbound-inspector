// Testy charakteryzacyjne (golden): kontrakt narzędzi MCP dla agenta. Zrzuty powstały z prototypu
// przed refaktorem M1; po refaktorze wyniki (po normalizacji) muszą być identyczne.
// Aktualizacja zrzutów: UPDATE_GOLDEN=1 npm test  (zmiana kontraktu wymaga wpisu w CHANGELOG.md)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';
import { normalize } from '../helpers/normalize.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const UPDATE = process.env.UPDATE_GOLDEN === '1';
const file = name => fileURLToPath(new URL(`./${name}.json`, import.meta.url));

function golden(name, actual, { raw = false } = {}) {
  const value = raw ? actual : normalize(actual, ROOT);
  if (UPDATE || !existsSync(file(name))) { writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n'); return; }
  assert.deepEqual(value, JSON.parse(readFileSync(file(name), 'utf8')), `golden: ${name}`);
}

const APPS = [
  { name: '@acme/web', dir: 'web', port: 4821, inspect: 9431 },
  { name: '@acme/admin', dir: 'admin', port: 4822, inspect: 9441 },
];
let sc, mcp;
const results = {};

before(async () => {
  sc = await startScenario({ servicesPort: 4811, apps: APPS });
  mcp = await startMcp({ env: { INSPECTOR_PORTS: '9431,9441' }, stderr: 'ignore' });
  await mcp.waitForApps(2);
  const [web, admin] = sc.apps;
  await Promise.all([sc.hit(web, '/seq'), sc.hit(web, '/err'), sc.hit(admin, '/par'), sc.hit(admin, '/seq'), sc.hit(admin, '/http')]);
  await sleep(500);
  results.toolsList = (await mcp.rpc('tools/list')).result;
  results.status = await mcp.call('inspector_status');
  results.listAll = await mcp.call('list_server_requests', { limit: 100 });
  results.listAdminPage = await mcp.call('list_server_requests', { app: '@acme/admin', page_contains: '/seq' });
  results.analyzeAll = await mcp.call('analyze_server_timeline');
  results.analyzeWeb = await mcp.call('analyze_server_timeline', { app: '@acme/web' });
  const [pay] = await mcp.call('list_server_requests', { url_contains: '/payments' });
  results.getPayment = await mcp.call('get_server_request', { id: pay.id });
  results.getMissing = await mcp.rpc('tools/call', { name: 'get_server_request', arguments: { id: 999999 } });
  results.unknownTool = await mcp.rpc('tools/call', { name: 'nope', arguments: {} });
  results.unknownMethod = await mcp.rpc('nope/nope', {});
  results.clearAdmin = await mcp.call('clear_server_requests', { app: '@acme/admin' });
  results.analyzeAfterClear = await mcp.call('analyze_server_timeline', { app: '@acme/admin' });
});
after(() => { mcp?.close(); sc?.stop(); });

test('initialize', () => golden('initialize', mcp.init, { raw: true }));
test('tools/list', () => golden('tools-list', results.toolsList, { raw: true }));
test('inspector_status', () => golden('inspector-status', results.status));
test('list_server_requests', () => golden('list-all', results.listAll));
test('list_server_requests app + page_contains', () => golden('list-admin-page', results.listAdminPage));
test('analyze_server_timeline', () => golden('analyze-all', results.analyzeAll));
test('analyze_server_timeline app', () => golden('analyze-web', results.analyzeWeb));
test('get_server_request', () => golden('get-payment', results.getPayment));
test('get_server_request — brak id', () => golden('get-missing', results.getMissing));
test('nieznane narzędzie', () => golden('unknown-tool', results.unknownTool));
test('nieznana metoda', () => golden('unknown-method', results.unknownMethod));
test('clear_server_requests app', () => golden('clear-admin', results.clearAdmin));
test('analyze po clear', () => golden('analyze-after-clear', results.analyzeAfterClear));
