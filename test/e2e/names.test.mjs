// App names (issue #8) on live processes: without the npm scope, the name from portless, short-name collision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';
import { createHub } from '../../src/hub/hub.mjs';

test('collision of @acme/web and @other/web: both full names in the status, records and hub; filter by both forms', async () => {
  const apps = [
    { name: 'a', dir: 'web', env: { npm_package_name: '@acme/web' } },
    { name: 'b', dir: 'admin', env: { npm_package_name: '@other/web' } },
    { name: 'c', dir: 'web', env: { npm_package_name: '@acme/shop', PORTLESS_URL: 'http://store.localhost:1355' } },
  ];
  const sc = await startScenario({ apps });
  const m = await startMcp({ env: { INSPECTOR_PORTS: apps.map(a => a.inspect).join(',') }, stderr: 'ignore' });
  const hub = createHub({ port: 0, ports: apps.map(a => a.inspect), scanIntervalMs: 200 });
  try {
    await m.waitForApps(3);
    const st = await m.call('inspector_status');
    assert.deepEqual(st.apps.map(a => a.app).sort(), ['@acme/web', '@other/web', 'store']);
    await sc.hit(sc.apps[0], '/seq');
    await sc.hit(sc.apps[2], '/seq');
    await sleep(500);
    const rows = (await m.call('list_server_requests', { limit: 50 })).requests;
    assert.ok(rows.some(r => r.app === '@acme/web') && rows.some(r => r.app === 'store'), JSON.stringify(rows.map(r => r.app)));
    assert.ok(rows.every(r => ['@acme/web', 'store'].includes(r.app)));
    // portless: the name as in the browser, the filter still works by package name (full and without scope)
    for (const app of ['store', '@acme/shop', 'shop']) assert.ok((await m.call('list_server_requests', { app })).requests.length > 0, app);
    // on a collision the short name is a shared alias: it selects both apps (only @acme/web has traffic here)
    assert.deepEqual([...new Set((await m.call('list_server_requests', { app: 'web' })).requests.map(r => r.app))], ['@acme/web']);

    const { port } = await hub.listen();
    let list = [];
    for (let i = 0; i < 50 && list.length < 3; i++) { await sleep(100); list = hub.apps(); }
    assert.deepEqual(list.map(a => a.app).sort(), ['@acme/web', '@other/web', 'store']);
    assert.ok(port > 0);
  } finally { await hub.close(); m.close(); sc.stop(); }
});

test('APP_NAME_STRIP_SCOPE=0: full package names as before 0.7.0', async () => {
  const apps = [{ name: '@acme/web', dir: 'web' }];
  const sc = await startScenario({ apps });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(apps[0].inspect), APP_NAME_STRIP_SCOPE: '0' }, stderr: 'ignore' });
  try {
    await m.waitForApps(1);
    assert.deepEqual((await m.call('inspector_status')).apps.map(a => a.app), ['@acme/web']);
  } finally { m.close(); sc.stop(); }
});
