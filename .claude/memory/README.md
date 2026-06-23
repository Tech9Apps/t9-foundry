# `.claude/memory/` — AI Rules for Test-Case Work

This folder holds the **rules and actions the AI must follow** on any task that
creates, updates, runs, or uploads **manual or automated test cases**.

These are not optional guidelines. Treat every file here as a binding contract,
the same priority as `CLAUDE.md`. When a rule here conflicts with a default
behavior, the rule here wins. When it conflicts with an explicit user
instruction in the current conversation, the user wins — but say so out loud.

## Files

| File | Applies to |
|------|------------|
| `ai-usage-rules.md` | Every test-related task — read this first |
| `manual-test-rules.md` | Writing / uploading **manual** test cases |
| `automated-test-rules.md` | Writing / running **automated** (e2e) test cases |

## When to read these

Read `ai-usage-rules.md` at the start of **any** task whose goal is to produce
or change test cases. Then read the manual or automated file depending on what
you are generating. The end-to-end test-generation agents (`Manual-test-generator`,
`Manual-Automation-test-generator`) must load all three before step 1.
