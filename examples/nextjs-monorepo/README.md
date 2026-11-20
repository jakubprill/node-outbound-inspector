# Example: a monorepo with two Next.js apps

Two apps (`@acme/web`, `@acme/admin`) started in parallel, like `turbo dev` / npm workspaces. Each has its own inspector port.

| App | HTTP port | Inspector port | Pages |
|---|---|---|---|
| `@acme/web` | 3101 | 9231 | `/seq` (3 × `await`, waterfall), `/err` (the integration returns 500) |
| `@acme/admin` | 3102 | 9241 | `/par` (`Promise.all`), `/seq` (2 × `await`) |

## Running
```bash
npm install
npm run mock          # terminal 1 — mock services on :4001 (?ms=delay, ?status=code)
npm run dev:inspect   # terminal 2 — both apps with network inspection
npm run demo          # terminal 3 — MCP server + traffic on all pages + analysis
```

`npm install` links the tool from this repository (`"node-outbound-inspector": "file:../.."` in `devDependencies`), so the `outbound-next` command is available in the app scripts:
```jsonc
// apps/web/package.json
"dev:inspect": "outbound-next dev --port 3101 --inspect=9231"
```
In a real monorepo, instead of `file:../..` there is a git dependency pinned to a tag (`github:jakubprill/node-outbound-inspector#<tag>`).

### Windows
The apps' `dev:inspect` scripts work in `cmd.exe` and PowerShell. The aggregate scripts at the root (`dev`, `dev:inspect` with `&` and `wait`, `demo` with `APPS=…`) need a POSIX shell (e.g. Git Bash). In PowerShell:
```powershell
npm run dev:inspect -w @acme/web     # terminal 2
npm run dev:inspect -w @acme/admin   # terminal 3
$env:APPS='[{"app":"web","url":"http://localhost:3101","pages":["/seq","/err"]},{"app":"admin","url":"http://localhost:3102","pages":["/par","/seq"]}]'
node ../../scripts/mcp-demo.mjs      # terminal 4 (PowerShell)
```
In a turbo monorepo, `turbo run dev:inspect` provides the parallel start.

Expected `npm run demo` output (approximate values):
```
[web]   GET /seq  3 req., ~470 ms → SEQUENTIAL (waterfall) | potential saving ~310 ms
[web]   GET /err  1 req.          → error: POST …/payments → 500
[admin] GET /par  3 req., ~160 ms → PARALLEL
[admin] GET /seq  2 req., ~320 ms → SEQUENTIAL (waterfall) | potential saving ~160 ms
```

Viewing in Chrome: run `outbound-hub` and open `chrome://inspect` (the apps show up by name), or without the hub: `chrome://inspect` → *Configure…* → add `localhost:9231` and `localhost:9241` → **inspect** next to the app → **Network** tab.

## Things to note
- If both apps had a bare `--inspect` (default port 9229), the second would only print `Starting inspector on 127.0.0.1:9229 failed: address already in use` and keep running without an inspector. That is why each has its own port.
- `outbound-next` finds `next` through `require.resolve('next/dist/bin/next')` from the app directory, wherever the package manager put it (npm/pnpm/yarn/bun). The old `$(node -p "require.resolve(…)")` script form needs a POSIX shell, so it does not work in `cmd.exe`, where npm and pnpm run scripts on Windows.
