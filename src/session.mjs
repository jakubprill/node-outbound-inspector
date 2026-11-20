// Jedna sesja CDP z procesem aplikacji: tożsamość, Network.enable, hak, odbiór dziennika haka.
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { connectCdp } from './cdp-client.mjs';
import { INSTALL_EXPRESSION, DRAIN_EXPRESSION } from './hook/hook.mjs';
import { NODE_FIXES_EXPRESSION } from './hook/node-fixes.mjs';

export const IDENTITY_EXPRESSION = 'JSON.stringify({ cwd: process.cwd(), pkg: process.env.npm_package_name || null, pid: process.pid, argv: process.argv.slice(1).join(" "), execArgv: process.execArgv, node: process.version })';
const NETWORK_FLAG = '--experimental-network-inspection';

export const MIN_NODE_MAJOR = 24;

/** Czy proces aplikacji działa na wspieranej wersji Node (≥ 24). Nieznana wersja = wspierana. */
export function supportedNode(node) {
  const major = Number(String(node ?? '').replace(/^v/, '').split('.')[0]);
  return !major || major >= MIN_NODE_MAJOR;
}

/**
 * Ostrzeżenia dla procesu na podstawie tożsamości. `Network.enable` odpowiada sukcesem także bez flagi
 * (wada 2), więc o dostępności inspekcji sieci decyduje obecność flagi w execArgv.
 */
export function processWarnings({ execArgv = [], node = '', networkEnabled }) {
  if (!supportedNode(node)) {
    return { networkInspection: false, warnings: [`The process runs on Node ${String(node).replace(/^v/, '')}, but Node ≥ ${MIN_NODE_MAJOR} is required: the process is not inspected. Run the app on Node ${MIN_NODE_MAJOR} or newer.`] };
  }
  const warnings = [];
  const hasFlag = execArgv.includes(NETWORK_FLAG);
  if (!hasFlag) warnings.push(`The process runs without ${NETWORK_FLAG}: outbound requests will not be visible. Add the flag directly to the node command (NODE_OPTIONS does not accept it).`);
  else if (!networkEnabled) warnings.push('Network.enable did not respond — network inspection is unavailable.');
  return { networkInspection: hasFlag && !!networkEnabled, warnings };
}

/** Nazwa aplikacji: APP_NAMES → npm_package_name → name z package.json w cwd → nazwa katalogu → port. */
export function resolveAppName({ port, appNames, pkg, pkgName, cwd }) {
  return appNames[port] || pkg || pkgName || (cwd ? path.basename(cwd) : `port-${port}`);
}

/**
 * Nazwa z package.json w katalogu procesu. Katalog podaje badany proces, więc tylko zwykły plik do 1 MB
 * i odczyt asynchroniczny: FIFO albo /dev/zero nie zawieszą kolektora (audyt B-09).
 */
export async function readPackageName(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const file = path.join(cwd, 'package.json');
  try {
    const st = await stat(file);
    if (!st.isFile() || st.size > 1 << 20) return null;
    const name = JSON.parse(await readFile(file, 'utf8')).name;
    return typeof name === 'string' ? name : null;
  } catch { return null; }
}

/**
 * Otwiera sesję. Zwraca obiekt od razu; identyfikacja i podpięcie haka dzieją się po połączeniu.
 * @param {{ webSocketDebuggerUrl: string, title?: string }} target
 * @param {number} port
 * @param {{ config: any, log: (msg: string) => void, onNetwork: (session: any, method: string, params: any) => void, onClose: (session: any) => void, processId: number }} deps
 */
export function openSession(target, port, { config, log, onNetwork, onClose, processId }) {
  const url = target.webSocketDebuggerUrl;
  const session = { processId, port, title: target.title, url, connectedAt: new Date().toISOString(), app: `port-${port}`, pendingPages: [], warnings: [] };

  async function onOpen() {
    const res = await session.send('Runtime.evaluate', { expression: IDENTITY_EXPRESSION, returnByValue: true });
    let info = {};
    try { info = JSON.parse(res?.result?.value ?? '{}'); } catch {}
    session.pid = info.pid; session.cwd = info.cwd; session.argv = info.argv; session.node = info.node;
    session.app = resolveAppName({ port, appNames: config.appNames, pkg: info.pkg, pkgName: await readPackageName(info.cwd), cwd: info.cwd });
    // Node < 24 nie jest wspierany: bez Network.enable i bez haka — status podaje powód
    if (!supportedNode(info.node)) {
      const check = processWarnings({ node: info.node });
      session.networkOk = false; session.warnings = check.warnings;
      session.ready = true;
      log(`skipped app="${session.app}" port=${port} pid=${session.pid}: ${check.warnings[0]}`);
      return;
    }
    // obejścia błędów Node w inspekcji sieci — przed Network.enable (np. nodejs/node#66551: setEncoding wywraca aplikację)
    const fixes = await session.send('Runtime.evaluate', { expression: NODE_FIXES_EXPRESSION, returnByValue: true });
    try { session.nodeWorkarounds = JSON.parse(fixes?.result?.value ?? '[]'); } catch { session.nodeWorkarounds = []; }
    // własne limity bufora treści w procesie aplikacji (Node buforuje osobno dla każdej sesji CDP)
    const enabled = !!(await session.send('Network.enable', { maxTotalBufferSize: config.inspectorBufferTotal, maxResourceBufferSize: config.inspectorBufferResource }));
    const check = processWarnings({ execArgv: info.execArgv, node: info.node, networkEnabled: enabled });
    session.networkOk = check.networkInspection; session.warnings = check.warnings;
    session.pendingPages = [];
    if (config.pageCorrelation) {
      const r = await session.send('Runtime.evaluate', { expression: INSTALL_EXPRESSION, returnByValue: true });
      session.pageCorrelation = ['installed', 'already'].includes(r?.result?.value);
    }
    session.ready = true; // identyfikacja, Network.enable i hak zakończone
    log(`connected app="${session.app}" port=${port} pid=${session.pid} cwd=${session.cwd} page_correlation=${!!session.pageCorrelation}${session.warnings.length ? ' WARNING: ' + session.warnings.join(' ') : ''}`);
  }

  const cdp = connectCdp(url, {
    timeoutMs: config.sendTimeoutMs,
    onOpen,
    onEvent: (method, params) => { if (method.startsWith('Network.')) onNetwork(session, method, params); },
    onClose: () => { onClose(session); log(`disconnected app="${session.app}" port=${port}`); },
    onError: e => log(`event error app="${session.app}" port=${port}: ${e?.message ?? e}`),
  });
  session.send = cdp.send;
  session.close = cdp.close;

  /** Odbiera i opróżnia dziennik haka (wpisy: url, method, page, t); zapamiętuje porty HTTP procesu. */
  session.drainHookLog = async () => {
    const res = await session.send('Runtime.evaluate', { expression: DRAIN_EXPRESSION, returnByValue: true });
    let out;
    try { out = JSON.parse(res?.result?.value ?? '[]'); } catch { return []; }
    const log = Array.isArray(out) ? out : Array.isArray(out?.log) ? out.log : []; // tablica: hak starszej wersji
    if (Array.isArray(out?.ports)) session.httpPorts = out.ports.filter(p => Number.isInteger(p) && p > 0 && p < 65536 && p !== port).slice(0, 20).sort((a, b) => a - b);
    // wpisy pochodzą z procesu aplikacji (każdy jego kod może je zapisać): tylko poprawny kształt (audyt B-04)
    return log.slice(0, 5000).filter(e => e && typeof e.url === 'string' && typeof e.method === 'string' && Number.isFinite(e.t)
      && e.page && typeof e.page === 'object' && typeof e.page.url === 'string' && typeof e.page.method === 'string');
  };
  return session;
}
