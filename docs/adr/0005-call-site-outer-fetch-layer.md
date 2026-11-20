---
status: proposed
date: 2026-11-19
---

# 0005. The call site is captured by an outer `fetch` layer, not the initiator stack

Additional status: a decision based on simulation. Must be confirmed on real Next.js in M5 (the probe in appendix B of the architecture document).

## Context

In Next.js the initiator stack from the CDP event ends in framework internals, because Next wraps `fetch` in an async function. The agent gets the URL and the page, but not the file and line.

Findings from experiments (Node 22 and 24, simulated wrapper):

- the CDP initiator stack has synchronous frames only; the Debugger domain and `setAsyncCallStackDepth` add nothing;
- the `undici:request:create` event is published synchronously inside `fetch`, under 27–33 undici frames, so with the default limit of 10 frames app code is never visible;
- `new Error().stack` in the subscriber after a wrapper with `await` gives `async` frames only when at least two microtasks pass between the user call and the native `fetch`. With exactly one there is no user frame at all. The `async` frame points at the `await`, not the call, and in `Promise.all` it is shared by all requests.

## Decision

The hook turns `globalThis.fetch` into an **accessor** whose read returns a **Proxy** of the current function. The `apply` trap is called synchronously by app code: it captures the stack (`Error.captureStackTrace`, raw `CallSite` objects, a limit of 60 frames) and runs the real call in an `AsyncLocalStorage` context. The `undici:request:create` subscriber reads the stack from the context.

A write to `globalThis.fetch` (Next's patch, other libraries) only replaces the function underneath, so our layer always stays outermost. The Proxy passes properties through, including the marker Next uses to recognize its own patch.

Degradation order: outer layer → `async` frames from the subscriber → CDP initiator stack → the page request only. The result says which path produced it (`origin.via`).

## Alternatives considered

- **The CDP initiator stack.** Synchronous frames only. Enough in plain Node, not in Next.
- **The subscriber alone with a raised frame limit.** No global patch, but depends on the number of microtasks inside Next and is less precise. Kept as a fallback.
- **Replacing `fetch` before Next as the innermost layer.** The same call moment as the subscriber, so the same limits, plus a patch.
- **The Debugger domain.** Does not extend stacks and, when enabled, can stop the process on a `debugger` statement.
- **A wrapper in app code.** Reliable, but needs changes and discipline in the apps.

## Consequences

- The exact line and column of the call, also for every `fetch` in `Promise.all`. Cost: 10–14 µs per call.
- The `globalThis.fetch` descriptor is an accessor. Typical uses work (13 checks), but code inspecting the descriptor will see a difference.
- Does not cover `node:http`. There the hook captures the synchronous stack when the request is created, which helps only when a library calls `http.request` synchronously from user code.
- Depends on Next's behavior (recognizing its own patch, reaching `fetch` through the global). If the probe fails on real Next, only the fallback ships and this ADR gets a successor.
- The `OUTBOUND_HOOK=0` switch removes the hook without changing scripts.
