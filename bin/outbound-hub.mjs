#!/usr/bin/env node
// outbound-hub: wszystkie procesy Node z inspektorem pod jednym adresem dla chrome://inspect (127.0.0.1:9229),
// bez wpisywania portów w „Configure…”. Uruchom obok aplikacji, np. w skrypcie dev monorepo.
//   OUTBOUND_HUB_PORT (domyślnie 9229), INSPECTOR_PORTS (domyślnie 9230-9249), APP_NAMES
import { readFileSync } from 'node:fs';
import { createHub, HUB_MARKER } from '../src/hub/hub.mjs';
import { parsePorts, parseAppNames } from '../src/config.mjs';

const TAG = '[outbound-hub]';
const log = m => process.stderr.write(`${TAG} ${m}\n`);
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) { log(`Node ${process.versions.node} is not supported. Node ≥ 24 is required.`); process.exit(1); }

const env = process.env;
const port = Number(env.OUTBOUND_HUB_PORT || 9229);
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const hub = createHub({
  port,
  ports: parsePorts(env.INSPECTOR_PORTS || '9230-9249'),
  appNames: parseAppNames(env.APP_NAMES),
  identify: env.OUTBOUND_HUB_IDENTIFY !== '0',
  version,
  log,
});

try {
  await hub.listen();
  log(`listening on 127.0.0.1:${port} — open chrome://inspect (localhost:${port} is on its default list)`);
} catch (e) {
  if (e.code !== 'EADDRINUSE') { log(`cannot listen on 127.0.0.1:${port}: ${e.message}`); process.exit(1); }
  // port zajęty: drugi hub (np. z innego terminala) to nie błąd, proces Node z --inspect=9229 już tak
  const other = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) }).then(r => r.json()).catch(() => null);
  if (other?.[HUB_MARKER]) { log(`another outbound-hub is already running on port ${port}; nothing to do`); process.exit(0); }
  log(`port ${port} is taken by another process${other?.Browser ? ` (${other.Browser})` : ''}. `
    + `Give your apps inspector ports other than ${port} (e.g. --inspect=9231) or set OUTBOUND_HUB_PORT and add localhost:<port> in chrome://inspect → Configure….`);
  process.exit(1);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => hub.close().then(() => process.exit(0)));
