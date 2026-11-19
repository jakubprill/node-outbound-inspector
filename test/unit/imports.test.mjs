// Import wszystkich modułów nie może niczego uruchamiać (zegary, gniazda, stdin) —
// proces z samymi importami musi zakończyć się sam. Wyjątek: punkt wejścia src/outbound-mcp.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));
const walk = d => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]);

test('import modułów bez efektów ubocznych', () => {
  const modules = walk(SRC).filter(f => f.endsWith('.mjs') && !f.endsWith('outbound-mcp.mjs'));
  assert.ok(modules.length >= 14);
  const code = modules.map(m => `await import(${JSON.stringify(pathToFileURL(m).href)});`).join('\n');
  const p = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(p.error?.code, undefined, 'proces nie zakończył się sam — moduł zostawił otwarty uchwyt');
  assert.equal(p.status, 0, p.stderr);
  assert.equal(p.stdout + p.stderr, '', 'import niczego nie wypisuje');
});

test('żaden moduł nie przekracza ok. 250 linii', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of walk(SRC)) assert.ok(readFileSync(f, 'utf8').split('\n').length <= 250, f);
});
