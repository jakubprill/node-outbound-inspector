#!/usr/bin/env node
// Najprostszy klient CDP: robi to samo co zakładka Network w "dedicated DevTools for Node".
// Uruchom aplikację z `node --inspect --experimental-network-inspection app.js`, potem:
//   node examples/cdp-network-probe.mjs [port=9229]
const port = process.argv[2] || 9229;
const [target] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.onopen = () => { send('Network.enable'); console.log(`connected to ${target.title} — waiting for requests (Ctrl+C to stop)`); };
ws.onmessage = ({ data }) => {
  const { method, params: p } = JSON.parse(data);
  if (method === 'Network.requestWillBeSent') console.log(`→ ${p.request.method} ${p.request.url}`);
  if (method === 'Network.responseReceived') console.log(`← ${p.response.status} ${p.response.mimeType ?? ''} (${p.type})`);
  if (method === 'Network.loadingFailed') console.log(`✗ ${p.errorText}`);
};
