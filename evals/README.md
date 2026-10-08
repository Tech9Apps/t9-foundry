# Evals

Golden scenarios for the ticket → tracker pipeline. Each file in `scenarios/` is a ticket from the demo project plus
**golden expectations** (case counts, priority mix, acceptance-criteria count, which bugs it should surface) that were
verified by counting the sample files directly — not by running the code under test.

```bash
node evals/run.js                          # every scenario × every tracker
node evals/run.js --tracker clickup        # one tracker
node evals/run.js --scenario DEMO-102      # one scenario
node evals/run.js --json                   # machine-readable
```

Per scenario and tracker it checks: the plan (priorities, steps), `fetch` + the pipeline context file, posting every
case (created, carried across, linked), a no-op re-run, four failure drills (transient failure, lost response,
revoked credentials mid-run, wrong parent id), one-time results comments, and — where the ticket has a known bug — filing
it once, finding it by search, and re-filing without a duplicate.

Deterministic: no network, no model, ~2 seconds. `bats tests/evals.bats` runs it in CI and proves a wrong golden
fails. To add a scenario, drop a JSON file in `scenarios/` (see the existing ones).

**Not yet:** model-in-the-loop evals — having Claude generate the test cases or bug reports and judging them against
these goldens. They belong here too, but they are non-deterministic and cost money, so they should run nightly and
on demand rather than on every PR.
