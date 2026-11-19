// Odtwarzanie każdego nagrania z test/fixtures/recordings (npm run record) przez czysty rdzeń:
// ingest, redakcja, klasyfikacja treści, korelacja ze stronami, analiza.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readRecording, replay } from '../helpers/replay.mjs';
import { analyze } from '../../src/analyze/findings.mjs';

const DIR = fileURLToPath(new URL('../fixtures/recordings/', import.meta.url));
const files = readdirSync(DIR).filter(f => f.endsWith('.ndjson'));

test('jest co najmniej jedno nagranie', () => assert.ok(files.length >= 1));

for (const file of files) {
  const entries = readRecording(DIR + file);
  const node = entries.find(e => e.kind === 'session')?.node ?? '';
  const major = Number(node.replace(/^v/, '').split('.')[0]);

  test(`${file} (${node}): przypisanie do stron i werdykty jak w scenariuszu e2e`, () => {
    const { store } = replay(entries);
    assert.equal(store.size, 11);
    assert.ok(store.values().every(x => x.page), 'każde zapytanie przypisane do strony');
    const res = analyze(store.select(), {});
    const page = (app, p) => res[app].by_page_request.find(x => x.page === p);
    assert.equal(page('@acme/web', 'GET /seq').verdict_code, 'sequential');
    assert.equal(page('@acme/admin', 'GET /par').verdict_code, 'parallel');
    assert.equal(page('@acme/admin', 'GET /seq').verdict_code, 'sequential');
    assert.equal(page('@acme/admin', 'GET /http').requests, 1);
    assert.deepEqual(res['@acme/web'].errors.map(e => e.status), [500]);
  });

  test(`${file} (${node}): stan treści zależny od wersji Node (wada 4)`, () => {
    const { store } = replay(entries);
    const http = store.values().filter(r => r.type !== 'Fetch');
    const viaFetch = store.values().filter(r => r.type === 'Fetch');
    assert.ok(http.length >= 1 && viaFetch.length >= 1);
    for (const r of http) assert.equal(r.body.state, 'available', r.url);
    for (const r of viaFetch) {
      if (major >= 24) assert.equal(r.body.state, 'available', r.url);
      else { assert.equal(r.body.state, 'unavailable', r.url); assert.match(r.body.reason, /Node 2\d/); }
    }
  });
}
