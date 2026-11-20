---
status: accepted
date: 2026-11-19
---

# 0008. Agent contract: five tools, a summary by default, a hard character budget

## Context

An MCP tool result goes into the model's context, so its size is a cost. Measured on the prototype: `analyze_server_timeline` for 132 requests returns 88,072 characters (36% of it JSON indentation), and the size grows linearly with the buffer up to 5000 requests. Claude Code warns from 10k tokens and truncates results at 25k by default. The definitions of the five tools alone are 2659 characters.

The result is also a contract: tests, the demo script and agent habits rely on it.

## Decision

1. **Five tools, the same names.** New needs are served by parameters (`page_request_id`, `tag`, `status`, `detail`, `settle_ms`, `body_offset`), not new tools.
2. **A summary by default.** `analyze_server_timeline` returns today's fields without `timeline`, for the 20 newest page requests. The full timeline is available with `page_request_id` or `detail: "full"`.
3. **Budget.** The goal is 6000 characters in a typical result, the hard limit is 20,000. A truncated result always contains `truncated: true` and a hint on how to narrow the query.
4. **Form.** JSON without indentation and without empty fields; URL parameters shortened in lists; paging with a cursor over the increasing `id`.
5. **Additive changes only** within a major version: existing fields do not disappear or change meaning. Verbal descriptions (verdicts) get machine codes next to them.
6. **A page-request-oriented model.** The basic unit of analysis is a page request with its list of requests, not a flat list of requests.

## Alternatives considered

- **More specialized tools** (`list_page_requests`, `wait_for_idle`, `get_body`). Clearer one by one, but each costs context in every session and multiplies the model's decisions.
- **Text or tables instead of JSON.** Fewer characters, but harder to test and less unambiguous.
- **Relying on client limits.** The client truncates the result anywhere, and the model does not know what it did not see.
- **MCP resources for large bodies.** Uneven client support; paging in a tool works everywhere.

## Consequences

- The agent usually needs two calls: the summary, then details of one page or one request.
- Result snapshots (`test/golden/`) are part of the tests; every change to them needs a changelog entry.
- Changing the default of `analyze_server_timeline` is a deliberate behavior change in M6. Fields used by today's e2e test stay.
- `settle_ms` removes the "analysis before requests finish" race, which today shows up as missing in-flight requests.
