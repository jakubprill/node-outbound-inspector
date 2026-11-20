// Run by `bun`: startHub in a Bun process, the target list and Runtime.evaluate through the hub (hub-api test).
import { startHub } from '../../src/hub/api.mjs';
const hub = await startHub({ port: 0, ports: [Number(process.env.INSPECT_PORT)], scanIntervalMs: 200 });
let apps = [];
for (let i = 0; i < 50 && !apps.length; i++) { await new Promise(r => setTimeout(r, 100)); apps = hub.apps(); }
const [target] = await (await fetch(`${hub.url}/json/list`)).json();
const evaluate = await new Promise(resolve => {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '6*7', returnByValue: true } }));
  ws.onmessage = e => { resolve(JSON.parse(String(e.data)).result?.result?.value); ws.close(); };
  ws.onerror = () => resolve(null);
  setTimeout(() => resolve(null), 5000);
});
await hub.close();
console.log(JSON.stringify({ status: hub.status, apps: apps.map(a => a.app), evaluate }));
process.exit(0);
