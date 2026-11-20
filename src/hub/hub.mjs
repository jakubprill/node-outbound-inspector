// outbound-hub: jeden adres dla chrome://inspect. Słucha na 127.0.0.1:9229 (adres, który chrome://inspect
// sprawdza bez konfiguracji), znajduje procesy Node z inspektorem na skanowanych portach i wystawia je jako
// jedną listę celów. Połączenie DevTools jest przepinane do właściwego procesu na poziomie TCP po nagłówkach
// HTTP Upgrade — bez rozumienia protokołu WebSocket i bez zależności.
import http from 'node:http';
import net from 'node:net';
import { isIP } from 'node:net';
import { listTargets } from '../discovery.mjs';
import { connectCdp } from '../cdp-client.mjs';
import { IDENTITY_EXPRESSION, readPackageName, resolveAppName } from '../session.mjs';

export const HUB_MARKER = 'node-outbound-inspector-hub';

/**
 * Ochrona przed DNS rebinding, jak w samym Node: przyjmujemy tylko nagłówek Host będący adresem IP albo `localhost`.
 * Strona z innej domeny, która przemapuje swoją nazwę na 127.0.0.1, wyśle Host ze swoją nazwą i zostanie odrzucona.
 */
export function allowedHost(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.startsWith('[') ? hostHeader.slice(1, hostHeader.indexOf(']')) : hostHeader.replace(/:\d+$/, '');
  return host === 'localhost' || isIP(host) !== 0;
}

/** Cel inspektora przepisany na adres huba: ścieżka `/<port>/<id>` wskazuje proces docelowy. */
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
    outboundHub: true, // kolektor MCP pomija takie cele (to te same procesy co na ich portach)
  };
}

/**
 * @param {{ host?: string, port: number, ports: readonly number[], appNames?: Record<string, string>,
 *   scanIntervalMs?: number, listTimeoutMs?: number, identify?: boolean, version?: string, log?: (m: string) => void }} opts
 */
export function createHub({ host = '127.0.0.1', port, ports, appNames = {}, scanIntervalMs = 1500, listTimeoutMs = 500, identify = true, version = '0', log = () => {} }) {
  const scanned = ports.filter(p => p !== port);
  /** port → { targets, name } */
  const apps = new Map();
  /** webSocketDebuggerUrl → nazwa (tożsamość ustalana raz na proces) */
  const names = new Map();
  let timer = null;

  /** Nazwa aplikacji jak w kolektorze: APP_NAMES → npm_package_name → package.json w cwd → katalog → port. */
  function identifyTarget(t, p) {
    const fallback = resolveAppName({ port: p, appNames });
    if (appNames[p] || !identify) return Promise.resolve(fallback);
    return new Promise(resolve => {
      const done = name => { clearTimeout(timeout); try { cdp.close(); } catch {} resolve(name); };
      const timeout = setTimeout(() => done(fallback), 2000);
      const cdp = connectCdp(t.webSocketDebuggerUrl, {
        timeoutMs: 1500,
        onOpen: async () => {
          // tylko odczyt tożsamości; bez Network.enable (zob. nodejs/node#66551) i bez haka
          const res = await cdp.send('Runtime.evaluate', { expression: IDENTITY_EXPRESSION, returnByValue: true });
          let info = {};
          try { info = JSON.parse(res?.result?.value ?? '{}'); } catch {}
          done(resolveAppName({ port: p, appNames, pkg: info.pkg, pkgName: readPackageName(info.cwd), cwd: info.cwd }));
        },
        onClose: () => done(fallback),
      });
    });
  }

  async function scanPort(p) {
    const list = await listTargets(p, { timeoutMs: listTimeoutMs });
    const targets = (list ?? []).filter(t => t.webSocketDebuggerUrl && !t.outboundHub && t.type === 'node');
    if (!targets.length) { if (apps.delete(p)) log(`gone port=${p}`); return; }
    for (const t of targets) {
      if (!names.has(t.webSocketDebuggerUrl)) {
        names.set(t.webSocketDebuggerUrl, `port-${p}`);
        names.set(t.webSocketDebuggerUrl, await identifyTarget(t, p));
        log(`found app="${names.get(t.webSocketDebuggerUrl)}" port=${p}`);
      }
    }
    apps.set(p, { targets, name: names.get(targets[0].webSocketDebuggerUrl) });
  }
  const scan = () => Promise.all(scanned.map(scanPort));

  /** Lista celów dla chrome://inspect (Host z żądania, żeby adresy pasowały do tego, czym Chrome się łączył). */
  const list = hubHost => [...apps].sort(([a], [b]) => a - b)
    .flatMap(([p, a]) => a.targets.map(t => rewriteTarget(t, { port: p, name: names.get(t.webSocketDebuggerUrl) ?? a.name, hubHost })));

  // jak inspektor Node: Content-Length i bez keep-alive — prosty klient HTTP w chrome://inspect nie czyta odpowiedzi chunked
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
    // chrome://inspect pokazuje cele typu `node` tylko pod „przeglądarką” `node.js/…`; nasz znacznik jest osobnym polem
    if (url === '/json/version') return json(res, 200, { Browser: `node.js/${process.version}`, 'Protocol-Version': '1.1', [HUB_MARKER]: version });
    return json(res, 404, { error: 'Not found' });
  });

  // przepięcie WebSocket: tylko do procesów, które hub sam znalazł na skanowanych portach (nie dowolny port)
  server.on('upgrade', (req, socket, head) => {
    const reject = (code, msg) => { socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\n\r\n`); };
    if (!allowedHost(req.headers.host)) return reject(403, 'Forbidden');
    const m = /^\/(\d+)\/([\w-]+)$/.exec(req.url);
    const p = m && Number(m[1]);
    const target = m && apps.get(p)?.targets.find(t => t.id === m[2]);
    if (!target) return reject(404, 'Not Found');
    log(`devtools → app="${names.get(target.webSocketDebuggerUrl) ?? `port-${p}`}" port=${p}`);
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
    apps: () => [...apps].map(([p, a]) => ({ port: p, app: a.name, targets: a.targets.length })),
    close() { clearInterval(timer); server.closeAllConnections?.(); return new Promise(r => server.close(() => r())); },
  };
}
