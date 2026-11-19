// Serwer MCP: JSON-RPC 2.0, jedna wiadomość na linię (stdio). `handle` nie dotyka strumieni.

/**
 * @param {{ info: { name: string, version: string }, tools: Record<string, { description: string, inputSchema: object, run: Function }>, beforeCall?: () => Promise<unknown> }} opts
 */
export function createMcpServer({ info, tools, beforeCall = async () => {} }) {
  /** @returns {Promise<object | null>} odpowiedź albo null (notyfikacja lub nieczytelna wiadomość) */
  async function handle(msg) {
    const { id, method, params } = msg;
    if (id === undefined) return null; // notyfikacje
    try {
      let result;
      if (method === 'initialize') result = {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: info.name, version: info.version },
      };
      else if (method === 'ping') result = {};
      else if (method === 'tools/list') result = { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
      else if (method === 'tools/call') {
        const t = tools[params.name]; if (!t) throw new Error(`Nieznane narzędzie: ${params.name}`);
        await beforeCall();
        try { result = { content: [{ type: 'text', text: JSON.stringify(await t.run(params.arguments || {}), null, 2) }] }; }
        catch (e) { result = { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
      } else return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      return { jsonrpc: '2.0', id, result };
    } catch (e) { return { jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } }; }
  }
  return { handle };
}

/** Podpina serwer pod strumienie: linie wejścia → handle → linie wyjścia. */
export function serveStdio(server, { stdin, stdout, onEnd }) {
  let buf = '';
  stdin.setEncoding('utf8');
  stdin.on('data', chunk => {
    buf += chunk; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      server.handle(msg).then(res => { if (res) stdout.write(JSON.stringify(res) + '\n'); });
    }
  });
  stdin.on('end', () => onEnd?.());
}
