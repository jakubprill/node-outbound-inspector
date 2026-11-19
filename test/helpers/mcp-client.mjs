// Minimalny klient MCP (stdio, JSON-RPC 2.0): uruchamia serwer i woła jego narzędzia jak agent.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER_PATH = fileURLToPath(new URL('../../src/outbound-mcp.mjs', import.meta.url));

export async function startMcp({ env = {}, stderr = 'inherit' } = {}) {
  const proc = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', stderr], env: { ...process.env, ...env } });
  let id = 0, buf = '';
  const waiting = new Map();
  proc.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
  });
  const rpc = (method, params) => new Promise(resolve => {
    const i = ++id; waiting.set(i, resolve);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  return {
    init: init.result, rpc,
    async call(name, args = {}) {
      const r = await rpc('tools/call', { name, arguments: args });
      const text = r.result.content[0].text;
      if (r.result.isError) throw new Error(text);
      return JSON.parse(text);
    },
    async waitForApps(n, timeoutMs = 20000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const s = await this.call('inspector_status');
        if (s.apps.filter(a => a.network_inspection).length >= n) return s;
        if (Date.now() > until) throw new Error(`Nie podłączono ${n} aplikacji: ${JSON.stringify(s.apps)}`);
        await new Promise(r => setTimeout(r, 300));
      }
    },
    close() { proc.kill(); },
  };
}
