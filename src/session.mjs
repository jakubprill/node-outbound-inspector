// One CDP session with an app process: identity, Network.enable, hook, receiving the hook log.
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { connectCdp } from './cdp-client.mjs';
import { INSTALL_EXPRESSION, DRAIN_EXPRESSION } from './hook/hook.mjs';
import { NODE_FIXES_EXPRESSION } from './hook/node-fixes.mjs';
import { appIdentity } from './names.mjs';

// read-only; PORTLESS_URL gives the app name under portless (issue #8); no argv (it may contain tokens, audit B-16); uid and consent to inspection (audit B-01)
export const IDENTITY_EXPRESSION = 'JSON.stringify({ cwd: process.cwd(), pkg: process.env.npm_package_name || null, pid: process.pid, execArgv: process.execArgv, node: process.version, uid: typeof process.getuid === "function" ? process.getuid() : null, optIn: process.env.OUTBOUND_INSPECT === "1", portless: process.env.PORTLESS_URL || null })';
const NETWORK_FLAG = '--experimental-network-inspection';

export const MIN_NODE_MAJOR = 24;

/**
 * Whether the process may be inspected (audit B-01): the same user (when the system has uids) and explicit consent —
 * OUTBOUND_INSPECT=1 (set by outbound-next) or the --experimental-network-inspection flag, which the developer
 * adds precisely for this. Other processes with an inspector (e.g. a plain `node --inspect` of another project) are skipped.
 * @returns {{ allowed: true } | { allowed: false, reason: 'other_user' | 'no_consent', warning: string }}
 */
export function consent({ uid, optIn, execArgv = [] } = {}, ownUid = typeof process.getuid === 'function' ? process.getuid() : null) {
  if (Number.isInteger(uid) && Number.isInteger(ownUid) && uid !== ownUid) {
    return { allowed: false, reason: 'other_user', warning: `The process belongs to another user (uid ${uid}): not inspected, no code injected.` };
  }
  if (optIn === true || (Array.isArray(execArgv) && execArgv.includes(NETWORK_FLAG))) return { allowed: true };
  return { allowed: false, reason: 'no_consent', warning: `The process has an inspector but no consent for inspection (start it with outbound-next, OUTBOUND_INSPECT=1 or ${NETWORK_FLAG}): not inspected, no code injected.` };
}

/** Whether the app process runs on a supported Node version (≥ 24). An unknown version = supported. */
export function supportedNode(node) {
  const major = Number(String(node ?? '').replace(/^v/, '').split('.')[0]);
  return !major || major >= MIN_NODE_MAJOR;
}

/**
 * Warnings for a process based on its identity. `Network.enable` succeeds even without the flag
 * (defect 2), so whether network inspection is available is decided by the flag in execArgv.
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
 * Name identity of a process from the IDENTITY_EXPRESSION result (issue #8): APP_NAMES → portless → package → directory → port.
 * @returns {Promise<ReturnType<typeof appIdentity>>}
 */
export async function identityOf(info, { port, appNames = {}, stripScope = true }) {
  return appIdentity({ port, appNames, pkg: info.pkg, pkgName: await readPackageName(info.cwd), cwd: info.cwd, portlessUrl: info.portless },
    { stripScope });
}

/**
 * Name from package.json in the process directory. The inspected process gives the directory, so only a regular file up to 1 MB
 * and an asynchronous read: a FIFO or /dev/zero will not hang the collector (audit B-09).
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
 * Opens a session. Returns the object immediately; identification and attaching the hook happen after connecting.
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
    onIdentified(session); // the collector resolves short-name collisions between processes
    // no consent or another user: no patches, Network.enable or hook — the status gives the reason (audit B-01)
    const allowed = consent(info);
    if (!allowed.allowed) {
      session.networkOk = false; session.skipped = allowed.reason; session.warnings = [allowed.warning];
      session.ready = true;
      log(`skipped app=${JSON.stringify(session.app)} port=${port} pid=${session.pid}: ${allowed.warning}`);
      return;
    }
    // Node < 24 is not supported: no Network.enable and no hook — the status gives the reason
    if (!supportedNode(info.node)) {
      const check = processWarnings({ node: info.node });
      session.networkOk = false; session.warnings = check.warnings;
      session.ready = true;
      log(`skipped app="${session.app}" port=${port} pid=${session.pid}: ${check.warnings[0]}`);
      return;
    }
    // workarounds for Node bugs in network inspection — before Network.enable (e.g. nodejs/node#66551: setEncoding crashes the app)
    const fixes = await session.send('Runtime.evaluate', { expression: NODE_FIXES_EXPRESSION, returnByValue: true });
    try { session.nodeWorkarounds = JSON.parse(fixes?.result?.value ?? '[]'); } catch { session.nodeWorkarounds = []; }
    // our own body buffer limits in the app process (Node buffers separately for every CDP session)
    const enabled = !!(await session.send('Network.enable', { maxTotalBufferSize: config.inspectorBufferTotal, maxResourceBufferSize: config.inspectorBufferResource }));
    const check = processWarnings({ execArgv: info.execArgv, node: info.node, networkEnabled: enabled });
    session.networkOk = check.networkInspection; session.warnings = check.warnings;
    session.pendingPages = [];
    if (config.pageCorrelation) {
      const r = await session.send('Runtime.evaluate', { expression: INSTALL_EXPRESSION, returnByValue: true });
      session.pageCorrelation = ['installed', 'already'].includes(r?.result?.value);
    }
    session.ready = true; // identification, Network.enable and hook done
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

  /** Receives and drains the hook log (entries: url, method, page, t); stores the process's HTTP ports. */
  session.drainHookLog = async () => {
    const res = await session.send('Runtime.evaluate', { expression: DRAIN_EXPRESSION, returnByValue: true });
    let out;
    try { out = JSON.parse(res?.result?.value ?? '[]'); } catch { return []; }
    const log = Array.isArray(out) ? out : Array.isArray(out?.log) ? out.log : []; // array: an older hook version
    if (Array.isArray(out?.ports)) session.httpPorts = out.ports.filter(p => Number.isInteger(p) && p > 0 && p < 65536 && p !== port).slice(0, 20).sort((a, b) => a - b);
    // entries come from the app process (any of its code can write them): valid shape only (audit B-04)
    return log.slice(0, 5000).filter(e => e && typeof e.url === 'string' && typeof e.method === 'string' && Number.isFinite(e.t)
      && e.page && typeof e.page === 'object' && typeof e.page.url === 'string' && typeof e.page.method === 'string');
  };
  return session;
}
