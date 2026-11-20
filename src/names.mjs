// App names (issue #8): a short display name, the full name on a collision, and aliases for the `app` filter.
// Pure functions: shared by the MCP collector and outbound-hub.
import path from 'node:path';

/** A name without control characters and spaces, up to 64 characters: it reaches the agent and logs (audit B-07). */
export const cleanName = v => typeof v === 'string' ? v.replace(/[^\w@./+:-]/g, '').slice(0, 64) : '';

/** `@acme/web` → `web`; a name without a scope is unchanged. */
export const stripScope = name => /^@[^/]+\/./.test(name) ? name.slice(name.indexOf('/') + 1) : name;

/**
 * The app name under portless (vercel-labs/portless) from `PORTLESS_URL`, as in the browser:
 * `http://web.localhost:1355` → `web`, `https://fix-ui.myapp.localhost` → `fix-ui.myapp`.
 * For other domains (e.g. `myapp.dev.example.com`) the whole host name stays.
 */
export function portlessName(url) {
  if (typeof url !== 'string' || url.length > 512) return '';
  try {
    const host = new URL(url).hostname;
    return cleanName(host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : host);
  } catch { return ''; }
}

/**
 * Name identity of a process. Source order: APP_NAMES → portless → package name → directory → port.
 * `short` — the name shown by default, `full` — the name on a short-name collision,
 * `aliases` — all names under which the `app` filter finds the app.
 * @param {{ port: number, appNames?: Record<string, string>, pkg?: string | null, pkgName?: string | null,
 *   cwd?: string, portlessUrl?: string | null }} input
 * @param {{ stripScope?: boolean }} [opts]
 * @returns {{ short: string, full: string, aliases: string[] }}
 */
export function appIdentity({ port, appNames = {}, pkg, pkgName, cwd, portlessUrl }, { stripScope: strip = true } = {}) {
  const pkgFull = cleanName(pkg) || cleanName(pkgName);
  const pkgShort = strip && pkgFull ? cleanName(stripScope(pkgFull)) : pkgFull;
  const explicit = cleanName(appNames[port]);
  const fromPortless = portlessName(portlessUrl);
  const dir = typeof cwd === 'string' ? cleanName(path.basename(cwd)) : '';
  let short, full;
  if (explicit) short = full = explicit;
  else if (fromPortless) short = full = fromPortless;          // portless itself keeps names unique
  else if (pkgFull) { short = pkgShort; full = pkgFull; }
  else short = full = dir || `port-${port}`;
  const aliases = [...new Set([short, full, pkgFull, pkgShort].filter(Boolean))];
  return { short, full, aliases };
}

/**
 * Display names for a set of processes: the short name, unless processes with different full names
 * share the same short name (`@a/web` and `@b/web`) — then everyone in that group gets the full name.
 * The result does not depend on start order. Several processes of the same app keep the short name.
 * @param {{ short: string, full: string }[]} identities
 * @returns {string[]}
 */
export function assignNames(identities) {
  const fulls = new Map();
  for (const { short, full } of identities) {
    if (!fulls.has(short)) fulls.set(short, new Set());
    fulls.get(short).add(full);
  }
  return identities.map(({ short, full }) => fulls.get(short).size > 1 ? full : short);
}
