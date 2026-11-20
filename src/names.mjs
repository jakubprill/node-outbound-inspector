// Nazwy aplikacji (issue #8): krótka nazwa wyświetlana, pełna nazwa przy kolizji i aliasy dla filtra `app`.
// Czyste funkcje: wspólne dla kolektora MCP i outbound-hub.
import path from 'node:path';

/** Nazwa bez znaków sterujących i spacji, do 64 znaków: trafia do agenta i logów (audyt B-07). */
export const cleanName = v => typeof v === 'string' ? v.replace(/[^\w@./+:-]/g, '').slice(0, 64) : '';

/** `@acme/web` → `web`; nazwa bez scope bez zmian. */
export const stripScope = name => /^@[^/]+\/./.test(name) ? name.slice(name.indexOf('/') + 1) : name;

/**
 * Nazwa aplikacji pod portless (vercel-labs/portless) z `PORTLESS_URL`, jak w przeglądarce:
 * `http://web.localhost:1355` → `web`, `https://fix-ui.myapp.localhost` → `fix-ui.myapp`.
 * Dla innych domen (np. `myapp.dev.example.com`) zostaje cała nazwa hosta.
 */
export function portlessName(url) {
  if (typeof url !== 'string' || url.length > 512) return '';
  try {
    const host = new URL(url).hostname;
    return cleanName(host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : host);
  } catch { return ''; }
}

/**
 * Tożsamość nazwy procesu. Kolejność źródeł: APP_NAMES → portless → nazwa pakietu → katalog → port.
 * `short` — nazwa wyświetlana domyślnie, `full` — nazwa przy kolizji krótkich nazw,
 * `aliases` — wszystkie nazwy, pod którymi filtr `app` znajdzie aplikację.
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
  else if (fromPortless) short = full = fromPortless;          // portless sam pilnuje unikalności nazw
  else if (pkgFull) { short = pkgShort; full = pkgFull; }
  else short = full = dir || `port-${port}`;
  const aliases = [...new Set([short, full, pkgFull, pkgShort].filter(Boolean))];
  return { short, full, aliases };
}

/**
 * Nazwy wyświetlane dla zbioru procesów: krótka nazwa, chyba że tę samą krótką nazwę mają procesy
 * o różnych pełnych nazwach (`@a/web` i `@b/web`) — wtedy wszystkie z tej grupy dostają pełne nazwy.
 * Wynik nie zależy od kolejności startu. Kilka procesów tej samej aplikacji zachowuje krótką nazwę.
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
