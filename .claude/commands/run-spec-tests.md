# Execute Playwright Tests

You are given an argument: **$ARGUMENTS** — a spec file name or path.

**If `$ARGUMENTS` is empty, stop immediately and tell the user:**
> "You have not defined any spec file to run. Usage:
> `/run-tests <spec-file>` — e.g. `/run-tests login.spec.ts`"
**Do not proceed.**

## Find the Spec File

Resolve `$ARGUMENTS` to a concrete path directly:
```bash
find tests/ -iname "*$ARGUMENTS*" --include="*.spec.ts" 2>/dev/null || find tests/ -iname "*$ARGUMENTS*"
```
If `$ARGUMENTS` already looks like a path (contains `/`), use it as-is provided the file exists.

- **No match found:** stop immediately and tell the user:
  > "This spec file (`$ARGUMENTS`) is not available in the folder structure. Check the file name/path and try again — e.g. `/run-tests login.spec.ts`."
  Do not proceed.
- **More than one match found:** list the candidates and ask the user to disambiguate — do not guess.

## Execute Tests

**Always run in headed mode** so the user can see the browser executing tests live:

```bash
npx playwright test <path-to-spec-file> --headed --reporter=list
```

### Handle Failures (max 3 retries):

1. **Read the failure screenshot** from `test-results/` to understand what the browser was showing at the time of failure
2. **Selector/locator issues** — fix selectors in the page object (`pages/<feature>.page.ts`), re-run
3. **Timing/load issues** — increase timeouts or add appropriate `waitFor` calls in the agent, re-run
4. **Test logic errors** — fix the spec file, re-run
5. **Element intercepted by overlay** — use `{ force: true }` on hover/click, or dismiss the overlay first, re-run
6. After 3 failed retries, proceed with the failure details

### Capture Results:
- Total tests run
- Tests passed / failed / skipped
- Failure details (if any)
- Execution time

## Output

Print:
- Test execution results (passed/failed/skipped)
- Execution time
- Spec file path used
