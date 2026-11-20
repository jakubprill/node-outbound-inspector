import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userFrames, isLibraryFrame, normalizeFramePath } from '../../src/frames.mjs';

const f = (url, functionName = 'fn', lineNumber = 9, columnNumber = 4) => ({ url, functionName, lineNumber, columnNumber });

test('skips Node, library and Next.js internal frames; numbering from 1', () => {
  const initiator = { stack: { callFrames: [
    f('node:internal/deps/undici/undici'),
    f('file:///repo/node_modules/next/dist/server/lib/patch-fetch.js'),
    f('file:///repo/.next/dev/server/chunks/ssr/0fe5_next_dist_esm_server_1.js', 'dedupeFetch'),
    f('file:///repo/app/page.js', 'Page', 4, 19),
    f('file:///repo/lib/api.js', ''),
  ] } };
  assert.deepEqual(userFrames(initiator), ['Page @ /repo/app/page.js:5:20', '(anonymous) @ /repo/lib/api.js:10:5']);
});

test('includes parent frames and limits to 5', () => {
  const many = Array.from({ length: 4 }, (_, i) => f(`file:///a${i}.js`));
  const initiator = { stack: { callFrames: many, parent: { callFrames: many } } };
  assert.equal(userFrames(initiator).length, 5);
});

test('no stack', () => assert.deepEqual(userFrames(undefined), []));

test('normalizeFramePath: file://, Windows, %XX', () => {
  assert.equal(normalizeFramePath('file:///home/dev/repo/app/page.js'), '/home/dev/repo/app/page.js');
  assert.equal(normalizeFramePath('file:///C:/Users/dev/repo/app/page.js'), '/C:/Users/dev/repo/app/page.js');
  assert.equal(normalizeFramePath('C:\\Users\\dev\\repo\\app\\page.js'), '/C:/Users/dev/repo/app/page.js');
  assert.equal(normalizeFramePath('file:///Users/Jan%20Kowalski/repo/a.js'), '/Users/Jan Kowalski/repo/a.js');
  assert.equal(normalizeFramePath('file:///repo/100%.js'), '/repo/100%.js'); // invalid %XX stays unchanged
});

const SSR = 'file:///Users/dev/next-network-test/monorepo/apps/web/.next/dev/server/chunks/ssr/';

// Frames that must be recognized as libraries or framework internals.
const LIBRARY = {
  'Node': ['node:internal/deps/undici/undici', 'node:diagnostics_channel', ''],
  'npm, Linux': [
    'file:///home/dev/repo/node_modules/@vercel/otel/dist/node/index.js',
    '/home/dev/repo/node_modules/undici/lib/fetch/index.js',
    'file:///home/dev/repo/node_modules/@sentry/node/build/cjs/integrations/http.js',
    'file:///home/dev/repo/node_modules/axios/lib/adapters/http.js',
  ],
  'npm, macOS': ['file:///Users/dev/Projects/acme/node_modules/@opentelemetry/instrumentation-undici/build/src/undici.js'],
  'npm, Windows': [
    'file:///C:/Users/dev/repo/node_modules/@vercel/otel/dist/node/index.js',
    'C:\\Users\\dev\\repo\\node_modules\\@vercel\\otel\\dist\\node\\index.js',
  ],
  'pnpm': [
    'file:///home/dev/repo/node_modules/.pnpm/@vercel+otel@2.1.0_@opentelemetry+api@1.9.0/node_modules/@vercel/otel/dist/node/index.js',
    'C:\\repo\\node_modules\\.pnpm\\next@16.3.0_react@19.2.0\\node_modules\\next\\dist\\server\\lib\\patch-fetch.js',
  ],
  'Yarn PnP': [
    'file:///home/dev/repo/.yarn/cache/@vercel-otel-npm-2.1.0-0a1b2c3d4e-5f6a7b8c9d.zip/node_modules/@vercel/otel/dist/node/index.js',
    '/home/dev/repo/.yarn/__virtual__/swr-virtual-6f1c0a2b3d/0/cache/swr-npm-2.2.5-1a2b3c4d5e-6f7a8b9c0d.zip/dist/index.js',
    '/home/dev/repo/.yarn/unplugged/sharp-npm-0.33.5-abc/sharp/lib/index.js',
    'file:///home/dev/repo/.pnp.cjs',
    'file:///home/dev/repo/.pnp.loader.mjs',
  ],
  // The name from issue #2 (Next 16.3, npm, Windows).
  'Turbopack: npm (issue #2)': [
    'file:///repo/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js',
    'C:\\Users\\dev\\acme\\.next\\dev\\server\\chunks\\node_modules_@vercel_otel_dist_node_07k8e6v._.js',
    'file:///C:/Users/dev/acme/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js',
    // synthetic: a package not hoisted to the monorepo root (the same "…_node_modules_…" rule)
    'file:///repo/.next/dev/server/chunks/ssr/apps_web_node_modules_@acme_sdk_dist_index_9z8y7x._.js',
  ],
  // Real names from Next 16.4.0 (Turbopack, pnpm, monorepo, macOS), directory .next/dev/server/chunks/ssr/.
  'Turbopack: Next 16.4.0 + pnpm': [
    `${SSR}1sqn__pnpm_07kp6gukr-l32._.js`,
    `${SSR}0fe5_next_dist_esm_server_1giwg9ci3rpai._.js`,
    `${SSR}[externals]__0mrcya0sqt_it._.js`,
    `${SSR}[externals]_next_dist_1e1zfvsur5d9m._.js`,
    `${SSR}[turbopack]_runtime.js`,
    `${SSR}1cu9_monorepo_apps_web__next-internal_server_app_seq_page_actions_0g1hbsj6qc96x.js`,
    'C:\\Users\\dev\\monorepo\\apps\\web\\.next\\dev\\server\\chunks\\ssr\\1sqn__pnpm_07kp6gukr-l32._.js',
  ],
  'webpack (Next)': [
    'file:///repo/.next/server/vendor-chunks/@vercel+otel@2.1.0.js',
    'file:///repo/.next/dev/server/vendor-chunks/next.js',
    'file:///repo/.next/server/webpack-runtime.js',
    'file:///repo/.next/server/webpack-api-runtime.js',
    'webpack-internal:///(rsc)/./node_modules/@vercel/otel/dist/node/index.js',
    'file:///repo/.next/server/edge-runtime-webpack.js',
  ],
};

// App code frames: they must not be filtered out.
const APP = {
  'Linux / macOS': ['file:///home/dev/repo/app/page.js', 'file:///Users/dev/Projects/acme/apps/web/lib/api.ts', '/srv/app/server.js'],
  'Windows': ['file:///C:/Users/dev/repo/apps/web/app/seq/page.js', 'C:\\Users\\dev\\repo\\apps\\web\\lib\\api.js'],
  'workspace packages (symlink → real path)': ['file:///repo/packages/http-client/src/index.js'],
  'test fixture': ['file:///home/claude/node-outbound-inspector/test/fixtures/fake-app.mjs'],
  // Real names from Next 16.4.0 + pnpm: both chunks contain app code (page /seq, layout) together
  // with vendored Next — verified, they must not be filtered out.
  'Turbopack: chunks with app code (Next 16.4.0)': [
    `${SSR}[root-of-the-server]__1cq79-2rux-0n._.js`,
    `${SSR}_1z2yvldm0ete0._.js`,
    'C:\\Users\\dev\\monorepo\\apps\\web\\.next\\dev\\server\\chunks\\ssr\\[root-of-the-server]__1cq79-2rux-0n._.js',
    'file:///repo/.next/dev/server/app/seq/page.js',
  ],
  // Synthetic: chunks named after an app path (also the parallel route "@modal").
  'Turbopack: chunks named after an app path (synthetic)': [
    `${SSR}apps_web_app_seq_page_1a2b3c._.js`,
    `${SSR}apps_web_app_@modal_(.)photo_page_7g8h9i._.js`,
  ],
  // A real library (@opentelemetry/api from pnpm), but the "<hash>_@scope_…" pattern is ambiguous
  // (cf. "@modal"), so it is deliberately NOT filtered by name — see the comment in src/frames.mjs (M5).
  'Turbopack: ambiguous <hash>_@scope_ (Next 16.4.0)': [`${SSR}1a-q_@opentelemetry_api_build_esm_1z7x-zm6h4k4g._.js`],
  'webpack: app modules': ['webpack-internal:///(rsc)/./app/seq/page.js', 'file:///repo/.next/server/app/seq/page.js'],
};

for (const [group, urls] of Object.entries(LIBRARY)) {
  test(`library: ${group}`, () => { for (const u of urls) assert.equal(isLibraryFrame(u), true, u); });
}
for (const [group, urls] of Object.entries(APP)) {
  test(`app code: ${group}`, () => { for (const u of urls) assert.equal(isLibraryFrame(u), false, u); });
}

test('issue #2: a library fetch wrapper in a Turbopack chunk is not a call site', () => {
  const initiator = { stack: { callFrames: [
    f('node:internal/deps/undici/undici', 'fetch'),
    f('file:///C:/Users/dev/acme/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js', 'fetch', 11460, 30),
    f(`${SSR}1sqn__pnpm_07kp6gukr-l32._.js`, 'helper'),
    f(`${SSR}0fe5_next_dist_esm_server_1giwg9ci3rpai._.js`, 'patched'),
    f(`${SSR}[root-of-the-server]__1cq79-2rux-0n._.js`, 'Page', 41, 8),
  ] } };
  assert.deepEqual(userFrames(initiator),
    ['Page @ /Users/dev/next-network-test/monorepo/apps/web/.next/dev/server/chunks/ssr/[root-of-the-server]__1cq79-2rux-0n._.js:42:9']);
});

test('an ambiguous <hash>_@scope_ chunk can be added through OUTBOUND_LIBRARY_PATHS', () => {
  const initiator = { stack: { callFrames: [
    f(`${SSR}1a-q_@opentelemetry_api_build_esm_1z7x-zm6h4k4g._.js`, 'with'),
    f(`${SSR}[root-of-the-server]__1cq79-2rux-0n._.js`, 'Page'),
  ] } };
  assert.equal(userFrames(initiator).length, 2);
  assert.equal(userFrames(initiator, { libraryPaths: ['_@opentelemetry_'] }).length, 1);
});

test('libraries only → an empty list (render shows NO_ORIGIN)', () => {
  const initiator = { stack: { callFrames: [
    f('node:internal/deps/undici/undici'),
    f('file:///repo/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js'),
    f('file:///repo/node_modules/.pnpm/next@16.3.0/node_modules/next/dist/server/lib/patch-fetch.js'),
  ] } };
  assert.deepEqual(userFrames(initiator), []);
});

test('extra library paths (OUTBOUND_LIBRARY_PATHS), also with "\\" on Windows', () => {
  const initiator = { stack: { callFrames: [
    f('C:\\repo\\packages\\http-client\\src\\index.js', 'apiFetch'),
    f('file:///C:/repo/.next/dev/server/chunks/ssr/a1b2_@acme_tracing_dist_index_0a1b._.js', 'traced'),
    f('C:\\repo\\apps\\web\\app\\page.js', 'Page', 4, 19),
  ] } };
  assert.equal(userFrames(initiator).length, 3);
  assert.deepEqual(userFrames(initiator, { libraryPaths: ['packages\\http-client\\', '@acme_tracing_'] }),
    ['Page @ C:\\repo\\apps\\web\\app\\page.js:5:20']);
});

test('display path: as before without "file://"; Windows "file:///C:/…" → "C:/…"', () => {
  assert.deepEqual(userFrames({ stack: { callFrames: [f('file:///home/dev/a b.js'), f('file:///D:/repo/app/page.js')] } }),
    ['fn @ /home/dev/a b.js:10:5', 'fn @ D:/repo/app/page.js:10:5']);
});
