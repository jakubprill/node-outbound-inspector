// The nodejs/node#66551 workaround: attaching the collector must not crash an app that reads a node:http
// response after setEncoding() (without the workaround: TypeError: Missing dataLength in event, stream destroyed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';
import { installNodeFixes, NODE_FIXES_EXPRESSION } from '../../src/hook/node-fixes.mjs';

test('an app with setEncoding() works with the collector attached, the body is available', async () => {
  const app = { name: '@acme/web', dir: 'web', script: 'setencoding-app.mjs' };
  const sc = await startScenario({ apps: [app] });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(app.inspect) }, stderr: 'ignore' });
  try {
    const st = await m.waitForApps(1);
    // without the workaround the response never comes (the stream silently destroyed) — a timeout instead of a hang
    for (let i = 0; i < 3; i++) assert.equal(await sc.hit(sc.apps[0], '/', { signal: AbortSignal.timeout(3000) }), '{"service":"/small"}', 'the response reached the app');
    await sleep(300);
    assert.equal(sc.apps[0].proc.exitCode, null, 'the app process lives');
    const [r] = (await m.call('list_server_requests', { url_contains: '/small', limit: 1 })).requests;
    const d = await m.call('get_server_request', { id: r.id });
    assert.equal(d.body_state, 'available');
    assert.equal(d.body, '{"service":"/small"}');
    assert.deepEqual(st.apps[0].node_workarounds, ['nodejs/node#66551']);
  } finally { m.close(); sc.stop(); }
});

test('the workaround is idempotent and self-contained (works as Runtime.evaluate text)', () => {
  const p = spawnSync(process.execPath, ['-e', `const a = ${NODE_FIXES_EXPRESSION}; const b = ${NODE_FIXES_EXPRESSION}; console.log(a, b)`], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout.trim(), '["nodejs/node#66551"] ["nodejs/node#66551"]');
  assert.equal(typeof installNodeFixes, 'function');
});
