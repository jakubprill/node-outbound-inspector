#!/usr/bin/env node
// Nagrywa surowy ruch z inspektorów (zdarzenia CDP Network.* i wpisy haka) do pliku NDJSON,
// który testy jednostkowe odtwarzają bez procesów i sieci (test/helpers/replay.mjs).
//
//   node scripts/record-fixture.mjs --ports 9231,9241 --out nagranie.ndjson [--ms 5000]
//   node scripts/record-fixture.mjs --scenario --out test/fixtures/recordings/two-apps-node22.ndjson
//
// --scenario uruchamia aplikacje testowe (test/fixtures) i generuje na nich ruch.
// Uwaga: nagranie z prawdziwej aplikacji może zawierać sekrety (nagłówki, adresy) — przejrzyj przed commitem.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { createDiscovery } from '../src/discovery.mjs';
import { openSession } from '../src/session.mjs';

const { values: opt } = parseArgs({ options: {
  ports: { type: 'string', default: '9229-9249' }, out: { type: 'string' }, ms: { type: 'string', default: '5000' },
  scenario: { type: 'boolean', default: false },
} });
if (!opt.out) { console.error('Podaj --out <plik.ndjson>'); process.exit(1); }

const lines = [];
const write = obj => lines.push(JSON.stringify({ nowMs: Date.now(), ...obj }));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let scenario;
const SCENARIO_APPS = [
  { name: '@acme/web', dir: 'web', port: 4921, inspect: 9531 },
  { name: '@acme/admin', dir: 'admin', port: 4922, inspect: 9541 },
];
if (opt.scenario) {
  const { startScenario } = await import('../test/helpers/scenario.mjs');
  scenario = await startScenario({ servicesPort: 4911, apps: SCENARIO_APPS });
  opt.ports = SCENARIO_APPS.map(a => a.inspect).join(',');
}

const config = loadConfig({ env: { INSPECTOR_PORTS: opt.ports, IGNORE_HOSTS: process.env.IGNORE_HOSTS } });
const sessions = new Map();
const discovery = createDiscovery(config, {
  isKnown: url => sessions.has(url),
  onTarget: (target, port) => {
    const s = openSession(target, port, {
      config, log: m => console.error('[record]', m),
      onNetwork: (session, method, params) => write({ kind: 'network', port: session.port, method, params }),
      onClose: x => sessions.delete(x.url),
    });
    sessions.set(s.url, s);
  },
});
discovery.start();

const ready = () => [...sessions.values()].filter(s => s.networkOk !== undefined && (!config.pageCorrelation || s.pageCorrelation !== undefined));
for (let i = 0; i < 100 && ready().length < (scenario ? SCENARIO_APPS.length : 1); i++) await sleep(100);
for (const s of ready()) write({ kind: 'session', port: s.port, pid: s.pid, app: s.app, cwd: s.cwd ? '<cwd>' : null });

const drain = async () => {
  for (const s of ready()) { const entries = await s.drainHookLog(); if (entries.length) write({ kind: 'hook', port: s.port, entries }); }
};
const drainTimer = setInterval(drain, 200);

if (scenario) {
  const [web, admin] = scenario.apps;
  await Promise.all([scenario.hit(web, '/seq'), scenario.hit(web, '/err'), scenario.hit(admin, '/par'), scenario.hit(admin, '/seq'), scenario.hit(admin, '/http')]);
  await sleep(600);
} else {
  await sleep(Number(opt.ms));
}
clearInterval(drainTimer); await drain();
discovery.stop(); for (const s of sessions.values()) s.close();
scenario?.stop();
// Ścieżki bezwzględne z ramek stosu → <root> (nagrania trafiają do repozytorium)
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
writeFileSync(opt.out, lines.join('\n').split(ROOT).join('<root>') + '\n');
console.error(`[record] zapisano ${lines.length} wpisów do ${opt.out} (Node ${process.version})`);
process.exit(0);
