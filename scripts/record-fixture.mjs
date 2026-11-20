#!/usr/bin/env node
// Records raw inspector traffic (CDP Network.* events and hook entries) to an NDJSON file,
// which unit tests replay without processes or network (test/helpers/replay.mjs).
//
//   node scripts/record-fixture.mjs --ports 9231,9241 --out recording.ndjson [--ms 5000]
//   node scripts/record-fixture.mjs --scenario   (→ test/fixtures/recordings/two-apps-node<version>.ndjson)
//
// --scenario starts the test apps (test/fixtures) and generates traffic on them.
// Note: a recording from a real app may contain secrets (headers, addresses) — review it before committing.
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { createDiscovery } from '../src/discovery.mjs';
import { openSession } from '../src/session.mjs';

const { values: opt } = parseArgs({ options: {
  ports: { type: 'string', default: '9229-9249' }, out: { type: 'string' }, ms: { type: 'string', default: '5000' },
  scenario: { type: 'boolean', default: false },
} });
if (!opt.out && opt.scenario) opt.out = new URL(`../test/fixtures/recordings/two-apps-node${process.versions.node.split('.')[0]}.ndjson`, import.meta.url).pathname;
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
let processSeq = 0;
const discovery = createDiscovery(config, {
  isKnown: url => sessions.has(url),
  onTarget: (target, port) => {
    const s = openSession(target, port, {
      config, log: m => console.error('[record]', m), processId: ++processSeq,
      onNetwork: (session, method, params) => {
        write({ kind: 'network', port: session.port, method, params });
        // the response body as the inspector returns it (null = error) — for body classification tests
        if (method === 'Network.loadingFinished') session.send('Network.getResponseBody', { requestId: params.requestId })
          .then(res => write({ kind: 'body', port: session.port, requestId: params.requestId, res }));
      },
      onClose: x => sessions.delete(x.url),
    });
    sessions.set(s.url, s);
  },
});
discovery.start();

const ready = () => [...sessions.values()].filter(s => s.networkOk !== undefined && (!config.pageCorrelation || s.pageCorrelation !== undefined));
for (let i = 0; i < 100 && ready().length < (scenario ? SCENARIO_APPS.length : 1); i++) await sleep(100);
for (const s of ready()) write({ kind: 'session', port: s.port, pid: s.pid, app: s.app, cwd: s.cwd ? '<cwd>' : null, node: s.node });

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
// Absolute paths from stack frames → <root> (recordings go into the repository)
const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
writeFileSync(opt.out, lines.join('\n').split(ROOT).join('<root>') + '\n');
console.error(`[record] wrote ${lines.length} entries to ${opt.out} (Node ${process.version})`);
process.exit(0);
