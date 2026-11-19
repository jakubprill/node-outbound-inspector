// Ramki stosu inicjatora → miejsca wywołania w kodzie aplikacji (bez wnętrza Node, bibliotek i frameworka).
// Klasyfikacja działa na ścieżce znormalizowanej: bez „file://”, z „/” zamiast „\”, po dekodowaniu %XX.
// Zasada: ramkę odrzucamy tylko wtedy, gdy ścieżka JEDNOZNACZNIE wskazuje bibliotekę. Przy wątpliwości
// (np. chunk Turbopacka „[root-of-the-server]__…”, który może łączyć kod aplikacji z bibliotekami) ramka zostaje.

/** Biblioteki zainstalowane menedżerem pakietów (npm, pnpm „node_modules/.pnpm/…”, Yarn PnP). */
const PACKAGES = [
  /\/node_modules\//,                       // dowolna biblioteka, także pnpm i webpack-internal:///(rsc)/./node_modules/…
  /\/\.yarn\/(?:cache|unplugged|__virtual__|berry)\//, // Yarn PnP: archiwa zip i pakiety rozpakowane
  /\/\.pnp\.(?:c?js|loader\.mjs)$/,         // środowisko uruchomieniowe Yarn PnP
];

/** Wnętrze Next.js i pakowanych chunków (Turbopack, webpack). */
const BUNDLED = [
  /next\/dist\//,                                             // jak dotąd: także bez wiodącego „/”
  /\/\.next\/.*_next_dist_/,                                   // Turbopack: wnętrze Next, np. 0fe5_next_dist_esm_server_….js
  /\/\.next\/(?:dev\/)?server\/(?:edge-)?runtime/,
  /\/\.next\/(?:dev\/)?server\/webpack-(?:api-)?runtime\.js$/,  // webpack: środowisko uruchomieniowe
  /\/\.next\/(?:dev\/)?server\/vendor-chunks\//,               // webpack: biblioteki wydzielone do osobnych chunków
  // Turbopack nazywa chunk wspólną ścieżką modułów („/” → „_”). Nazwa zaczynająca się od „node_modules_”
  // (albo „apps_web_node_modules_” w monorepo) oznacza, że wszystkie moduły chunku leżą w node_modules.
  /\/chunks\/(?:[^/]+\/)*(?:[^/]*_)?node_modules_[^/]*$/,
  /\/chunks\/(?:[^/]+\/)*\[(?:turbopack|externals)\]_[^/]*$/,  // runtime Turbopacka, moduły zewnętrzne
];

/** "file:///C:/a%20b\\x.js" → "/C:/a b/x.js"; ścieżki Windows dostają wiodący „/”, żeby wzorce były wspólne. */
export function normalizeFramePath(url) {
  let p = String(url).replace(/^file:\/\//, '');
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(p) ? `/${p}` : p;
}

/**
 * @param {string} url adres ramki z CDP (file://…, ścieżka, node:…, webpack-internal://…)
 * @param {readonly string[]} [libraryPaths] dodatkowe fragmenty ścieżek bibliotek (OUTBOUND_LIBRARY_PATHS)
 */
export function isLibraryFrame(url, libraryPaths = []) {
  if (!url || url.startsWith('node:')) return true;
  const p = normalizeFramePath(url);
  return PACKAGES.some(re => re.test(p)) || BUNDLED.some(re => re.test(p))
    || libraryPaths.some(s => s && p.includes(s.replace(/\\/g, '/')));
}

/** Ścieżka do wyświetlenia: jak dotąd bez „file://”; „file:///C:/…” → „C:/…”. */
const displayPath = url => url.replace(/^file:\/\/\/([A-Za-z]:[\\/])/, '$1').replace(/^file:\/\//, '');

/**
 * @param {{ stack?: { callFrames?: any[], parent?: any } }} [initiator]
 * @param {{ libraryPaths?: readonly string[] }} [options]
 * @returns {string[]} do 5 ramek „funkcja @ ścieżka:linia:kolumna”; pusta lista, gdy same biblioteki
 */
export function userFrames(initiator, { libraryPaths = [] } = {}) {
  const frames = [];
  for (let st = initiator?.stack; st; st = st.parent) frames.push(...(st.callFrames ?? []));
  return frames
    .filter(f => !isLibraryFrame(f.url, libraryPaths))
    .slice(0, 5)
    .map(f => `${f.functionName || '(anonymous)'} @ ${displayPath(f.url)}:${f.lineNumber + 1}:${f.columnNumber + 1}`);
}
