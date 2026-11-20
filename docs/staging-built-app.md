# Built app and staging — analysis (2026-11-20)

Question from the team: can node-outbound-inspector run on a built Next.js app in the staging
environment, so backend developers can see the Next server's outbound traffic (requests to their
services)? Does a "control" build with the flag plus attaching the inspector make sense?

## Short answer

Technically yes, but on a **shared** staging it is the wrong way. It fits ad-hoc debugging of a
**dedicated** instance by one person. The right tool for a permanent view of staging traffic is
**OpenTelemetry**.

## How to do it technically

Next.js 16.2 added `--inspect` for `next start`, so the inspector can be opened on the production server.

```bash
# our tool (network flag + consent OUTBOUND_INSPECT=1)
outbound-next start --port 3000 --inspect=9230

# standalone build
OUTBOUND_INSPECT=1 node --experimental-network-inspection --inspect=127.0.0.1:9230 .next/standalone/server.js
```

Access from the developer's machine only through a tunnel; the inspector listens on 127.0.0.1 only:

```bash
ssh -L 9230:127.0.0.1:9230 staging-host      # or: kubectl port-forward pod/<pod> 9230:9230
outbound-hub                                 # locally: chrome://inspect or MCP (INSPECTOR_PORTS=9230)
```

Status: not yet verified on a built app (`next build` + `outbound-next start` test still to do).

## Why not on a shared staging

| Problem | Effect |
|---|---|
| An open inspector port = remote code execution | Whoever reaches the port has full control over the process. Next's docs suggest `--inspect=0.0.0.0` for Docker — on a networked server that is an open door. `outbound-next` blocks non-loopback hosts (unless `OUTBOUND_ALLOW_REMOTE_INSPECT=1`). |
| Traffic of all staging users | Tokens and data of all testers are visible; through MCP they go to the model provider. Redaction is best effort. |
| Node bug nodejs/node#66551 | Chrome DevTools alone (without our collector) can break requests that use `setEncoding` — affecting everyone using staging. Our collector patches it only while attached. |
| `--experimental-network-inspection` is experimental | Buffers response bodies in the process memory. |
| Several instances behind a load balancer | Only one instance is visible. |
| Minified code | Call stacks ("place in code") are hard to read without source maps. |

## Recommendation

1. **Staging for backend → OpenTelemetry.** `instrumentation.ts` + `@vercel/otel`; every Next server request
   is a span (Jaeger / Tempo / Grafana). The `traceparent` header links it to spans of the backend
   services, so the whole chain is visible: page → Next → service. Covers all instances,
   data stays in the company, no code-execution port, always on.
2. **node-outbound-inspector → local development.**
3. **A compromise for ad-hoc debugging:** a dedicated staging instance, started with the flag on demand,
   inspector on 127.0.0.1 only, tunnel access for one person, then switched off.

## To do (when we come back to this)

- Test `outbound-next start --inspect=9230` on a built app (Next 16.4, test monorepo).
- A "Staging / built app" section in README (en/pl) and a note in llms.txt.
- Possibly a draft OpenTelemetry configuration for the team's apps.
