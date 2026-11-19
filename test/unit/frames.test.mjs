import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userFrames, isLibraryFrame, normalizeFramePath } from '../../src/frames.mjs';

const f = (url, functionName = 'fn', lineNumber = 9, columnNumber = 4) => ({ url, functionName, lineNumber, columnNumber });

test('pomija ramki Node, bibliotek i wnętrza Next.js; numeracja od 1', () => {
  const initiator = { stack: { callFrames: [
    f('node:internal/deps/undici/undici'),
    f('file:///repo/node_modules/next/dist/server/lib/patch-fetch.js'),
    f('file:///repo/.next/dev/server/chunks/ssr/0fe5_next_dist_esm_server_1.js', 'dedupeFetch'),
    f('file:///repo/app/page.js', 'Page', 4, 19),
    f('file:///repo/lib/api.js', ''),
  ] } };
  assert.deepEqual(userFrames(initiator), ['Page @ /repo/app/page.js:5:20', '(anonymous) @ /repo/lib/api.js:10:5']);
});

test('uwzględnia ramki rodzica i ogranicza do 5', () => {
  const many = Array.from({ length: 4 }, (_, i) => f(`file:///a${i}.js`));
  const initiator = { stack: { callFrames: many, parent: { callFrames: many } } };
  assert.equal(userFrames(initiator).length, 5);
});

test('brak stosu', () => assert.deepEqual(userFrames(undefined), []));

test('normalizeFramePath: file://, Windows, %XX', () => {
  assert.equal(normalizeFramePath('file:///home/dev/repo/app/page.js'), '/home/dev/repo/app/page.js');
  assert.equal(normalizeFramePath('file:///C:/Users/dev/repo/app/page.js'), '/C:/Users/dev/repo/app/page.js');
  assert.equal(normalizeFramePath('C:\\Users\\dev\\repo\\app\\page.js'), '/C:/Users/dev/repo/app/page.js');
  assert.equal(normalizeFramePath('file:///Users/Jan%20Kowalski/repo/a.js'), '/Users/Jan Kowalski/repo/a.js');
  assert.equal(normalizeFramePath('file:///repo/100%.js'), '/repo/100%.js'); // niepoprawne %XX zostaje bez zmian
});

// Ramki, które muszą zostać rozpoznane jako biblioteki albo wnętrze frameworka.
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
  'Turbopack (Next 16)': [
    'file:///repo/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js',
    'file:///repo/.next/dev/server/chunks/ssr/node_modules_@sentry_core_build_esm_0a1b2c3._.js',
    'C:\\Users\\dev\\acme\\.next\\dev\\server\\chunks\\node_modules_@vercel_otel_dist_node_07k8e6v._.js',
    'file:///C:/Users/dev/acme/.next/dev/server/chunks/ssr/node_modules_next_dist_1a2b3c._.js',
    'file:///repo/.next/dev/server/chunks/ssr/apps_web_node_modules_@acme_sdk_dist_index_9z8y7x._.js', // pakiet nie wyniesiony do korzenia monorepo
    'file:///repo/.next/dev/server/chunks/ssr/0fe5_next_dist_esm_server_1giwg9ci3rpai._.js',
    'file:///repo/.next/server/chunks/ssr/[turbopack]_runtime.js',
    'file:///repo/.next/dev/server/chunks/ssr/[externals]_next_dist_compiled_0a1b2c._.js',
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

// Ramki kodu aplikacji: nie mogą zostać odfiltrowane.
const APP = {
  'Linux / macOS': ['file:///home/dev/repo/app/page.js', 'file:///Users/dev/Projects/acme/apps/web/lib/api.ts', '/srv/app/server.js'],
  'Windows': ['file:///C:/Users/dev/repo/apps/web/app/seq/page.js', 'C:\\Users\\dev\\repo\\apps\\web\\lib\\api.js'],
  'pakiety workspace (symlink → ścieżka rzeczywista)': ['file:///repo/packages/http-client/src/index.js'],
  'fixture testów': ['file:///home/claude/node-outbound-inspector/test/fixtures/fake-app.mjs'],
  'Turbopack: chunki aplikacji': [
    'file:///repo/.next/dev/server/chunks/ssr/apps_web_app_seq_page_1a2b3c._.js',
    'file:///repo/.next/dev/server/chunks/ssr/app_seq_page_tsx_4d5e6f._.js',
    'C:\\Users\\dev\\acme\\.next\\dev\\server\\chunks\\ssr\\apps_web_app_seq_page_1a2b3c._.js',
    'file:///repo/.next/dev/server/chunks/ssr/apps_web_app_@modal_(.)photo_page_7g8h9i._.js', // trasa równoległa „@modal”
    // chunk łączący moduły z różnych katalogów — może zawierać kod aplikacji, więc zostaje (wariant bezpieczny)
    'file:///repo/.next/dev/server/chunks/ssr/[root-of-the-server]__0a1b2c3d._.js',
    'file:///repo/.next/dev/server/app/seq/page.js',
  ],
  'webpack: moduły aplikacji': ['webpack-internal:///(rsc)/./app/seq/page.js', 'file:///repo/.next/server/app/seq/page.js'],
};

for (const [group, urls] of Object.entries(LIBRARY)) {
  test(`biblioteka: ${group}`, () => { for (const u of urls) assert.equal(isLibraryFrame(u), true, u); });
}
for (const [group, urls] of Object.entries(APP)) {
  test(`kod aplikacji: ${group}`, () => { for (const u of urls) assert.equal(isLibraryFrame(u), false, u); });
}

test('issue #2: wrapper fetch z @vercel/otel w chunku Turbopacka nie jest miejscem wywołania', () => {
  const initiator = { stack: { callFrames: [
    f('node:internal/deps/undici/undici', 'fetch'),
    f('file:///C:/Users/dev/acme/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js', 'fetch', 11460, 30),
    f('file:///C:/Users/dev/acme/.next/dev/server/chunks/ssr/0fe5_next_dist_esm_server_1giwg9ci3rpai._.js', 'patched'),
    f('file:///C:/Users/dev/acme/.next/dev/server/chunks/ssr/apps_web_app_seq_page_1a2b3c._.js', 'Page', 41, 8),
  ] } };
  assert.deepEqual(userFrames(initiator), ['Page @ C:/Users/dev/acme/.next/dev/server/chunks/ssr/apps_web_app_seq_page_1a2b3c._.js:42:9']);
});

test('same biblioteki → pusta lista (render pokaże NO_ORIGIN)', () => {
  const initiator = { stack: { callFrames: [
    f('node:internal/deps/undici/undici'),
    f('file:///repo/.next/dev/server/chunks/node_modules_@vercel_otel_dist_node_07k8e6v._.js'),
    f('file:///repo/node_modules/.pnpm/next@16.3.0/node_modules/next/dist/server/lib/patch-fetch.js'),
  ] } };
  assert.deepEqual(userFrames(initiator), []);
});

test('dodatkowe ścieżki bibliotek (OUTBOUND_LIBRARY_PATHS), także z „\\” w Windows', () => {
  const initiator = { stack: { callFrames: [
    f('C:\\repo\\packages\\http-client\\src\\index.js', 'apiFetch'),
    f('file:///C:/repo/.next/dev/server/chunks/ssr/a1b2_@acme_tracing_dist_index_0a1b._.js', 'traced'),
    f('C:\\repo\\apps\\web\\app\\page.js', 'Page', 4, 19),
  ] } };
  assert.equal(userFrames(initiator).length, 3);
  assert.deepEqual(userFrames(initiator, { libraryPaths: ['packages\\http-client\\', '@acme_tracing_'] }),
    ['Page @ C:\\repo\\apps\\web\\app\\page.js:5:20']);
});

test('wyświetlana ścieżka: jak dotąd bez „file://”; Windows „file:///C:/…” → „C:/…”', () => {
  assert.deepEqual(userFrames({ stack: { callFrames: [f('file:///home/dev/a b.js'), f('file:///D:/repo/app/page.js')] } }),
    ['fn @ /home/dev/a b.js:10:5', 'fn @ D:/repo/app/page.js:10:5']);
});
