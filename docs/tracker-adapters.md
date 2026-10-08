# Tracker Adapters

One small, tested interface between the harness and your ticket system. Instead of every command carrying its own
copy of "how to call ClickUp / Azure / GitHub" as prose, they call this:

```bash
node scripts/tracker/cli.js fetch --input '{"id":"86a00001"}'
```

Same operations, same JSON in and out, same error shape — whichever tracker is configured. That makes ticket I/O
**testable** (every adapter runs against an in-process mock in CI), **safe to retry** (idempotency keys), and
**usable unattended** (token auth, hard timeouts, structured errors).

> **Status.** Adapters exist for **GitHub, ClickUp, Azure DevOps, GitLab and Bitbucket**, and the pipeline commands use
> them: `fetch-ticket.md`, `post-tests.md`, `file-bug.md` and the results step of the automation agent call the CLIs
> below for those five sources. **Jira** deliberately has no adapter yet — it stays on the Atlassian MCP
> (interactive only) until the headless-auth approach is decided — and `none` has no tracker.

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

## Posting test cases in bulk: `post-tests.js`

```bash
node scripts/tracker/post-tests.js --parent <ticket-id>          # reads tests/cases/<id>.md
                                   [--only TC-003,TC-007]        # retry just these
                                   [--dry-run]                   # print the plan; no credentials, no requests
```

Parses the harness's test-case markdown, **checks the parent ticket exists and the credentials work before creating
anything** (so a typo'd id cannot create orphaned test cases), then creates each case (key `<parent>-<TC-id>`), links
it, and records every outcome in `tests/cases/.ticket-context/<id>-test-keys.json`
([`schemas/test-keys.schema.json`](../schemas/test-keys.schema.json)) after each case.

| Situation | Behavior |
|---|---|
| Re-run | existing cases are found by key, not duplicated; created-but-unlinked cases get linked; half-built ones are completed |
| One case fails (timeout, 5xx, validation) | recorded as `failed` with the error; the others continue |
| A failure that would hit every remaining case (credentials revoked, rate limit) | the run stops; the rest are `skipped`; re-run later resumes |
| Exit code | `0` all created/found **and** linked · `1` anything failed/skipped/unlinked, or it could not start · `2` bad invocation |

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

| | GitHub | ClickUp | Azure DevOps | GitLab | Bitbucket |
|---|---|---|---|---|---|
| Config (`ticketSource.<type>`) | `repo`, `testLabelName`, `tokenEnvVar`, `apiBaseUrl` | `listId`, `tokenEnvVar`, `assignToSelf`, `apiBaseUrl` | `organization`, `project`, `host`, `tokenEnvVar` | `projectId`, `host`, `tokenEnvVar`, `testLabelName` | `workspace`, `repo`, `username`, `tokenEnvVar` |
| Auth | `Bearer <token>` (`GITHUB_TOKEN` / `GH_TOKEN`) | raw token | Basic, empty user + PAT | `PRIVATE-TOKEN` header | Basic `username:app_password` |
| Test case is | an issue labelled `test-case` + the parent id | a task + a "Test Steps" checklist | a `Test Case` work item with steps XML | an issue labelled `test-case` + parent number + `priority:<P>` | a `task` titled `TC-…:` (no labels in Bitbucket) |
| Bug is | issue titled `[BUG] …`, label `bug` | task named `[BUG] …` | a `Bug` work item | issue titled `[BUG] …`, label `bug` | a `bug`-kind issue |
| Idempotency marker | `qa-harness-key:<key>` line in the body | same, in the description | tag `qa-key-<key>` | marker line in the description | marker line in the body |
| Key lookup | **lists** issues by label (never search — GitHub's search index lags) | lists the configured list | WIQL query on the tag | lists by label | lists newest-first by kind |
| Link | `reference-in-body` | native | native relation | native "relates to" | `reference-in-body` |
| Needs | — | — | the process must have a `Test Case` type (Basic does not); assignee lookup not done (needs a second host) | — | the repo's **issue tracker enabled**, and the account username |

## Keeping the prose honest

The command prompts tell a model exactly how to call these scripts, so
[`tests/helpers/commands-drift-check.js`](../tests/helpers/commands-drift-check.js) (run by
`tests/commands-adapter-drift.bats`) checks every claim they make against the code: each `cli.js <op>` is a real
operation, each `--flag` exists, each example JSON validates against the schemas, every registered adapter is named in
each command's adapter section, and no direct `curl` / `gh issue` / vendor-API call has crept back in.

## Evals

[`evals/`](../evals/) runs the demo's three tickets — with golden counts verified independently of the code — through
the real `fetch` (+ context file), `post-tests`, `create-bug` and `comment` against every tracker mock, plus four
failure drills (transient failure, lost response, credentials revoked mid-run, wrong parent id). 145 checks (3 scenarios × 5 trackers);
`node evals/run.js [--tracker T] [--scenario S] [--json]`. Deterministic by design: model-in-the-loop evals can reuse
the same scenarios and goldens later.

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
  (23 behaviors) runs against each adapter's mock: normalization, NOT_FOUND vs UNAUTHENTICATED, retry rules,
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
