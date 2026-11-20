// Initiator stack frames → call sites in app code (without Node, library and framework internals).
// Classification works on a normalized path: no "file://", "/" instead of "\", after decoding %XX.
// Rule: a frame is dropped only when the path UNAMBIGUOUSLY points to a library. When in doubt the frame stays.
//
// Turbopack chunks (verified on Next 16.4.0, pnpm, monorepo): the name is the shared module path with "/" and "."
// replaced by "_", with the prefix shortened to a hash, e.g. "1sqn__pnpm_…" (from ".pnpm"), "0fe5_next_dist_esm_server_…".
// - "[root-of-the-server]__…" and "_1z2yvldm0ete0._.js" CONTAIN app code (page, layout) together with vendored
//   Next — they are not filtered (verified).
// - "1a-q_@opentelemetry_api_build_esm_…" is a library, but the "<hash>_@scope_…" pattern is AMBIGUOUS: a parallel
//   route "@modal" in app code can give a similar name. We do not filter it by name (it can be added
//   to OUTBOUND_LIBRARY_PATHS).
// A better solution (M5, not implemented): a chunk contains module ids, e.g.
// "[project]/apps/web/node_modules/... [app-rsc] (ecmascript)". For a frame (chunk file + line) the module
// containing the line can be found (module boundaries in the chunk text or the source map), and classified by module path
// instead of the chunk name.

/** Libraries installed by a package manager (npm, pnpm "node_modules/.pnpm/…", Yarn PnP). */
const PACKAGES = [
  /\/node_modules\//,                       // any library, also pnpm and webpack-internal:///(rsc)/./node_modules/…
  /\/\.yarn\/(?:cache|unplugged|__virtual__|berry)\//, // Yarn PnP: zip archives and unpacked packages
  /\/\.pnp\.(?:c?js|loader\.mjs)$/,         // Yarn PnP runtime
];

/** Next.js internals and bundled chunks (Turbopack, webpack). */
const BUNDLED = [
  /next\/dist\//,                                             // as before: also without a leading "/"
  /\/\.next\/.*_next_dist_/,                                   // Turbopack: Next internals, e.g. 0fe5_next_dist_esm_server_….js
  /\/\.next\/(?:dev\/)?server\/(?:edge-)?runtime/,
  /\/\.next\/(?:dev\/)?server\/webpack-(?:api-)?runtime\.js$/,  // webpack: runtime
  /\/\.next\/(?:dev\/)?server\/vendor-chunks\//,               // webpack: libraries split into separate chunks
  // Turbopack: the chunk's shared module path is in node_modules (npm: "node_modules_@vercel_otel_…" from issue #2;
  // also "apps_web_node_modules_…" when the package is not hoisted to the monorepo root).
  /\/chunks\/(?:[^/]+\/)*(?:[^/]*_)?node_modules_[^/]*$/,
  /\/chunks\/(?:[^/]+\/)*[^/]*__pnpm_[^/]*$/,                // pnpm: „1sqn__pnpm_…” (segment „.pnpm”)
  /\/chunks\/(?:[^/]+\/)*[^/]*__next-internal_[^/]*$/,       // manifest akcji Next: „…_web__next-internal_server_…”
  /\/chunks\/(?:[^/]+\/)*\[(?:turbopack|externals)\]_[^/]*$/,  // Turbopack runtime, external modules
];

/** "file:///C:/a%20b\\x.js" → "/C:/a b/x.js"; Windows paths get a leading "/" so the patterns are shared. */
export function normalizeFramePath(url) {
  let p = String(url).replace(/^file:\/\//, '');
  try { p = decodeURIComponent(p); } catch {}
  p = p.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(p) ? `/${p}` : p;
}

/**
 * @param {string} url frame address from CDP (file://…, path, node:…, webpack-internal://…)
 * @param {readonly string[]} [libraryPaths] extra library path fragments (OUTBOUND_LIBRARY_PATHS)
 */
export function isLibraryFrame(url, libraryPaths = []) {
  if (!url || url.startsWith('node:')) return true;
  const p = normalizeFramePath(url);
  return PACKAGES.some(re => re.test(p)) || BUNDLED.some(re => re.test(p))
    || libraryPaths.some(s => s && p.includes(s.replace(/\\/g, '/')));
}

/** Path for display: as before without "file://"; "file:///C:/…" → "C:/…". */
const displayPath = url => url.replace(/^file:\/\/\/([A-Za-z]:[\\/])/, '$1').replace(/^file:\/\//, '');

/**
 * @param {{ stack?: { callFrames?: any[], parent?: any } }} [initiator]
 * @param {{ libraryPaths?: readonly string[] }} [options]
 * @returns {string[]} up to 5 frames "function @ path:line:column"; an empty list when all are libraries
 */
export function userFrames(initiator, { libraryPaths = [] } = {}) {
  const frames = [];
  // data from the inspector: shape checked, depth and number of frames limited (audit B-04, B-11)
  for (let st = initiator?.stack, depth = 0; st && typeof st === 'object' && depth < 50; st = st.parent, depth++) {
    if (Array.isArray(st.callFrames)) frames.push(...st.callFrames.slice(0, 200));
  }
  const text = (v, n) => String(v ?? '').slice(0, n);
  return frames
    .filter(f => f && typeof f.url === 'string' && !isLibraryFrame(f.url, libraryPaths))
    .slice(0, 5)
    .map(f => `${text(f.functionName, 200) || '(anonymous)'} @ ${text(displayPath(f.url), 1000)}:${Number(f.lineNumber) + 1}:${Number(f.columnNumber) + 1}`);
}
