#!/usr/bin/env node
// Demo: zachowuje się jak agent — uruchamia serwer MCP, generuje ruch na stronach aplikacji
// i wypisuje analizę. Użycie (przykład dla examples/nextjs-monorepo):
//   APPS='[{"app":"@acme/web","url":"http://localhost:3101","pages":["/seq","/err"]},
//          {"app":"@acme/admin","url":"http://localhost:3102","pages":["/par","/seq"]}]' node scripts/mcp-demo.mjs
import { startMcp } from '../test/helpers/mcp-client.mjs';

const APPS = JSON.parse(process.env.APPS || '[]');
if (!APPS.length) { console.error('Set APPS (see the comment at the top of this file).'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hitAll = () => Promise.all(APPS.flatMap(a => a.pages.map(p => fetch(a.url + p).catch(e => console.log('ERROR', a.url + p, e.message)))));

const mcp = await startMcp();
console.log(`### ${mcp.init.serverInfo.name} ${mcp.init.serverInfo.version}`);
const status = await mcp.waitForApps(APPS.length, 30000);
for (const a of status.apps) console.log(`  connected ${a.app} (port ${a.port}, pid ${a.pid}) ${a.cwd}`);

await hitAll(); await sleep(800);              // rozgrzewka (kompilacja stron w trybie dev)
await mcp.call('clear_server_requests');
await hitAll(); await sleep(1500);             // pomiar: wszystkie strony wszystkich aplikacji naraz

console.log('\n### Outbound requests');
for (const r of (await mcp.call('list_server_requests', { limit: 200 })).requests)
  console.log(`  #${r.id} ${r.app.padEnd(14)} ${String(r.page).padEnd(12)} → ${r.method} ${r.url} ${r.status} ${r.duration_ms} ms`);

console.log('\n### Analysis');
for (const [app, x] of Object.entries(await mcp.call('analyze_server_timeline'))) {
  if (!x.pages) continue;
  console.log(`  [${app}] requests: ${x.total_requests}, errors: ${x.errors.length}`);
  for (const p of x.pages) {
    console.log(`    ${p.page.padEnd(12)} ${p.requests} req., ${p.wall_ms} ms → ${p.verdict_code.toUpperCase()}${p.potential_saving_ms ? ` | potential saving ${p.potential_saving_ms} ms` : ''}`);
  }
  for (const e of x.errors) console.log(`    error: ${e.method} ${e.url} → ${e.status} (page ${e.page})`);
}
mcp.close();
