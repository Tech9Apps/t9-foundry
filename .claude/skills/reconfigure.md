# reconfigure

Update a single setting in an existing workspace configuration without re-running the full
`/init` wizard. Shows the current value, asks for the new one, validates it, and patches
`qa-config.json` in place.

## When to invoke

Trigger phrases: "reconfigure", "update config", "change my staging URL", "change ticket source",
"switch ticket source to", "update my settings", "change the test environment", "add a production
pattern", "change my test framework", "update the repo", "/reconfigure"

## Steps

1. **Read current config**
   Run `jq . qa-config.json`. If the file is missing, stop: "Your workspace is not configured.
   Run `/init` to set it up."

2. **Identify what to change**
   If the trigger phrase names a specific setting, skip to that section below.
   Otherwise present this menu:

   ```
   What would you like to update?

   1. Staging environment URL     — current: {environments.testEnvironmentBaseUrl}
   2. Ticket source               — current: {ticketSource.type}
   3. Code repository             — current: {codeRepository.type}
   4. Test framework              — current: {testFramework.type or "not set"}
   5. Production URL patterns     — current: {productionProtection.prodUrlPatterns}
   6. Data management strategy    — current: {dataManagement.strategy or "not set"}
   ```

   Wait for the engineer's selection before proceeding.

3. **Handle each setting**

   ### 1. Staging environment URL
   - Show current value: `{environments.testEnvironmentBaseUrl}`
   - Ask: "What is the new staging or test environment URL?"
   - Validate: check the new URL against every pattern in `productionProtection.prodUrlPatterns`.
     Also apply the heuristic check from `connect-repo.md` (reject bare apex domains, reject
     subdomains containing `prod` or `production` without a staging qualifier).
   - If validation fails: explain the violation and ask for a corrected URL. Do not write.
   - If validation passes: `jq '.environments.testEnvironmentBaseUrl = "NEW_URL"' qa-config.json > qa-config.tmp && mv qa-config.tmp qa-config.json`

   ### 2. Ticket source
   - Show current value: `{ticketSource.type}`
   - Execute the full source-selection and connectivity steps from `connect-tickets.md`
     (Steps 2–4). The existing config fields for the new source type will be written;
     old source-type sub-fields are left in place (they do no harm and may be reused).

   ### 3. Code repository
   - Show current value: `{codeRepository.type}` / `{codeRepository.localPath or repo identifier}`
   - Execute the full repo configuration steps from `connect-repo.md` (Steps 2–7).
     Skip the production URL pattern collection (Step 6) unless the engineer asks to update
     patterns too.

   ### 4. Test framework
   - Show current value: `{testFramework.type}` / `{testFramework.configPath or "path not set"}`
   - Ask which framework (same options as `/init` Question 5).
   - Ask for the config file path (approximate is fine).
   - If `configPath` is provided, confirm the file exists with `ls {path}`.
   - Write:
     ```
     jq '.testFramework.type = "FRAMEWORK" | .testFramework.configPath = "PATH" | .testFramework.testDir = "DIR"' \
       qa-config.json > qa-config.tmp && mv qa-config.tmp qa-config.json
     ```
   - If `/setup-e2e-framework` has not been run yet, note that the engineer should run it
     to scaffold the actual config and support files.

   ### 5. Production URL patterns
   - Show current patterns: list each entry in `productionProtection.prodUrlPatterns`
   - Offer three options:
     - **Add** a new pattern
     - **Remove** an existing pattern (show numbered list)
     - **Replace all** (re-enter the full list)
   - After any change, validate the staging URL against the updated patterns to confirm it
     still passes. If the staging URL now matches a pattern, warn the engineer and ask them
     to correct either the pattern or the URL before writing.
   - Write the updated array with `jq`.

   ### 6. Data management strategy
   - Show current value: `{dataManagement.strategy}`
   - Present options (same as `/init` Phase 7):
     - `factory` — create all test data through the API; DataFactory handles cleanup
     - `seed-rollback` — seed data before the run, roll back after (requires transaction support)
     - `snapshot-restore` — restore from a Docker volume snapshot before each run
     - `tag-cleanup` — tag all created records with a run ID; delete by tag after the run
     - `api-teardown` — explicit DELETE calls in teardown hooks
   - Write with `jq`.

4. **Confirm the change**
   Read the updated field back from `qa-config.json` and display it:
   ```
   Updated — {setting name}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━
   {field path}:  {new value}
   ```
   Ask if anything else needs to be changed. If yes, return to Step 2. If no, end the skill.

## Config file handling

Always use `jq` to patch individual fields — never overwrite the entire file.
Temp-file pattern: `jq 'EXPRESSION' qa-config.json > qa-config.tmp && mv qa-config.tmp qa-config.json`
