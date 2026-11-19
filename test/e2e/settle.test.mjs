// settle_ms (M6): analiza wywołana w trakcie renderowania strony czeka, aż ruch ucichnie,
// zamiast pokazać tylko część zapytań.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';

const APP = { name: '@acme/web', dir: 'web' }; // porty przydziela startScenario; /seq: trzy zapytania po 150 ms jedno po drugim

test('settle_ms: analiza w trakcie strony z trzema zapytaniami po 150 ms zwraca komplet trzech', async () => {
  const sc = await startScenario({ apps: [APP] });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(APP.inspect) }, stderr: 'ignore' });
  try {
    await m.waitForApps(1);
    await sc.hit(sc.apps[0], '/seq'); // rozgrzewka: pierwsze wywołanie fetch w procesie jest wolniejsze
    await m.call('clear_server_requests');

    const page = sc.hit(sc.apps[0], '/seq');
    await sleep(80); // pierwsze zapytanie w toku
    const res = await m.call('analyze_server_timeline', { app: '@acme/web', settle_ms: 300 });
    await page;

    assert.equal(res.settle.settled, true, JSON.stringify(res.settle));
    assert.ok(res.settle.waited_ms >= 300, `czekał ${res.settle.waited_ms} ms`);
    const [seq] = res['@acme/web'].by_page_request;
    assert.equal(seq.requests, 3, JSON.stringify(res['@acme/web']));
    assert.equal(seq.verdict_code, 'sequential');
    assert.equal(res['@acme/web'].in_flight, 0);

    const quiet = await m.call('analyze_server_timeline', { app: '@acme/web', settle_ms: 100 });
    assert.ok(quiet.settle.settled && quiet.settle.waited_ms < 1000, 'cisza w ruchu: bez zbędnego czekania');
  } finally { m.close(); sc.stop(); }
});
