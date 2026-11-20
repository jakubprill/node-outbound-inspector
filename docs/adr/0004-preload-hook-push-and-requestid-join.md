---
status: proposed
date: 2026-11-19
---

# 0004. Hook: loaded with `--import`, pushes messages through a CDP binding, joined by `requestId`

## Context

The prototype injects correlation code with `Runtime.evaluate` into every process it finds, keeps entries in a buffer in the app process and drains it every second with `log.splice(0)`. An entry is matched to a request by method, URL and time.

Three problems:

- with two collectors only one gets the entries (measured: 18/18 and 0/18);
- the code enters the process without its owner's consent and only after attaching;
- matching by URL and time is guesswork when two places in the code call the same address at the same time.

Findings from experiments: `Runtime.addBinding` works in the Node inspector without `Runtime.enable` and delivers the event only to the session that created the binding. The inspector stores the `requestId` on the request object under `Symbol(kInspectorRequestId)`; the hook sees it in a microtask after the `create` event.

## Decision

1. **Delivery:** the developer loads the hook, via `outbound run` or `--import node-outbound-inspector/register`. Injection with `Runtime.evaluate` stays for processes found by port and must be enabled (`OUTBOUND_INJECT=1`). Both modes install the same function.
2. **Transport:** the hook buffers nothing. Every collector creates its own binding (`Runtime.addBinding`) and registers its name with the hook; the hook calls all registered bindings with one JSON message.
3. **Join:** the message carries the inspector's `requestId` read from the request object. Matching by method, URL and time stays as a second path when the id is missing.
4. **Version:** the hook protocol has a number (`v: 1`); the collector rejects unknown ones.

## Alternatives considered

- **Polling with a cursor instead of `splice`.** Fixes the many-receivers problem, but keeps a buffer in the app process, a one-second delay and polling of idle apps.
- **Our own socket from the hook to the collector** (Unix socket, HTTP). CDP-independent, but an extra channel with its own addressing and access control, while the CDP connection exists anyway.
- **A correlation header added to outbound requests.** The join would be certain, but the tool would change traffic to integrations.
- **Matching by URL and time only.** Works in tests, but cannot tell apart two places in the code calling the same address at the same moment.

## Consequences

- Dependence on a Node internal detail (the symbol name). There is a compatibility probe and a fallback path.
- The collector gets only what happened after it attached. This is consistent with `Network.*` events, which Node does not replay either.
- `installHook` must stay a self-contained function without imports, so it can be sent as text.
- Polling every second and `pollAll()` before every tool call go away. Without `Runtime.addBinding` there is no page assignment; we do not keep a fallback for that.
