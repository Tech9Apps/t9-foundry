# Output Conventions

All output paths are configurable via `qa-config.json > testOutput`. These are the defaults.

| Artifact | Default location |
|----------|-----------------|
| Codebase analysis | `./analysis/[ticket-id]-analysis.md` or `./analysis/latest-analysis.md` |
| Test plans | `./test-plans/[ticket-id]-test-plan.md` |
| Test cases (markdown) | `./test-cases/[ticket-id]-test-cases.md` |
| Test cases (structured) | `./test-cases/[ticket-id]-test-cases.json` |
| Upload receipts | `./test-cases/[ticket-id]-upload-receipt.json` |
| E2e tests | `qa-config.json > testOutput.e2eTestsPath` |

When `ticketSource.type = "none"`, use the feature name provided as the identifier (e.g., `./test-plans/user-checkout-test-plan.md`).

Always confirm the target directory exists or create it before saving.
