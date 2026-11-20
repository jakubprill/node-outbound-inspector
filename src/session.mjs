// Jedna sesja CDP z procesem aplikacji: tożsamość, Network.enable, hak, odbiór dziennika haka.
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { connectCdp } from './cdp-client.mjs';
import { INSTALL_EXPRESSION, DRAIN_EXPRESSION } from './hook/hook.mjs';
import { NODE_FIXES_EXPRESSION } from './hook/node-fixes.mjs';
import { appIdentity } from './names.mjs';

// tylko odczyt; PORTLESS_URL daje nazwę aplikacji pod portless (issue #8); bez argv (mogą w nim być tokeny, audyt B-16); uid i zgoda na podsłuch (audyt B-01)
export const IDENTITY_EXPRESSION = 'JSON.stringify({ cwd: process.cwd(), pkg: process.env.npm_package_name || null, pid: process.pid, execArgv: process.execArgv, node: process.version, uid: typeof process.getuid === "function" ? process.getuid() : null, optIn: process.env.OUTBOUND_INSPECT === "1", portless: process.env.PORTLESS_URL || null })';
const NETWORK_FLAG = '--experimental-network-inspection';

export const MIN_NODE_MAJOR = 24;

/**
 * Czy wolno podsłuchiwać proces (audyt B-01): ten sam użytkownik (gdy system ma uid) i jawna zgoda —
 * OUTBOUND_INSPECT=1 (ustawia go outbound-next) albo flaga --experimental-network-inspection, którą deweloper
 * dodaje właśnie po to. Inne procesy z inspektorem (np. zwykłe `node --inspect` innego projektu) są pomijane.
 * @returns {{ allowed: true } | { allowed: false, reason: 'other_user' | 'no_consent', warning: string }}
 */
export function consent({ uid, optIn, execArgv = [] } = {}, ownUid = typeof process.getuid === 'function' ? process.getuid() : null) {
  if (Number.isInteger(uid) && Number.isInteger(ownUid) && uid !== ownUid) {
    return { allowed: false, reason: 'other_user', warning: `The process belongs to another user (uid ${uid}): not inspected, no code injected.` };
  }
  if (optIn === true || (Array.isArray(execArgv) && execArgv.includes(NETWORK_FLAG))) return { allowed: true };
  return { allowed: false, reason: 'no_consent', warning: `The process has an inspector but no consent for inspection (start it with outbound-next, OUTBOUND_INSPECT=1 or ${NETWORK_FLAG}): not inspected, no code injected.` };
}

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

/**
 * Tożsamość nazwy procesu z wyniku IDENTITY_EXPRESSION (issue #8): APP_NAMES → portless → pakiet → katalog → port.
 * @returns {Promise<ReturnType<typeof appIdentity>>}
 */
export async function identityOf(info, { port, appNames = {}, stripScope = true }) {
  return appIdentity({ port, appNames, pkg: info.pkg, pkgName: await readPackageName(info.cwd), cwd: info.cwd, portlessUrl: info.portless },
    { stripScope });
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
 * @param {{ config: any, log: (msg: string) => void, onNetwork: (session: any, method: string, params: any) => void, onClose: (session: any) => void,
 *   onIdentified?: (session: any) => void, processId: number }} deps
 */
export function openSession(target, port, { config, log, onNetwork, onClose, onIdentified = () => {}, processId }) {
  const url = target.webSocketDebuggerUrl;
  const session = { processId, port, title: target.title, url, connectedAt: new Date().toISOString(), app: `port-${port}`, pendingPages: [], warnings: [] };

  async function onOpen() {
    const res = await session.send('Runtime.evaluate', { expression: IDENTITY_EXPRESSION, returnByValue: true });
    let info = {};
    try { info = JSON.parse(res?.result?.value ?? '{}'); } catch {}
    session.pid = Number.isInteger(info.pid) ? info.pid : undefined;
    session.cwd = typeof info.cwd === 'string' ? info.cwd.slice(0, 1024) : undefined;
    session.node = typeof info.node === 'string' ? info.node.slice(0, 32) : undefined;
    session.identity = await identityOf(info, { port, appNames: config.appNames, stripScope: config.stripScope });
    session.app = session.identity.short; session.appAliases = session.identity.aliases;
    onIdentified(session); // kolektor rozstrzyga kolizje krótkich nazw między procesami
    // bez zgody albo inny użytkownik: bez łatek, Network.enable i haka — status podaje powód (audyt B-01)
    const allowed = consent(info);
    if (!allowed.allowed) {
      session.networkOk = false; session.skipped = allowed.reason; session.warnings = [allowed.warning];
      session.ready = true;
      log(`skipped app=${JSON.stringify(session.app)} port=${port} pid=${session.pid}: ${allowed.warning}`);
      return;
    }
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
    log(`connected app="${session.app}" port=${port} pid=${session.pid} cwd=${JSON.stringify(session.cwd)} page_correlation=${!!session.pageCorrelation}${session.warnings.length ? ' WARNING: ' + session.warnings.join(' ') : ''}`);
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
