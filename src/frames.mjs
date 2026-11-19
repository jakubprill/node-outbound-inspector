// Ramki stosu inicjatora → miejsca wywołania w kodzie aplikacji (bez wnętrza Node, bibliotek i frameworka).
// Klasyfikacja działa na ścieżce znormalizowanej: bez „file://”, z „/” zamiast „\”, po dekodowaniu %XX.
// Zasada: ramkę odrzucamy tylko wtedy, gdy ścieżka JEDNOZNACZNIE wskazuje bibliotekę. Przy wątpliwości ramka zostaje.
//
// Chunki Turbopacka (zweryfikowane na Next 16.4.0, pnpm, monorepo): nazwa to wspólna ścieżka modułów z „/” i „.”
// zamienionymi na „_”, z prefiksem skróconym do hasha, np. „1sqn__pnpm_…” (z „.pnpm”), „0fe5_next_dist_esm_server_…”.
// - „[root-of-the-server]__…” i „_1z2yvldm0ete0._.js” ZAWIERAJĄ kod aplikacji (strona, layout) razem z vendorowanym
//   Next — nie są filtrowane (zweryfikowane).
// - „1a-q_@opentelemetry_api_build_esm_…” to biblioteka, ale wzór „<hash>_@scope_…” jest NIEJEDNOZNACZNY: trasa
//   równoległa „@modal” w kodzie aplikacji może dać podobną nazwę. Nie filtrujemy go po nazwie (można dopisać
//   do OUTBOUND_LIBRARY_PATHS).
// Lepsze rozwiązanie (M5, nie zaimplementowane): chunk zawiera identyfikatory modułów, np.
// "[project]/apps/web/node_modules/... [app-rsc] (ecmascript)". Dla ramki (plik chunku + linia) można ustalić moduł,
// w którym leży linia (granice modułów w tekście chunku albo mapa źródeł), i klasyfikować po ścieżce modułu,
// a nie po nazwie chunku.

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
  // Turbopack: wspólna ścieżka modułów chunku leży w node_modules (npm: „node_modules_@vercel_otel_…” z issue #2;
  // także „apps_web_node_modules_…”, gdy pakiet nie jest wyniesiony do korzenia monorepo).
  /\/chunks\/(?:[^/]+\/)*(?:[^/]*_)?node_modules_[^/]*$/,
  /\/chunks\/(?:[^/]+\/)*[^/]*__pnpm_[^/]*$/,                // pnpm: „1sqn__pnpm_…” (segment „.pnpm”)
  /\/chunks\/(?:[^/]+\/)*[^/]*__next-internal_[^/]*$/,       // manifest akcji Next: „…_web__next-internal_server_…”
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
