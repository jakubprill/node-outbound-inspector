// Jedna sesja CDP z procesem aplikacji: tożsamość, Network.enable, hak, odbiór dziennika haka.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { connectCdp } from './cdp-client.mjs';
import { INSTALL_EXPRESSION, DRAIN_EXPRESSION } from './hook/hook.mjs';

const IDENTITY_EXPRESSION = 'JSON.stringify({ cwd: process.cwd(), pkg: process.env.npm_package_name || null, pid: process.pid, argv: process.argv.slice(1).join(" ") })';

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
 * @param {{ config: any, log: (msg: string) => void, onNetwork: (session: any, method: string, params: any) => void, onClose: (session: any) => void }} deps
 */
export function openSession(target, port, { config, log, onNetwork, onClose }) {
  const url = target.webSocketDebuggerUrl;
  const session = { port, title: target.title, url, connectedAt: new Date().toISOString(), app: `port-${port}`, pendingPages: [] };

  async function onOpen() {
    const res = await session.send('Runtime.evaluate', { expression: IDENTITY_EXPRESSION, returnByValue: true });
    let info = {};
    try { info = JSON.parse(res?.result?.value ?? '{}'); } catch {}
    session.pid = info.pid; session.cwd = info.cwd; session.argv = info.argv;
    session.app = resolveAppName({ port, appNames: config.appNames, pkg: info.pkg, pkgName: readPackageName(info.cwd), cwd: info.cwd });
    session.networkOk = !!(await session.send('Network.enable'));
    session.pendingPages = [];
    if (config.pageCorrelation) {
      const r = await session.send('Runtime.evaluate', { expression: INSTALL_EXPRESSION, returnByValue: true });
      session.pageCorrelation = ['installed', 'already'].includes(r?.result?.value);
    }
    log(`podłączono app="${session.app}" port=${port} pid=${session.pid} cwd=${session.cwd} korelacja_stron=${!!session.pageCorrelation}${session.networkOk ? '' : ' (Network.enable bez odpowiedzi — brak --experimental-network-inspection?)'}`);
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
