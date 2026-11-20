#!/usr/bin/env node
// outbound-hub: all Node processes with an inspector under one address for chrome://inspect (127.0.0.1:9229),
// without typing ports in "Configure…". Run it next to the apps, e.g. in a monorepo dev script.
// A thin wrapper around the `node-outbound-inspector/hub` API (issue #9): messages, exit codes and signals.
//   OUTBOUND_HUB_PORT (default 9229), INSPECTOR_PORTS (default 9230-9249), APP_NAMES, APP_NAME_STRIP_SCOPE
import { startHub, DEFAULT_HUB_PORT, DEFAULT_INSPECTOR_PORTS } from '../src/hub/api.mjs';

const TAG = '[outbound-hub]';
const log = m => process.stderr.write(`${TAG} ${m}\n`);
const env = process.env;
const port = Number(env.OUTBOUND_HUB_PORT || DEFAULT_HUB_PORT);

let hub;
try {
  hub = await startHub({
    port,
    ports: env.INSPECTOR_PORTS || DEFAULT_INSPECTOR_PORTS,
    appNames: env.APP_NAMES || {},
    stripScope: env.APP_NAME_STRIP_SCOPE !== '0',
    identify: env.OUTBOUND_HUB_IDENTIFY !== '0',
    log,
  });
} catch (e) {
  log(e.code === 'ERR_OUTBOUND_NODE_VERSION' ? e.message : `cannot listen on 127.0.0.1:${port}: ${e.message}`);
  process.exit(1);
}

if (hub.status === 'already-running') {
  log(`another outbound-hub is already running on port ${port}; nothing to do`);
  process.exit(0);
}
if (hub.status === 'port-taken') {
  log(`port ${port} is taken by another process${hub.holder ? ` (${hub.holder})` : ''}. `
    + `Give your apps inspector ports other than ${port} (e.g. --inspect=9231) or set OUTBOUND_HUB_PORT and add localhost:<port> in chrome://inspect → Configure….`);
  process.exit(1);
}
log(`listening on 127.0.0.1:${hub.port} — open chrome://inspect (localhost:${hub.port} is on its default list)`);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => hub.close().then(() => process.exit(0)));
