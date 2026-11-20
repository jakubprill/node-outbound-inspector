// MCP server: JSON-RPC 2.0, one message per line (stdio). `handle` does not touch streams.
// Two protocol eras (ADR 0007): the old one with `initialize` and the current one (2026-07-28), stateless, with the
// protocol version in `_meta` of every request. A request with `_meta` is handled the new way, without it the old way.

/** Supported MCP protocol versions with `initialize` (old era), newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);
/** Supported stateless versions (version in `_meta` of every request). */
export const MODERN_PROTOCOL_VERSIONS = Object.freeze(['2026-07-28']);

const META = 'io.modelcontextprotocol/';
export const ERR = Object.freeze({ invalidParams: -32602, methodNotFound: -32601, internal: -32603, unsupportedVersion: -32022 });

/** The version chosen for the client: its own if we know it; otherwise our newest. */
export const negotiateVersion = requested => SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0];

class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

/**
 * @param {{ info: { name: string, version: string }, instructions?: string, tools: Record<string, { description: string, inputSchema: object, run: Function }>, beforeCall?: () => Promise<unknown> }} opts
 */
export function createMcpServer({ info, instructions, tools, beforeCall = async () => {} }) {
  const serverInfo = { name: info.name, version: info.version };
  const toolList = () => ({ tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) });

  async function callTool(params) {
    const t = tools[params?.name]; if (!t) throw new Error(`Unknown tool: ${params?.name}`);
    await beforeCall();
    try { return { content: [{ type: 'text', text: JSON.stringify(await t.run(params.arguments || {})) }] }; }
    catch (e) { return { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
  }

  /** Old era: a session opened by `initialize`, results without `resultType`. */
  async function legacy(method, params) {
    if (method === 'initialize') return {
      protocolVersion: negotiateVersion(params?.protocolVersion),
      capabilities: { tools: {} },
      serverInfo,
      ...(instructions ? { instructions } : {}),
    };
    if (method === 'ping') return {};
    if (method === 'tools/list') return toolList();
    if (method === 'tools/call') return callTool(params);
    if (method === 'server/discover') throw new RpcError(ERR.invalidParams, `Invalid params: missing _meta["${META}protocolVersion"]`);
    return null;
  }

  /** Current era: every request carries the client's version and capabilities in `_meta`; the result has `resultType`. */
  async function modern(method, params, meta) {
    const requested = meta[`${META}protocolVersion`];
    if (!MODERN_PROTOCOL_VERSIONS.includes(requested)) {
      throw new RpcError(ERR.unsupportedVersion, 'Unsupported protocol version', { supported: [...MODERN_PROTOCOL_VERSIONS], requested });
    }
    if (meta[`${META}clientCapabilities`] == null) throw new RpcError(ERR.invalidParams, `Invalid params: missing _meta["${META}clientCapabilities"]`);
    let result;
    if (method === 'server/discover') result = {
      supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      ...(instructions ? { instructions } : {}),
    };
    else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = toolList();
    else if (method === 'tools/call') result = await callTool(params);
    else return null;
    return { resultType: 'complete', ...result, _meta: { [`${META}serverInfo`]: serverInfo } };
  }

  /** @returns {Promise<object | null>} a response or null (a notification or an unreadable message) */
  async function handle(msg) {
    const { id, method, params } = msg;
    if (id === undefined) return null; // notyfikacje
    try {
      const meta = params?._meta;
      const isModern = method !== 'initialize' && meta && typeof meta === 'object' && `${META}protocolVersion` in meta;
      const result = isModern ? await modern(method, params, meta) : await legacy(method, params);
      if (result === null) return { jsonrpc: '2.0', id, error: { code: ERR.methodNotFound, message: `Method not found: ${method}` } };
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      const code = e instanceof RpcError ? e.code : ERR.internal;
      return { jsonrpc: '2.0', id, error: { code, message: String(e.message || e), ...(e.data !== undefined ? { data: e.data } : {}) } };
    }
  }
  return { handle };
}

/** Connects the server to streams: input lines → handle → output lines. */
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
