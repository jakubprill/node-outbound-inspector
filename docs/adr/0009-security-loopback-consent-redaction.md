---
status: accepted
date: 2026-11-19
---

# 0009. Security: loopback only, instrumentation with consent, redaction at ingestion

## Context

The Node inspector gives full control over a process. The prototype connects to every inspector in the port range, injects code into it without asking and returns request and response headers to the agent unchanged, including `Authorization`, `Cookie` and `Set-Cookie`. The tool result goes to the model provider, that is, off the developer's machine. Service response bodies may also contain text the model will take as an instruction.

## Decision

1. **Loopback only.** The collector connects only to `127.0.0.1`. The launcher always passes `--inspect=127.0.0.1:<port>`. An inspector listening on another address is reported in `inspector_status`.
2. **Instrumentation with consent.** The hook runs only in processes where the developer loaded it (`outbound run` or `--import`). Processes found by port are only observed by default; injection needs `OUTBOUND_INJECT=1`. Kill switch: `OUTBOUND_HOOK=0`.
3. **Minimal CDP footprint.** We use `Network.*`, `Runtime.evaluate` with read-only expressions and `Runtime.addBinding`. We never enable the `Debugger` or `Runtime` domain.
4. **Redaction at ingestion.** Values of authentication headers and of headers, URL parameters and JSON fields matching the name pattern are replaced with a description (scheme, length, six characters of a SHA-256 digest) before they reach the store. On by default; off only explicitly (`OUTBOUND_REDACT=0`) and with a warning in the status.
5. **Bodies as data.** Bodies are truncated, returned in a clearly named field, and the server's `instructions` tell the model to treat them as data. The team picks the body mode (`eager`, `lazy`, `off`).
6. **No execution of code from the repository.** Configuration is JSON. The registry has modes 0700 and 0600. The MCP client runs the tool by path, not through `npx` with a short name.

## Alternatives considered

- **Redaction only in the tool response.** The secret stays in the collector's memory and leaks through every new output path (export, a new tool, a log). Rejected.
- **Hiding the value completely** (`***`). The agent then cannot tell whether two requests carried the same token, a common question with 401 errors. A six-character digest allows that and does not reveal a high-entropy secret.
- **Injection on by default** (the current state). Convenient, but the collector then runs code in every process that happens to listen on a scanned port.
- **An access token for the collector.** Unnecessary as long as the collector listens on no socket (stdio).

## Implementation (2026-11-20, after the security review)

The review ([docs/security-audit-2026-11-20.md](../security-audit-2026-11-20.md)) showed that points 1–2 and 4 were not implemented as described. State after the fixes:

1. **Loopback:** a target is accepted only with a WebSocket address on the scanned port of 127.0.0.1/localhost (collector and hub). The launcher blocks an inspector outside loopback (`OUTBOUND_ALLOW_REMOTE_INSPECT=1` is the exception). A process listening on another address is not reported in `inspector_status`.
2. **Consent:** instead of `OUTBOUND_INJECT` — process consent: `OUTBOUND_INSPECT=1` (set by `outbound-next`) or the `--experimental-network-inspection` flag, same user only. Without consent: no modifying expressions, patches or `Network.enable`; identity is only read. Default ports 9230–9249. `OUTBOUND_HOOK` does not exist; `PAGE_CORRELATION=0` turns correlation off.
3. **CDP footprint:** besides read-only expressions, the collector installs the hook and the nodejs/node#66551 patch (`Runtime.evaluate`). `Runtime.addBinding` is not used yet (M4).
4. **Redaction:** as in README, "Security model" section; HMAC-SHA256 instead of SHA-256 (below).
5. **Untrusted data:** marked in the descriptions of all tools and in `instructions`, names and control characters cleaned.

## Consequences

- **Implementation note (M2):** instead of plain SHA-256, the digest is HMAC-SHA256 with a key drawn when the collector starts. Comparing secrets within a session works the same, and short secrets (e.g. PINs, simple passwords) cannot be guessed by computing digests from a dictionary.
- Redaction is irreversible within a session: to see a value, start the collector with redaction off.
- Compatibility mode (processes without the launcher) loses page assignment by default. This is a behavior change against the prototype, described in the changelog.
- Redaction of JSON fields in bodies works by key names, so it will not catch personal data under a neutral name. The final protection is body mode `off`.
- The tool stays for local development only.
