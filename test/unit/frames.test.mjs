import { test } from 'node:test';
import assert from 'node:assert/strict';
import { userFrames } from '../../src/frames.mjs';

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
