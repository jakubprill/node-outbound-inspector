// Zależności danych między zapytaniami (issue #6): łańcuch, w którym kolejne zapytanie używa danych
// z odpowiedzi poprzedniego, nie może dostać rady „Promise.all” ani fałszywej oszczędności.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startMcp } from '../helpers/mcp-client.mjs';
import { startScenario, sleep } from '../helpers/scenario.mjs';
import { HINTS } from '../../src/analyze/waterfall.mjs';

const APP = { name: '@acme/web', dir: 'web', script: 'deps-app.mjs' }; // porty przydziela startScenario

test('POST /orders → GET /orders/status?orderId=…: zależne; para niezależna bez zmian', async () => {
  const sc = await startScenario({ apps: [APP] });
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(APP.inspect) }, stderr: 'ignore' });
  try {
    await m.waitForApps(1);
    for (const p of ['/order', '/order-full', '/indep']) await sc.hit(sc.apps[0], p);
    await sleep(500);
    const res = await m.call('analyze_server_timeline', { app: '@acme/web', detail: 'full' });
    const page = p => res['web'].by_page_request.find(x => x.page === `GET ${p}`);

    const order = page('/order'), [dep] = order.sequential_chains;
    assert.equal(order.verdict_code, 'sequential', 'werdykt opisuje oś czasu — ta się nie zmienia');
    assert.equal(dep.dependencies.length, 1);
    assert.deepEqual([dep.dependencies[0].from_step, dep.dependencies[0].to_step], [0, 1]);
    assert.equal(dep.dependencies[0].evidence.found_in, 'query:orderId');
    assert.equal(dep.dependencies[0].evidence.from_path, '$.orderId');
    assert.match(dep.dependencies[0].evidence.value, /^ord_[0-9a-f-]{16}…$/);
    assert.ok(dep.potential_saving_ms <= 1, `fałszywa oszczędność: ${dep.potential_saving_ms}`);
    assert.ok(order.potential_saving_ms_if_fully_parallel <= 1, String(order.potential_saving_ms_if_fully_parallel));
    assert.equal(dep.hint, HINTS.dependent);
    assert.deepEqual(dep.dependency_check, { status: 'complete' });

    const full = page('/order-full'), [ch] = full.sequential_chains;
    assert.equal(ch.length, 3);
    assert.deepEqual(ch.dependencies.map(d => [d.from_step, d.to_step, d.evidence.found_in]),
      [[0, 1, 'query:orderId'], [0, 2, 'header:x-order-id']]);
    const durations = full.timeline.map(t => t.duration_ms);
    const naive = ch.wall_ms - Math.max(...durations);
    assert.ok(ch.potential_saving_ms > 15 && ch.potential_saving_ms < naive - 20,
      `oszczędność tylko z kroków niezależnych: ${ch.potential_saving_ms} (dawniej ${naive})`);
    assert.match(ch.hint, /steps\[1\], steps\[2\]/);
    assert.deepEqual(full.dependencies.map(d => [d.from_id, d.to_id]), ch.dependencies.map(d => [d.from_id, d.to_id]));

    const indep = page('/indep'), [free] = indep.sequential_chains;
    assert.deepEqual(free.dependencies, []);
    assert.deepEqual(free.dependency_check, { status: 'complete' });
    assert.equal(free.hint, HINTS.independent);
    assert.equal(free.potential_saving_ms, free.wall_ms - Math.max(...indep.timeline.map(t => t.duration_ms)));
    assert.ok(free.potential_saving_ms > 25, String(free.potential_saving_ms));
  } finally { m.close(); sc.stop(); }
});
