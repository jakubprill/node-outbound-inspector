// Hak w procesie potomnym (nie w procesie testów): przypisanie zapytań do żądania strony,
// idempotentna instalacja, brak wpisów poza kontekstem żądania.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { INSTALL_EXPRESSION, DRAIN_EXPRESSION } from '../../src/hook/hook.mjs';

const child = `
const http = require('node:http');
const results = { first: ${INSTALL_EXPRESSION}, second: ${INSTALL_EXPRESSION} };
const svc = http.createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', () => {
  const S = 'http://127.0.0.1:' + svc.address().port;
  const app = http.createServer(async (q, s) => {
    await fetch(S + '/from-fetch');
    await new Promise(ok => http.get(S + '/from-http', r => { r.resume(); r.on('end', ok); }));
    s.end('done');
  }).listen(0, '127.0.0.1', async () => {
    await fetch(S + '/outside');                       // poza żądaniem strony
    await fetch('http://127.0.0.1:' + app.address().port + '/page?x=1');
    results.log = JSON.parse(${DRAIN_EXPRESSION});
    results.afterDrain = JSON.parse(${DRAIN_EXPRESSION});
    console.log(JSON.stringify(results));
    // bez process.exit(): na Windows exit przy otwartych połączeniach keep-alive wywraca libuv (issue #7);
    // zamknięte serwery i połączenia pozwalają procesowi zakończyć się samemu
    for (const s of [app, svc]) { s.close(); s.closeAllConnections(); }
  });
});`;

test('hak przypisuje fetch i node:http do żądania strony', () => {
  const p = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 10000 });
  assert.equal(p.status, 0, p.stderr);
  const res = JSON.parse(p.stdout);
  assert.equal(res.first, 'installed');
  assert.equal(res.second, 'already');
  const paths = res.log.map(e => new URL(e.url).pathname);
  assert.deepEqual(paths, ['/from-fetch', '/from-http'], 'bez /outside i bez zapytania testu do /page');
  assert.ok(res.log.every(e => e.page.method === 'GET' && e.page.url === '/page?x=1' && typeof e.t === 'number'));
  assert.equal(res.log[0].page.id, res.log[1].page.id);
  assert.deepEqual(res.afterDrain, [], 'odbiór opróżnia dziennik');
});
