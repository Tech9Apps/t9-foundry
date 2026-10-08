# Tracker Adapters

One small, tested interface between the harness and your ticket system. Instead of every command carrying its own
copy of "how to call ClickUp / Azure / GitHub" as prose, they call this:

```bash
node scripts/tracker/cli.js fetch --input '{"id":"86a00001"}'
```

Same operations, same JSON in and out, same error shape — whichever tracker is configured. That makes ticket I/O
**testable** (every adapter runs against an in-process mock in CI), **safe to retry** (idempotency keys), and
**usable unattended** (token auth, hard timeouts, structured errors).

> **Status.** Adapters exist for **GitHub, ClickUp and Azure DevOps**. Jira (needs a headless auth decision),
> GitLab and Bitbucket are next. The markdown commands (`fetch-ticket.md`, `post-tests.md`, `file-bug.md`) have **not
> been rewired to call the CLI yet** — that is the next step, and it changes pipeline behavior, so it ships separately.

## Operations

| Op | Input | Returns |
|----|-------|---------|
| `fetch` | `{ id }` | a normalized **ticket** — [`schemas/tracker-ticket.schema.json`](../schemas/tracker-ticket.schema.json) |
| `search` | `{ query, kind?: any\|bug\|test, limit? }` | `{ items: [{ id, title, url, status }] }` |
| `create-test` | `{ parentId, tcId, title, description?, priority?, steps?: [{action, expected}], idempotencyKey? }` | `{ id, url, deduplicated, repaired? }` |
| `link` | `{ childId, parentId }` | `{ linked, method: native\|reference-in-body }` |
| `comment` | `{ id, body, idempotencyKey? }` | `{ id, url?, deduplicated }` |
| `create-bug` | `{ title, body, priority?, labels?, idempotencyKey? }` | `{ id, url, deduplicated }` |

Input shapes: [`schemas/tracker-inputs.schema.json`](../schemas/tracker-inputs.schema.json). Priorities are
`High` / `Medium` / `Low`; each adapter maps them to its tracker's native scale.

## CLI

```bash
node scripts/tracker/cli.js <op> --input '<json>'             # or --input-file <path>, or --stdin
                              [--source github|clickup|azure]  # default: ticketSource.type from qa-config.json
                              [--config <path>]                # default: $CLAUDE_PROJECT_DIR/qa-config.json, ./, ../
                              [--base-url <url>]               # mock servers / GitHub Enterprise (also $QA_TRACKER_BASE_URL)
                              [--timeout-ms <n>]               # default 15000
```

Output is one JSON document on stdout — `{ "ok": true, "data": … }` or `{ "ok": false, "error": { code, message, retriable, … } }`.
Exit codes: **0** success · **1** the operation failed (read `error.code`) · **2** bad invocation (message on stderr).

Credentials come from environment variables named in the config (`GITHUB_TOKEN`, `CLICKUP_TOKEN`, `AZURE_DEVOPS_PAT`,
or `ticketSource.<type>.tokenEnvVar`) and are **never printed** — not in output, errors or URLs. stdin is only read
with `--stdin`, so an inherited pipe can never hang an unattended run.

## Errors

Every failure is normalized, so a caller never parses tracker-specific messages:

| `code` | Meaning | `retriable` |
|--------|---------|:-----------:|
| `NOT_FOUND` | no such item (or not visible to this token) | no |
| `UNAUTHENTICATED` / `FORBIDDEN` | bad credentials / not allowed | no |
| `VALIDATION` | rejected as invalid — also bad input, caught **before any request** | no |
| `CONFIG` | missing setting or env var — caught **before any request** | no |
| `RATE_LIMITED` / `TIMEOUT` / `NETWORK` / `UPSTREAM_ERROR` | transient | **yes** |

## Retries and idempotency

- **Reads retry** (2 retries, exponential backoff) on transient errors. A read is a GET, or a call an adapter marks
  `idempotent` (Azure's WIQL query is a POST but changes nothing).
- **Writes never retry automatically.** A POST that timed out may have succeeded; repeating it blindly is how
  duplicate tickets get created. A failed write returns `retriable: true` and leaves the decision to the caller.
- **`idempotencyKey` makes a manual retry safe.** Creates — and comments, so a re-run doesn't post its summary twice —
  embed a marker for the key (a body line, or a tag on Azure work items) and look for it first: a retry returns the original with `deduplicated: true`. This holds even when the
  first attempt *succeeded but the response was lost* — covered by a test that injects exactly that failure.
- **Multi-call creates can fail half-way** (ClickUp: task → checklist → steps). The error carries
  `details.partial.id`, and a retry **completes** the half-built item (`repaired: true`) rather than accepting it as
  done.
- `link` is idempotent (linking twice is fine). GitHub has no link API: the parent is referenced in the issue body
  at creation, so `link` reports `method: "reference-in-body"`.

## Per-tracker notes

| | GitHub | ClickUp | Azure DevOps |
|---|---|---|---|
| Config (`ticketSource.<type>`) | `repo`, `testLabelName`, `tokenEnvVar`, `apiBaseUrl` | `listId`, `tokenEnvVar`, `assignToSelf`, `apiBaseUrl` | `organization`, `project`, `host`, `tokenEnvVar` |
| Auth | `Bearer <token>` (`GITHUB_TOKEN` / `GH_TOKEN`) | raw token | Basic, empty user + PAT |
| Test case is | an issue labelled `test-case` + the parent id | a task + a "Test Steps" checklist | a `Test Case` work item with steps XML |
| Bug is | issue titled `[BUG] …`, label `bug` | task named `[BUG] …` | a `Bug` work item |
| Idempotency marker | `qa-harness-key:<key>` line in the body | same, in the description | tag `qa-key-<key>` |
| Not yet | — | — | assignee lookup (needs a second host) |

## See it work

`bash demo/run-demo.sh --tracker` (or `node demo/tracker-demo.js --tracker clickup`) pushes the demo's tickets, 26 test
cases, bugs and results through this CLI into an in-memory tracker, re-runs it to show nothing duplicates, and
replays a dropped connection mid-write. Same flow for `github`, `clickup` and `azure`.

## Testing

```bash
node --test tests/tracker/*.test.js     # 112 tests in well under a second, no network, no ports
bats tests/tracker.bats                 # the same, plus guardrails (no deps, no sockets, schemas valid)
```

- **One contract suite, every adapter** — [`tests/tracker/contract-suite.js`](../tests/tracker/contract-suite.js)
  (22 behaviors) runs against each adapter's mock: normalization, NOT_FOUND vs UNAUTHENTICATED, retry rules,
  timeouts, rate limits, idempotency (including the lost-response case), validation-before-request.
- **Mocks are `fetch` functions**, not servers ([`tests/mocks/tracker-mock/`](../tests/mocks/tracker-mock/)). They
  record every call and accept fault injection — `mock.inject({ method, match, status | networkError | delayMs, times,
  afterCommit })` — where `afterCommit` runs the write *then* fails the response.
- The contract tests were mutation-checked: re-enabling write retries, ignoring keys, or mis-mapping 404 each fail them.

**Mock fidelity.** The mocks model the endpoints the adapters use, with documented approximations (e.g. the Azure mock
understands only `CONTAINS` and work-item-type clauses in WIQL). They prove the adapters' logic, not that a real
tracker agrees — a real-tracker smoke test against a sandbox project remains worthwhile before relying on this
unattended.

## Adding an adapter

1. `scripts/tracker/adapters/<name>.js` exporting `create({ settings, env, fetch, baseUrl, timeoutMs, retryDelayMs })`
   that returns `{ source, fetchTicket, search, findByKey, createTest, link, comment, createBug }` (+ optional
   `completeTest` for multi-call creates). Fail fast with `CONFIG` on missing settings or token; use `lib/http.js`
   for every request.
2. Register it in `adapters/index.js`.
3. `tests/mocks/tracker-mock/<name>.js` — an in-process mock with the small interface the contract suite uses
   (`seedTicket`, `createdItems`, `commentsOn`, `paths`, `missingId`, `tokenEnv`, `settings`, `baseUrl`, `token`).
4. `tests/tracker/<name>.test.js` — `runContractSuite('<name>', () => createMock())` plus adapter-specific tests.
5. `bats tests/tracker.bats` fails if an adapter is registered without a test file.
