import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMcpServer, serveStdio } from '../../src/mcp/server.mjs';

let calls = 0;
const server = createMcpServer({
  info: { name: 'x', version: '1' },
  tools: {
    ok: { description: 'd', inputSchema: { type: 'object' }, run: a => ({ got: a }) },
    boom: { description: 'd', inputSchema: { type: 'object' }, run: () => { throw new Error('nie'); } },
  },
  beforeCall: async () => { calls++; },
});

test('initialize odsyła wersję protokołu klienta', async () => {
  const res = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.deepEqual(res.result, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '1' } });
});

test('nieznana wersja protokołu → najnowsza wspierana; instructions', async () => {
  const s2 = createMcpServer({ info: { name: 'x', version: '1' }, instructions: 'Używaj ostrożnie.', tools: {} });
  const res = await s2.handle({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
  assert.equal(res.result.protocolVersion, '2025-06-18');
  assert.equal(res.result.instructions, 'Używaj ostrożnie.');
});

test('ping, tools/list, notyfikacje', async () => {
  assert.deepEqual((await server.handle({ id: 2, method: 'ping' })).result, {});
  assert.deepEqual((await server.handle({ id: 3, method: 'tools/list' })).result.tools.map(t => t.name), ['ok', 'boom']);
  assert.equal(await server.handle({ method: 'notifications/initialized' }), null);
});

test('tools/call: wynik, błąd narzędzia, nieznane narzędzie, nieznana metoda', async () => {
  const before = calls;
  const ok = await server.handle({ id: 4, method: 'tools/call', params: { name: 'ok', arguments: { a: 1 } } });
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { got: { a: 1 } });
  assert.equal(calls, before + 1, 'beforeCall przed każdym wywołaniem');
  const boom = await server.handle({ id: 5, method: 'tools/call', params: { name: 'boom' } });
  assert.deepEqual(boom.result, { content: [{ type: 'text', text: 'nie' }], isError: true });
  assert.deepEqual((await server.handle({ id: 6, method: 'tools/call', params: { name: 'nope' } })).error, { code: -32603, message: 'Unknown tool: nope' });
  assert.deepEqual((await server.handle({ id: 7, method: 'x/y' })).error, { code: -32601, message: 'Method not found: x/y' });
});

const modernMeta = (extra = {}) => ({ 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
  'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' }, ...extra });

test('era 2026-07-28: server/discover bez initialize', async () => {
  const s2 = createMcpServer({ info: { name: 'x', version: '1' }, instructions: 'Use carefully.', tools: {} });
  const res = await s2.handle({ id: 'discover-1', method: 'server/discover', params: { _meta: modernMeta() } });
  assert.deepEqual(res.result, {
    resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, instructions: 'Use carefully.',
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'x', version: '1' } },
  });
});

test('era 2026-07-28: nieobsługiwana wersja, brak wymaganych pól, sonda bez _meta', async () => {
  const bad = await server.handle({ id: 1, method: 'tools/list', params: { _meta: modernMeta({ 'io.modelcontextprotocol/protocolVersion': '1900-01-01' }) } });
  assert.deepEqual(bad.error, { code: -32022, message: 'Unsupported protocol version', data: { supported: ['2026-07-28'], requested: '1900-01-01' } });
  const noCaps = await server.handle({ id: 2, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } } });
  assert.equal(noCaps.error.code, -32602);
  const probe = await server.handle({ id: 3, method: 'server/discover', params: {} });
  assert.equal(probe.error.code, -32602, 'sonda bez wersji: błąd parametrów, nie cisza');
  assert.equal((await server.handle({ id: 4, method: 'x/y', params: { _meta: modernMeta() } })).error.code, -32601);
});

test('era 2026-07-28: tools/list i tools/call z resultType i serverInfo; dawna era bez zmian obok', async () => {
  const list = await server.handle({ id: 1, method: 'tools/list', params: { _meta: modernMeta() } });
  assert.equal(list.result.resultType, 'complete');
  assert.deepEqual(list.result.tools.map(t => t.name), ['ok', 'boom']);
  assert.deepEqual(list.result._meta, { 'io.modelcontextprotocol/serverInfo': { name: 'x', version: '1' } });
  const call = await server.handle({ id: 2, method: 'tools/call', params: { name: 'ok', arguments: { a: 2 }, _meta: modernMeta() } });
  assert.equal(call.result.resultType, 'complete');
  assert.deepEqual(JSON.parse(call.result.content[0].text), { got: { a: 2 } });
  const boom = await server.handle({ id: 3, method: 'tools/call', params: { name: 'boom', _meta: modernMeta() } });
  assert.equal(boom.result.isError, true);
  const old = await server.handle({ id: 4, method: 'tools/list' });
  assert.equal(old.result.resultType, undefined, 'dawna era: wynik jak dotąd');
  const init = await server.handle({ id: 5, method: 'initialize', params: { protocolVersion: '2025-06-18', _meta: modernMeta() } });
  assert.equal(init.result.protocolVersion, '2025-06-18', 'initialize zawsze wybiera dawną erę');
});

test('serveStdio: linie, nieczytelne wiadomości, koniec wejścia', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  let ended = false;
  serveStdio(server, { stdin, stdout, onEnd: () => { ended = true; } });
  const out = [];
  stdout.on('data', d => out.push(...String(d).split('\n').filter(Boolean)));
  stdin.write('nie-json\n\n{"jsonrpc":"2.0","id":9,"method":"pi');
  stdin.write('ng"}\n');
  stdin.end();
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(out.map(l => JSON.parse(l)), [{ jsonrpc: '2.0', id: 9, result: {} }]);
  assert.equal(ended, true);
});
