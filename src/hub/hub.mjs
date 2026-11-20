// outbound-hub: one address for chrome://inspect. Listens on 127.0.0.1:9229 (the address chrome://inspect
// checks without configuration), finds Node processes with an inspector on the scanned ports and exposes them as
// one target list. The DevTools connection is forwarded to the right process at TCP level after the HTTP
// Upgrade headers — without understanding the WebSocket protocol and without dependencies.
import http from 'node:http';
import net from 'node:net';
import { isIP } from 'node:net';
import { listTargets, validTarget, DISCOVERY_LIMITS } from '../discovery.mjs';
import { connectCdp } from '../cdp-client.mjs';
import { IDENTITY_EXPRESSION, identityOf } from '../session.mjs';
import { appIdentity, assignNames } from '../names.mjs';

export const HUB_MARKER = 'node-outbound-inspector-hub';

/**
 * DNS rebinding protection, as in Node itself: we accept only a Host header that is an IP address or `localhost`.
 * A page from another domain that remaps its name to 127.0.0.1 sends a Host with its own name and is rejected.
 */
export function allowedHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(1, hostHeader.indexOf(']')) : hostHeader.replace(/:\d+$/, '');
  return host === 'localhost' || isIP(host) !== 0;
}

/** An inspector target rewritten to the hub address: the `/<port>/<id>` path points to the target process. */
export function rewriteTarget(t, { port, name, hubHost }) {
  const ws = `${hubHost}/${port}/${t.id}`;
  const front = u => typeof u === 'string' ? u.replace(/([?&]ws=)[^&]*/, `$1${ws}`) : u;
  return {
    ...t,
    title: name,
    description: `${name} · port ${port} · ${t.title ?? 'node'}`,
    webSocketDebuggerUrl: `ws://${ws}`,
    devtoolsFrontendUrl: front(t.devtoolsFrontendUrl),
    devtoolsFrontendUrlCompat: front(t.devtoolsFrontendUrlCompat),
    outboundHub: true, // the MCP collector skips such targets (the same processes as on their own ports)
  };
}

/**
 * @param {{ host?: string, port: number, ports: readonly number[], appNames?: Record<string, string>, stripScope?: boolean,
 *   scanIntervalMs?: number, listTimeoutMs?: number, identify?: boolean, version?: string, log?: (m: string) => void }} opts
 */
export function createHub({ host = '127.0.0.1', port, ports, appNames = {}, stripScope = true, scanIntervalMs = 1500, listTimeoutMs = 500, identify = true, version = '0', log = () => {} }) {
  const scanned = ports.filter(p => p !== port);
  /** port → { targets, name } */
  const apps = new Map();
  /** webSocketDebuggerUrl → name identity (determined once per process) */
  const identities = new Map();
  let timer = null;

  /** Name identity as in the collector: APP_NAMES → portless → package (without scope) → directory → port. */
  function identifyTarget(t, p) {
    const fallback = appIdentity({ port: p, appNames }, { stripScope });
    if (appNames[p] || !identify) return Promise.resolve(fallback);
    return new Promise(resolve => {
      const done = id => { clearTimeout(timeout); try { cdp.close(); } catch {} resolve(id); };
      const timeout = setTimeout(() => done(fallback), 2000);
      const cdp = connectCdp(t.webSocketDebuggerUrl, {
        timeoutMs: 1500,
        onOpen: async () => {
          // identity read only; no Network.enable (see nodejs/node#66551) and no hook
          const res = await cdp.send('Runtime.evaluate', { expression: IDENTITY_EXPRESSION, returnByValue: true });
          let info = {};
          try { info = JSON.parse(res?.result?.value ?? '{}'); } catch {}
          done(await identityOf(info, { port: p, appNames, stripScope }));
        },
        onClose: () => done(fallback),
      });
    });
  }

  /** Display names: short, full on a collision (issue #8) — computed for the targets visible now. */
  function displayNames() {
    const urls = [...apps.values()].flatMap(a => a.targets.map(t => t.webSocketDebuggerUrl)).filter(u => identities.has(u));
    const names = assignNames(urls.map(u => identities.get(u)));
    return new Map(urls.map((u, i) => [u, names[i]]));
  }

  async function scanPort(p) {
    const list = await listTargets(p, { timeoutMs: listTimeoutMs });
    // as in the collector: only targets pointing to the same port on loopback, with a limit (audit B-03, B-11)
    const targets = (list ?? []).filter(t => validTarget(t, p) && !t.outboundHub && t.type === 'node' && typeof t.id === 'string' && /^[\w-]{1,128}$/.test(t.id))
      .slice(0, DISCOVERY_LIMITS.targetsPerPort);
    if (!targets.length) { if (apps.delete(p)) log(`gone port=${p}`); return; }
    for (const t of targets) {
      if (!identities.has(t.webSocketDebuggerUrl)) {
        identities.set(t.webSocketDebuggerUrl, appIdentity({ port: p }));
        identities.set(t.webSocketDebuggerUrl, await identifyTarget(t, p));
        log(`found app="${identities.get(t.webSocketDebuggerUrl).short}" port=${p}`);
      }
    }
    apps.set(p, { targets });
  }
  const scan = () => Promise.all(scanned.map(scanPort));

  /** The target list for chrome://inspect (Host from the request, so addresses match what Chrome connected to). */
  const list = hubHost => {
    const names = displayNames();
    return [...apps].sort(([a], [b]) => a - b)
      .flatMap(([p, a]) => a.targets.map(t => rewriteTarget(t, { port: p, name: names.get(t.webSocketDebuggerUrl) ?? `port-${p}`, hubHost })));
  };

  // like the Node inspector: Content-Length and no keep-alive — chrome://inspect's simple HTTP client does not read chunked responses
  const json = (res, code, body) => {
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=UTF-8', 'Content-Length': data.length, 'Cache-Control': 'no-cache', Connection: 'close' });
    res.end(data);
  };

  const server = http.createServer((req, res) => {
    if (process.env.OUTBOUND_HUB_DEBUG) log(`http ${req.method} ${req.url} host=${req.headers.host}`);
    if (!allowedHost(req.headers.host)) return json(res, 403, { error: 'Host header must be an IP address or localhost' });
    const url = new URL(req.url, 'http://hub').pathname.replace(/\/+$/, ''); // Chrome dokleja parametry, np. ?t=…
    if (url === '/json' || url === '/json/list') return json(res, 200, list(req.headers.host));
    // chrome://inspect shows `node` targets only under a `node.js/…` "browser"; our marker is a separate field
    if (url === '/json/version') return json(res, 200, { Browser: `node.js/${process.version}`, 'Protocol-Version': '1.1', [HUB_MARKER]: version });
    return json(res, 404, { error: 'Not found' });
  });

  // WebSocket forwarding: only to processes the hub itself found on the scanned ports (not any port)
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, msg) => { socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); };
    if (!allowedHost(req.headers.host)) return reject(403, 'Forbidden');
    const m = /^\/(\d+)\/([\w-]+)$/.exec(req.url);
    const p = m && Number(m[1]);
    const target = m && apps.get(p)?.targets.find(t => t.id === m[2]);
    if (!target) return reject(404, 'Not Found');
    log(`devtools → app="${displayNames().get(target.webSocketDebuggerUrl) ?? `port-${p}`}" port=${p}`);
    const upstream = net.connect(p, '127.0.0.1', () => {
      const headers = Object.entries(req.headers).map(([k, v]) => `${k}: ${k === 'host' ? `127.0.0.1:${p}` : v}`);
      upstream.write(`GET /${m[2]} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    const close = () => { upstream.destroy(); socket.destroy(); };
    upstream.on('error', close); socket.on('error', close);
    upstream.on('close', () => socket.destroy()); socket.on('close', () => upstream.destroy());
  });

  return {
    /** @returns {Promise<{ port: number }>} */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          timer = setInterval(scan, scanIntervalMs); timer.unref();
          scan();
          resolve({ port: server.address().port });
        });
      });
    },
    scan,
    apps: () => {
      const names = displayNames();
      return [...apps].map(([p, a]) => ({ port: p, app: names.get(a.targets[0].webSocketDebuggerUrl) ?? `port-${p}`, targets: a.targets.length }));
    },
    close() { clearInterval(timer); server.closeAllConnections?.(); return new Promise(r => server.close(() => r())); },
  };
}
