// Fałszywy inspektor na skanowanym porcie (testy regresyjne z audytu bezpieczeństwa):
// zniekształcone dane nie wywracają kolektora, cel wskazujący inny proces jest odrzucany,
// package.json jako FIFO nie zawiesza kolektora.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startMcp } from '../helpers/mcp-client.mjs';
import { fx, freePorts, sleep } from '../helpers/scenario.mjs';

async function withFake(env, fn) {
  const [port] = await freePorts(1);
  const fake = spawn(process.execPath, [fx('fake-inspector.mjs')], { env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' });
  await sleep(300);
  const m = await startMcp({ env: { INSPECTOR_PORTS: String(port) }, stderr: 'ignore' });
  try { return await fn(m, port); } finally { m.close(); fake.kill(); }
}

for (const mode of ['nonjson', 'badevent', 'badlog']) {
  test(`zniekształcone dane (${mode}): kolektor żyje i odpowiada`, () => withFake({ MODE: mode }, async m => {
    await sleep(2500); // podłączenie + atak + kilka cykli odpytywania
    const s = await m.call('inspector_status');
    assert.equal(s.apps.length, 1);
    assert.ok(Array.isArray((await m.call('list_server_requests')).requests));
  }));
}

test('cel wskazujący inny port niż skanowany jest odrzucany (bez przekierowania kolektora)', async () => {
  const [other] = await freePorts(1);
  await withFake({ MODE: 'none', WS_URL: `ws://127.0.0.1:${other}/victim` }, async m => {
    await sleep(2000);
    assert.deepEqual((await m.call('inspector_status')).apps, []);
  });
});

test('cel na hoście spoza pętli zwrotnej jest odrzucany', () => withFake({ MODE: 'none', WS_URL: 'ws://example.com:9229/x' }, async m => {
  await sleep(2000);
  assert.deepEqual((await m.call('inspector_status')).apps, []);
}));

test('package.json jako FIFO nie zawiesza kolektora', { skip: process.platform === 'win32' && 'brak mkfifo' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'noi-fifo-'));
  execFileSync('mkfifo', [path.join(dir, 'package.json')]);
  await withFake({ MODE: 'none', FAKE_CWD: dir, FAKE_PKG: '' }, async m => {
    await sleep(1500);
    const s = await Promise.race([m.call('inspector_status'), sleep(5000).then(() => 'TIMEOUT')]);
    assert.notEqual(s, 'TIMEOUT', 'kolektor odpowiada');
    assert.equal(s.apps.length, 1);
  });
});
