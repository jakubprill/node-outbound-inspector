// The hook in a child process (not in the test process): assigning requests to the page request,
// idempotent installation, no entries outside a request context.
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
    await fetch(S + '/outside');                       // outside a page request
    await fetch('http://127.0.0.1:' + app.address().port + '/page?x=1', { headers: { 'x-nextjs-request-id': 'rq1', 'x-nextjs-html-request-id': 'html1' } });
    await fetch('http://127.0.0.1:' + app.address().port + '/_next/mcp');   // an internal Next tooling request
    results.ports = { app: app.address().port, svc: svc.address().port };
    results.log = JSON.parse(${DRAIN_EXPRESSION});
    results.afterDrain = JSON.parse(${DRAIN_EXPRESSION});
    console.log(JSON.stringify(results));
    // no process.exit(): on Windows, exiting with open keep-alive connections crashes libuv (issue #7);
    // closed servers and connections let the process end by itself
    for (const s of [app, svc]) { s.close(); s.closeAllConnections(); }
  });
});`;

test('the hook assigns fetch and node:http to the page request', () => {
  const p = spawnSync(process.execPath, ['-e', child], { encoding: 'utf8', timeout: 10000 });
  assert.equal(p.status, 0, p.stderr);
  const res = JSON.parse(p.stdout);
  assert.equal(res.first, 'installed');
  assert.equal(res.second, 'already');
  const { log, ports } = res.log;
  const paths = log.map(e => new URL(e.url).pathname);
  assert.deepEqual(paths, ['/from-fetch', '/from-http'], 'without /outside, without the test request to /page and without requests from /_next/mcp');
  assert.ok(log.every(e => e.page.method === 'GET' && e.page.url === '/page?x=1' && typeof e.t === 'number'));
  assert.equal(log[0].page.id, log[1].page.id);
  assert.equal(log[0].page.nextRequestId, 'rq1', 'the Next request id');
  assert.equal(log[0].page.nextHtmlRequestId, 'html1');
  assert.deepEqual([...ports].sort(), [res.ports.app, res.ports.svc].sort(), 'the process HTTP ports: listening and from requests');
  assert.deepEqual(res.afterDrain.log, [], 'receiving drains the log');
  assert.deepEqual(res.afterDrain.ports.sort(), [res.ports.app, res.ports.svc].sort(), 'the ports stay');
});
