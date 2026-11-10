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
>
> **Verified against mocks, not yet against real trackers.** Every adapter passes the same contract suite and its own
> tests against an in-process mock, and the mocks were built from each tracker's documented API. Nobody has yet run
> them against a live GitHub, ClickUp, Azure DevOps, GitLab or Bitbucket. See [Verification status](#verification-status)
> and run the [smoke test](#real-tracker-smoke-test) before relying on one unattended.

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

Those shapes are enforced, not just described: every input is checked against them (`VALIDATION`, before any request), and a test holds the code and
the schema to the same answer for every case. In particular an id is letters, digits, `_` and `-` (at most 64) or a number, because it is placed in a URL;
`limit` is a whole number from 1 to 100; `kind` is `any`, `bug` or `test`; `tcId` looks like `TC-001`. On GitHub a colon in a search query is dropped so
the text cannot carry a qualifier such as `repo:other/private`.

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
or `ticketSource.<type>.tokenEnvVar`) and are **never printed** — not in output, errors or URLs. Upstream error text is
scrubbed of the token (raw, and in the `Authorization` header forms) before it is quoted, so a tracker that echoes a
request back cannot leak one.

**Where a token may be sent.** The base URL (from `--base-url`, `$QA_TRACKER_BASE_URL` or the config) is checked before
the first request: `https` only, with plain `http` allowed solely for loopback (`localhost`, `127.x.x.x`, `[::1]`,
`*.localhost`, i.e. local mocks); no embedded `user:pass@`, no query string or fragment. The host must also be one the token belongs to: the tracker's own
(`api.github.com`, `gitlab.com`, `dev.azure.com`, `api.clickup.com`, `api.bitbucket.org`), a reserved test host (`*.test`, loopback —
what the mocks use), or one **you** allow in your own shell — `export QA_TRACKER_ALLOW_HOSTS=ghe.corp.example.com,*.git.corp.example.com`
(exact names, or `*.suffix` with at least two labels). That is the only place it can be set: `qa-config.json` (including a committed
profile) and a model-supplied `--base-url` can name a host, but cannot add one to the list, so a config cannot aim `Authorization: Bearer <token>`
at a server of its choosing. GitHub Enterprise, self-hosted GitLab and Azure DevOps Server therefore need that one line. A `tokenEnvVar` the
config names is the only variable read (GitHub no longer falls back to `GITHUB_TOKEN` / `GH_TOKEN` when it is unset: it stops with `CONFIG`).
**Redirects are never followed**
— a `3xx` is a `CONFIG` error naming where it pointed — so the credentials in a request cannot be forwarded elsewhere. stdin is only read
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
| `VALIDATION` | rejected as invalid — also bad input, caught **before any request** — and **every 4xx the tracker answers with that has no other meaning here** (405, 410 "issues are disabled", 413, 451 …): repeating the same request cannot change it | no |
| `CONFIG` | missing setting or env var — caught **before any request** | no |
| `RATE_LIMITED` / `TIMEOUT` / `NETWORK` / `UPSTREAM_ERROR` | transient (429 and 425, 408, a dropped connection, a 5xx) | **yes** |

## Retries and idempotency

- **Reads retry** (2 retries, exponential backoff) on transient errors. A read is a GET, or a call an adapter marks
  `idempotent` (Azure's WIQL query is a POST but changes nothing).
- **Writes never retry automatically.** A POST that timed out may have succeeded; repeating it blindly is how
  duplicate tickets get created. A failed write returns `retriable: true` and leaves the decision to the caller.
- **`idempotencyKey` makes a manual retry safe.** Creates — and comments, so a re-run doesn't post its summary twice —
  embed a marker for the key (a body line, or a tag on Azure work items) and look for it first: a retry returns the original with `deduplicated: true`. The match is on the **whole key**: `bug-login` is not found inside `bug-login-2`, so a key that is a prefix of another cannot adopt that other item. This holds even when the
  first attempt *succeeded but the response was lost* — covered by a test that injects exactly that failure.
- **The comment lookup reads every page, up to 1000 comments** (GitHub, GitLab, Bitbucket; 100 per page, pages requested by number — a `next` link in a response is only a signal that more exists, never a URL that is fetched, so it cannot steer the token to another host). If the marker is not among the first 1000 comments of a ticket that has more, the lookup **refuses** (`VALIDATION`, not retriable, "nothing was posted") rather than answer "not posted" and post a duplicate; post that comment without an `idempotencyKey` if you really want it. **Not covered:** ClickUp's comment list is paged by `start` / `start_id` and this adapter reads only its first page, which could not be verified without a real workspace; and `fetch` returns the first page of a ticket's comments (30 on GitHub, 100 on GitLab and Bitbucket), which is context for test generation, not a complete history.
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

## Verification status

| Tracker | Adapter | Verified against a mock | Verified against the real service |
|---|:---:|:---:|:---:|
| GitHub Issues | yes | yes | **not yet** |
| ClickUp | yes | yes | **not yet** |
| Azure DevOps | yes | yes | **not yet** |
| GitLab | yes | yes | **not yet** |
| Bitbucket | yes | yes | **not yet** |
| Jira | no — Atlassian MCP, interactive only | n/a | n/a |

"Verified against a mock" means the 23-behavior contract suite plus adapter-specific tests pass, and the evals
(145 checks) and the demo run the real CLIs end to end. It does **not** cover what only a live tracker can tell you:
field names or required fields that differ from the docs, process templates (Azure needs a `Test Case` work item type;
the Basic process has none), token scopes and permissions, real rate-limit and pagination behavior, and how closely
the real search index and error bodies match the mock. When a real run disagrees with a mock, fix the adapter **and**
the mock so the contract suite catches it next time.

To move a row to "yes": run the smoke test below against a scratch repo/project/list, put the report in the PR, and
update this table in the same PR.

## Real-tracker smoke test

```bash
node scripts/tracker/smoke.js --source github --config qa-config.json          # prints the plan: which project, nothing created
node scripts/tracker/smoke.js --source github --config qa-config.json --yes    # actually runs it
```

Use a **scratch** repo / project / list: the script creates items and there is deliberately no delete operation, so it
leaves them behind (labelled `qa-harness-smoke` where the tracker has labels, and titled `[qa-harness smoke <id>]`
everywhere) and lists them at the end for you to close.

It checks, in order: connect · create a bug · fetch it back · search finds it · create a test case and link it ·
retrying the bug with the same key returns the original · same for the test case · a comment, and the same comment
again · an unknown id is `NOT_FOUND` · an invalid token is rejected (`--skip-bad-token` skips that last one). Each is
**pass**, **warn** or **fail**; a step that depends on a failed one shows as **skipped**, never disappears. Warnings are
real-world behavior worth knowing (for example GitHub's search index lagging a fresh issue, or a tracker answering
`422` where the contract says `NOT_FOUND`), not necessarily a broken adapter. Output: a readable table on stderr and one
JSON document on stdout; exit `0` no failures, `1` at least one, `2` not run (bad flags, or `--yes` missing).
Tokens are never printed.

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
node --test tests/tracker/*.test.js     # 323 tests in a few seconds, no network, no ports
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
tracker agrees — a real-tracker smoke test against a sandbox project (above) is the missing half before relying on this
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
