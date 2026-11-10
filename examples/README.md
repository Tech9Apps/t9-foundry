# Try the Demo (~15 minutes, no Jira required)

> **Looking for something you can run?** The [`demo/`](../demo/README.md) project is a real app with real bugs and a 2-minute tour (`bash demo/run-demo.sh`) plus a guided `/demo` command. This folder is a smaller, static sample of generated output for a login feature.

This folder contains everything you need to see the full Tech9 QA Harness workflow — from ticket to test cases — without connecting to any ticket system.

---

## What you'll do

1. Copy the demo config so the workspace is configured
2. Open the workspace in Claude Code
3. Run three skills against the demo ticket
4. See what real output looks like

---

## Step 1 — Clone and open the workspace

If you haven't already:

```bash
git clone https://github.com/jgifford78/tech9foundry.git
cd tech9foundry
claude
```

---

## Step 2 — Copy the demo config

```bash
cp examples/qa-config.demo.json qa-config.json
```

This config sets `ticketSource.type: "none"` so the harness collects requirements directly from you (no Jira needed), and sets placeholder staging URL patterns.

---

## Step 3 — Read the demo ticket

Open [`examples/demo-ticket.md`](demo-ticket.md) in your editor. This is a realistic user story for a login feature — the kind of ticket a QA engineer would actually receive. You'll paste or summarize it when the skill asks for requirements.

---

## Step 4 — Run the workflow

In the Claude Code session, run:

```
/create-test-plan user-login
```

When prompted for requirements (since there's no ticket system), paste the contents of `examples/demo-ticket.md` or summarize the acceptance criteria.

The skill will produce a structured test plan. Then:

```
/write-test-cases user-login
```

This expands the plan into individual test cases saved to `./test-cases/user-login-test-cases.md`.

---

## What to expect

Your output will look similar to the pre-generated examples in [`examples/output/`](output/):

| File | What it shows |
|------|--------------|
| [`login-analysis.md`](output/login-analysis.md) | What `/analyze-codebase` produces (routes, models, risk areas, coverage gaps) |
| [`login-test-plan.md`](output/login-test-plan.md) | What `/create-test-plan` produces (scope, risk table, test case summary) |
| [`login-test-cases.md`](output/login-test-cases.md) | What `/write-test-cases` produces (full test cases with steps and expected results) |

Your actual output will differ based on how you describe the feature — that's intentional.

---

## Next steps

Once you've seen the workflow in action:

1. **Connect a real ticket system** — run `/init` to configure Jira, ClickUp, GitHub Issues, or another source
2. **Point it at a real app** — configure `codeRepository.localPath` in `qa-config.json` so `/analyze-codebase` reads your actual routes and models
3. **Scaffold e2e tests** — run `/setup-e2e-framework` to generate a runnable Playwright or Cypress setup in your app repo
4. **Add CI** — run `/setup-ci` to wire the e2e tests into your GitHub Actions or GitLab CI pipeline
