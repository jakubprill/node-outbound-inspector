// settle_ms (M6): analysis called while a page renders waits until traffic is quiet,
// instead of showing only some of the requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';

const APP = { name: '@acme/web', dir: 'web' }; // ports assigned by startScenario; /seq: three requests of 150 ms one after another

test('settle_ms: analysis during a page with three requests of 150 ms each returns all three', async () => {
  const sc = await startScenario({ apps: [APP] });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(APP.inspect) }, stderr: 'ignore' });
  try {
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/seq'); // warm-up: the first fetch call in a process is slower
    await m.call('clear_server_requests');

    const page = sc.hit(sc.apps[0], '/seq');
    await sleep(80); // the first request in flight
    const res = await m.call('analyze_server_timeline', { app: '@acme/web', settle_ms: 300 });
    await page;

    assert.equal(res.settle.settled, true, JSON.stringify(res.settle));
    assert.ok(res.settle.waited_ms >= 300, `waited ${res.settle.waited_ms} ms`);
    const [seq] = res['web'].pages;
    assert.equal(seq.requests, 3, JSON.stringify(res['web']));
    assert.equal(seq.verdict_code, 'sequential');
    assert.equal(res['web'].in_flight, 0);

    const quiet = await m.call('analyze_server_timeline', { app: '@acme/web', settle_ms: 100 });
    assert.ok(quiet.settle.settled && quiet.settle.waited_ms < 1000, 'quiet traffic: no needless waiting');
  } finally { m.close(); sc.stop(); }
});
