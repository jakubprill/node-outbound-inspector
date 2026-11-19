// Jedna sesja CDP z procesem aplikacji: tożsamość, Network.enable, hak, odbiór dziennika haka.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { connectCdp } from './cdp-client.mjs';
import { INSTALL_EXPRESSION, DRAIN_EXPRESSION } from './hook/hook.mjs';

const IDENTITY_EXPRESSION = 'JSON.stringify({ cwd: process.cwd(), pkg: process.env.npm_package_name || null, pid: process.pid, argv: process.argv.slice(1).join(" "), execArgv: process.execArgv, node: process.version })';
const NETWORK_FLAG = '--experimental-network-inspection';

/**
 * Ostrzeżenia dla procesu na podstawie tożsamości. `Network.enable` odpowiada sukcesem także bez flagi
 * (wada 2), więc o dostępności inspekcji sieci decyduje obecność flagi w execArgv.
 */
export function processWarnings({ execArgv = [], node = '', networkEnabled }) {
  const warnings = [];
  const hasFlag = execArgv.includes(NETWORK_FLAG);
  if (!hasFlag) warnings.push(`Proces działa bez ${NETWORK_FLAG}: zapytania wychodzące nie będą widoczne. Dodaj flagę bezpośrednio do polecenia node (NODE_OPTIONS jej nie przyjmuje).`);
  else if (!networkEnabled) warnings.push('Network.enable nie odpowiedział — inspekcja sieci niedostępna.');
  const major = Number(String(node).replace(/^v/, '').split('.')[0]);
  if (hasFlag && major && major < 24) warnings.push(`Node ${major}: wersja niewspierana (wymagany ≥ 24) — treści odpowiedzi fetch są niedostępne (body_state: unavailable).`);
  return { networkInspection: hasFlag && !!networkEnabled, nodeMajor: major || null, warnings };
}

/** Nazwa aplikacji: APP_NAMES → npm_package_name → name z package.json w cwd → nazwa katalogu → port. */
export function resolveAppName({ port, appNames, pkg, pkgName, cwd }) {
  return appNames[port] || pkg || pkgName || (cwd ? path.basename(cwd) : `port-${port}`);
}

function readPackageName(cwd) {
  if (!cwd) return null;
  try { return JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8')).name; } catch { return null; }
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
    session.app = resolveAppName({ port, appNames: config.appNames, pkg: info.pkg, pkgName: readPackageName(info.cwd), cwd: info.cwd });
    // własne limity bufora treści w procesie aplikacji (Node buforuje osobno dla każdej sesji CDP)
    const enabled = !!(await session.send('Network.enable', { maxTotalBufferSize: config.inspectorBufferTotal, maxResourceBufferSize: config.inspectorBufferResource }));
    const check = processWarnings({ execArgv: info.execArgv, node: info.node, networkEnabled: enabled });
    session.networkOk = check.networkInspection; session.nodeMajor = check.nodeMajor; session.warnings = check.warnings;
    session.pendingPages = [];
    if (config.pageCorrelation) {
      const r = await session.send('Runtime.evaluate', { expression: INSTALL_EXPRESSION, returnByValue: true });
      session.pageCorrelation = ['installed', 'already'].includes(r?.result?.value);
    }
    session.ready = true; // identyfikacja, Network.enable i hak zakończone
    log(`podłączono app="${session.app}" port=${port} pid=${session.pid} cwd=${session.cwd} korelacja_stron=${!!session.pageCorrelation}${session.warnings.length ? ' UWAGA: ' + session.warnings.join(' ') : ''}`);
  }

  const cdp = connectCdp(url, {
    timeoutMs: config.sendTimeoutMs,
    onOpen,
    onEvent: (method, params) => { if (method.startsWith('Network.')) onNetwork(session, method, params); },
    onClose: () => { onClose(session); log(`rozłączono app="${session.app}" port=${port}`); },
  });
  session.send = cdp.send;
  session.close = cdp.close;

  /** Odbiera i opróżnia dziennik haka (wpisy: url, method, page, t). */
  session.drainHookLog = async () => {
    const res = await session.send('Runtime.evaluate', { expression: DRAIN_EXPRESSION, returnByValue: true });
    try { return JSON.parse(res?.result?.value ?? '[]'); } catch { return []; }
  };
  return session;
}
