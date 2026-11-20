# The run ledger: an operator's guide

The ledger is the harness's memory of what it did. It is a folder of plain files (default `.qa-ledger/`, next to your `qa-config.json`, and
gitignored) that records each run, each write the harness made to your tracker, and what is locked right now. It exists so that a retry never
files a bug twice, a crash leaves a trail, two runs do not trample one environment, and a run can be summarized after the fact.

It is bookkeeping, not authority. It can make the harness do **less** (skip a write it already made, refuse a run that would overlap another),
never more: a `propose` stays a `propose` whatever the ledger says, and a ledger that cannot be written to is a warning, not a failed run. The
design and the reasons are in [phase-3-design.md](phase-3-design.md); this page is what you need to run it.

## Turning it on

The ledger is **off** unless the project asks for it. Add a `ledger` block (an empty one is enough) to `qa-config.json`:

```json
"ledger": { "dir": ".qa-ledger", "retentionDays": 90 }
```

or pass `--ledger-dir <dir>` to a command. There is deliberately no flag that turns it off for one run, and a flag may not point a run at a
different ledger than the config names: either would let one command quietly lift what the project set. To stop recording, remove the block. (Pointing a
command at another config file with `--config` is the way round that: it is a person's decision, and no script here has an allow rule that would let the
agent make it unseen.)
A relative `dir` is relative to the config file, not to where you happened to run the command.

Other settings that need it: `budget.cooldownMinutes` and the run locks (both are ignored without a ledger, and a cooldown with no ledger says
so in the run's warnings). The wall-clock limit `budget.maxWallClockMs` works without one.

## What is in the folder

```
.qa-ledger/
  VERSION                     the layout version ("1")
  runs/<run>.jsonl            the events of one run: start, each test result, each verdict, warnings, spend, end (the name is the run id,
                              lower-cased, with a hash added when it holds anything unusual)
  keys/<hash>.json            one claim per idempotency key: "this write was started / finished"
  locks/<hash>.lock           who holds the environment or the ticket right now (named by a hash of what is locked; the file says which)
  audit.jsonl                 every write to the tracker and every lock taken over, from all runs
```

Everything in it is valid JSON, one record per line, written with owner-only permissions. Secrets are masked before they are written, and each
record is capped at 8 KB. You can read it with `less`; you should not edit it. Hand-editing is how a forged ledger happens, and the harness
treats what it reads as data.

## Reading a run

```bash
node scripts/report.js --run-id <run-id>
```

prints a summary of one run, rendered from its events. It is the same text for a pass, a failure and a crash, and nobody writes it: it says
what the record says. It has these parts:

| Part | What it tells you |
|---|---|
| Headline | `passed`, `N failed`, `did not finish`, `stopped by its budget (partial)`, or `ended with an error (exit N)` |
| The table at the top | framework, ticket, times, test counts, how many runs the verdicts rest on, and what the run **spent** |
| Verdicts | one row per failure or flaky test: class, confidence, the rule that decided it, and **what happened** to it |
| Flaky | tests that flipped in **this** run (a pass in one phase and a failure in another, or marked flaky by the runner), with how often they flipped over their recent runs when there is a history (report only: nothing is quarantined) |
| Warnings | what the run itself warned about (a search that could not see everything, a skipped step, a stale heal branch) |
| Problems with the record | only when the ledger itself is damaged or could not be read in full (see below) |
| Not done, and why | what a person still has to do, what was held back and why, and whether the run itself finished |

**What happened** is one of: `filed #N`, `commented on #N`, `waiting for a person` (the plan says a bug or a comment is due and nobody has
done it yet), `filing failed (CODE): try again`, `filing began and did not finish`, or a reason it was never going to write (`reported only`,
`proposed only`, `not filed: #N was closed without a fix`, `covered by another failure in this run`). A `(ledger)` after a report number means
the ledger found it and the tracker's search did not: the search index lags, and the ledger stopped a duplicate.

**Spent.** Wall-clock time is measured by the run. **Turns and cost are not measured by the scripts**; they show as `not measured` unless
whatever launched the model reported them with `node scripts/ledger/cli.js budget-record --run-id <id> --turns N --cost-usd X`.

A run that has **no end** (it was killed, or the machine slept through it) is shown as `did not finish`, whatever else it recorded. A run that finished with no tests is `ran no tests`, never `passed`.

**A damaged ledger is said out loud.** A line that cannot be parsed, a record cut to fit, or an audit log over 16 MB (the reader will not take a bigger file) becomes a
"Problems with the record" section and a line on stderr. A write that cannot be confirmed because the audit log was not read in full is shown as `cannot tell whether it was
written` (never as `waiting` or `filed`), failures with no verdict in the record are counted, and none of this is ever "Nothing: every step ran". Such a run is not green. A run that was
**refused** (exit 4: a cooldown, or a lock held) is not recorded, so there is nothing to summarize: the refusal is the JSON the command printed. (The one thing it can leave
is the audit line for a stale lock it took over on the way.)

More ways in:

```bash
node scripts/ledger/cli.js status               # runs (and which did not finish), claims in flight, locks, stale heal branches
node scripts/ledger/cli.js show --run-id <id>   # every event of one run
node scripts/ledger/cli.js flake-rate           # tests that flipped between pass and fail inside a run, over their last 20 runs (--window N, --all)
```

## Sending a summary somewhere

`report.js` always prints to stdout. It can also:

- **Append to `$GITHUB_STEP_SUMMARY`**, but only inside GitHub Actions (`GITHUB_ACTIONS` is `true`), because that variable names a file to append to and
  nothing else should be trusted to set it. The file is opened for appending without creating anything and without following a link, and checked through the
  open file: it must be a regular file, with one name (not a hard link), owned by this user. `--no-step-summary` skips it.
- **Write a ticket-comment input file** with `--comment-out FILE`, in the shape the planner writes (`{ id, body, idempotencyKey }`), for the ticket
  the run was for (`--ticket` on the orchestrator, or `--ticket` here). It is an *input file*: posting it is a separate step, behind the same human
  gate as every other comment (`node scripts/tracker/cli.js comment --input-file FILE`). Its key is the same every time for a run and ticket, so posting it
  twice comments once. It is written over a regular file or a new path, never over a link, a folder or a pipe. It is **not written for an Azure tracker**: that
  adapter posts comment text as HTML, and this summary is Markdown, which is only safe where Markdown is what is shown.
- **Post a short version to Slack**, only when you ask: `--slack` (or `--slack-only-failures`, which keeps a green run quiet) **and** `QA_SLACK_WEBHOOK` set. A webhook that
  merely happens to be in the environment is not enough, so approving `report.js` never posts by surprise. The address is a credential, so it is held to rules:
  `https` only, no user name or odd port in it, the host must be `hooks.slack.com` or one named in `report.slackHosts` in `qa-config.json` (a name, not an
  IP address), a redirect is not followed, the message is size-capped, and the address is never printed.

None of the three can fail the report: a problem is a line on stderr starting `report:`, and the exit status stays 0. `report.js` itself exits 1 when that run is
not in the ledger, 2 for a bad invocation, and 3 when the ledger cannot be read.

What goes in a summary is test names, errors and warnings from a run, which are untrusted text. They are masked again, cut down, and made
harmless in Markdown and Slack: no table break, no HTML, no `@mention` or channel ping, no link or `#123` / `owner/repo#1` cross-reference, nothing that starts a heading or a
list, no direction-changing or invisible characters, and for Slack none of its formatting. Left alone: a commit id (it links only where such a commit exists), `:emoji:` and
`_emphasis_`. A summary is still something to read before you forward it outside the team: the harness masks what looks like a credential, not what is merely private.

## Limits the harness enforces

| Setting | Effect | Exit |
|---|---|---|
| `budget.cooldownMinutes` (or `--cooldown-minutes`) | a run for a ticket (`--ticket`) is refused if that ticket's last run **ended** less than this long ago | 4, `COOLDOWN` |
| locks (automatic with a ledger) | a run needs the lock on the test environment and, with `--ticket`, on the ticket; `post-tests` takes the ticket's | 4, `LOCKED` (`post-tests`: `IN_PROGRESS`) |
| `budget.maxWallClockMs` (or `--max-wall-clock-ms`) | checked before each costly step (the re-runs, the plan, self-heal); the run stops there, and what it skipped is listed | 5, partial result |

A flag can **tighten** a limit and never loosen one the project set. A refused run starts nothing, takes nothing and writes nothing. The agent's
`/run-and-triage` command passes `--ticket` only when you tell it which ticket the run is for; without one, no cooldown or ticket lock applies.

A launcher that starts a model session can ask first, without taking anything:

```bash
node scripts/ledger/cli.js budget-check --ticket DEMO-101     # exit 0, and the limits to pass on (turns, cost); exit 4 with the reasons
```

Turns and cost are the launcher's to enforce (`claude -p --max-turns`, a spend cap); the scripts only hand the numbers over and record what comes
back.

## After a crash

A run that is killed (a power cut, `kill -9`, a laptop that slept) cannot clean up. What it leaves, and what to do:

- **An unfinished run.** `status` lists runs with no end. Nothing to do: the next summary says `did not finish`. Old ones go with `prune`.
- **Locks.** A lock whose owner process is gone (same machine), or that is older than its time limit, is taken over by the next run, which says so
  in its warnings and records it in `audit.jsonl`. Do not delete lock files by hand while a run might be alive. A lock's time limit is derived from
  the run's own timeouts, re-runs and wall-clock limit, so a live run's locks are not taken from it.
- **A write that began and never finished.** `status` shows it under claims `inFlight`. The next attempt for that key either reports that another run
  is writing it right now (`IN_PROGRESS`: wait, run the same command again) or, when its owner is gone, **resumes it**: the tracker is searched for the
  key's marker first, so what the dead run created is adopted, not duplicated.
- **A wrong claim.** If a bug the ledger says it filed was deleted on the tracker, the key still says "done". `ledger forget --key K` drops it, and the
  next write goes to the tracker again. A claim in flight whose owner may still be running is refused unless you add `--force`.
- **A self-heal branch left behind.** If a run died during self-heal, `status` and the next run's warnings name the branch (`qa/heal-*`) and the commit
  it started from. The harness never deletes it for you: look at it (`git log`, `git diff <base>...<branch>`), then keep it or `git branch -D` it.
- **A ledger written by a newer version.** The harness reads it read-only and warns, rather than corrupt it. Update the checkout.
- **A ledger that cannot be written** (read-only disk, no space). The run goes ahead, unprotected and unrecorded, with a warning. The write marker the
  tracker adapters embed still prevents most duplicates; the ledger adds what the marker cannot.

## Keeping it small

```bash
node scripts/ledger/cli.js prune --dry-run     # what would go
node scripts/ledger/cli.js prune               # run files older than 90 days, claims older than 400 (--run-days N, --key-days N)
```

Run files are the bulk of it (tens of KB each). Claims live much longer than runs on purpose: a key must outlive the longest plausible retry.
Pruning goes by each file's age (when it last changed), and also clears leftover temporary files. It never touches lock files (a stale one is taken
over by the next run) and it does not trim `audit.jsonl`, which grows by a line per write to the tracker. **Move it aside before it passes 16 MB**: the reader will not take a
bigger file, and every summary then says it cannot confirm the writes. Nothing else needs its old lines, and a summary of an old run then says `cannot tell` for its filings.

## What it does not do

- A lock protects **one machine**. Two CI runners do not share a `.qa-ledger/` folder; Phase 4's workflow `concurrency:` groups are what stop two
  jobs from overlapping.
- Self-heal called by hand (`heal.js` directly) takes no lock.
- Turns and cost are recorded when someone reports them, never measured.
- The summary is of what the ledger recorded. A project without a ledger gets the run's JSON output and nothing else.
