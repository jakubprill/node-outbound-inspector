// A client of the current MCP era only (2026-07-28): no initialize, the version in _meta of every request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { SERVER_PATH } from '../helpers/mcp-client.mjs';

test('stdio, 2026-07-28 era: server/discover, then tools/call without initialize', async () => {
  const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, INSPECTOR_PORTS: '9899' } });
  const lines = [];
  let buf = '';
  proc.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const _meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 'modern', version: '1' } };
  const send = m => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  const reply = async id => { for (let i = 0; i < 100; i++) { const r = lines.find(l => l.id === id); if (r) return r; await new Promise(res => setTimeout(res, 50)); } throw new Error(`no response ${id}`); };
  try {
    send({ id: 'd1', method: 'server/discover', params: { _meta } });
    const d = await reply('d1');
    assert.equal(d.result.resultType, 'complete');
    assert.deepEqual(d.result.supportedVersions, ['2026-07-28']);
    assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name, 'node-outbound-inspector');
    assert.match(d.result.instructions, /outbound HTTP requests/);

    send({ id: 2, method: 'tools/call', params: { name: 'inspector_status', arguments: {}, _meta } });
    const s = await reply(2);
    assert.equal(s.result.resultType, 'complete');
    assert.deepEqual(JSON.parse(s.result.content[0].text).apps, []);
  } finally { proc.kill(); }
});
