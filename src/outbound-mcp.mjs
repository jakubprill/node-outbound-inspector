#!/usr/bin/env node
// outbound-mcp: serwer MCP (stdio) dający agentowi wgląd w ruch sieciowy procesów Node
// uruchomionych z `--inspect=<port> --experimental-network-inspection` — także kilku naraz
// (np. monorepo z kilkoma aplikacjami Next.js uruchamianymi równolegle).
// Bez zależności: MCP (JSON-RPC 2.0 po stdio) + klient CDP po WebSocket. Wymaga Node >= 22.
// Repozytorium: https://github.com/jakubprill/node-outbound-inspector
//
// Podłączenie do agenta:  claude mcp add outbound -- node /ścieżka/src/outbound-mcp.mjs
//
// Zmienne środowiskowe:
//   INSPECTOR_PORTS  porty/zakresy inspektorów do skanowania, np. "9229-9249" (domyślnie) lub "9231,9241"
//   APP_NAMES        opcjonalne nazwy aplikacji po porcie, np. "9231=web,9241=admin"
//                    (domyślnie: npm_package_name procesu → name z package.json w cwd → nazwa katalogu)
//   IGNORE_HOSTS     hosty pomijane (domyślnie registry.npmjs.org)
//   PAGE_CORRELATION 0 = bez wstrzykiwania kodu korelującego zapytania z żądaniem strony
//   MAX_REQUESTS     rozmiar bufora (domyślnie 5000)
//
// Budowa: docs/architecture.md (moduły w src/: config, discovery, session, cdp-client, ingest,
// store, correlate, frames, analyze/*, hook/*, mcp/*; korzeń kompozycji: collector.mjs).

import { loadConfig } from './config.mjs';
import { createCollector } from './collector.mjs';
import { createTools } from './mcp/tools.mjs';
import { createMcpServer, serveStdio } from './mcp/server.mjs';

const SERVER_INFO = { name: 'node-outbound-inspector', version: '0.3.0' };
const log = msg => process.stderr.write('[outbound-mcp] ' + msg + '\n');

const config = loadConfig({ env: process.env });
const collector = createCollector(config, { log });
const server = createMcpServer({ info: SERVER_INFO, tools: createTools(collector), beforeCall: collector.pollAll });

collector.start();
serveStdio(server, { stdin: process.stdin, stdout: process.stdout, onEnd: () => process.exit(0) });
log(`start, skanuję porty ${config.ports[0]}-${config.ports.at(-1)}`);
