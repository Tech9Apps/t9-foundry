# setup-ci

Generate or extend a CI workflow to automatically run e2e tests against the staging environment on every push and pull request.

## When to invoke

Trigger phrases: "set up CI", "generate CI workflow", "add CI", "add GitHub Actions", "add e2e to my pipeline", "add e2e to CI", "automate test runs", "/setup-ci"

## Steps

1. **Read config**
   Run `jq . qa-config.json`. Stop if missing — direct to `/init`.

   Read: `testFramework.type`, `testFramework.configPath`, `testFramework.testDir`, `environments.testEnvironmentBaseUrl`, `codeRepository.localPath`, `codeRepository.type`.

   If `testFramework.type` is not set, stop:
   "No test framework is configured. Run `/setup-e2e-framework` first, then come back to `/setup-ci`."

2. **Detect existing CI in the app repo**
   Scan `{codeRepository.localPath}` for CI config files:
   - GitHub Actions: `{localPath}/.github/workflows/*.yml` (list all found)
   - GitLab CI: `{localPath}/.gitlab-ci.yml`
   - Bitbucket Pipelines: `{localPath}/bitbucket-pipelines.yml`

   If multiple systems are detected, ask: "I found CI configs for multiple systems. Which one should I add e2e tests to?"

3. **Branch on detection result**

   ### Existing CI found
   Read the existing workflow file to understand its structure (jobs, stages, triggers).

   Ask: "I found an existing pipeline at `{path}`. Should I:
   1. **Add a new e2e job** to the existing file — runs after your current test jobs (recommended)
   2. **Create a separate `e2e.yml`** — standalone workflow, doesn't touch the existing file"

   **Option 1 — add to existing file:**
   - Append a new `e2e` job that depends on the existing primary test job
   - GitHub Actions: use `needs: [existing-job-name]`
   - GitLab CI: use the next `stage:` after the existing test stage
   - Bitbucket: add a new step in the existing pipeline
   - Do NOT modify or rename any existing jobs

   **Option 2 — separate file:**
   - Proceed as if no CI was found (step below), using `e2e.yml` as the filename

   ### No CI found
   Ask: "Which CI system do you use?"
   1. **GitHub Actions** (`.github/workflows/e2e.yml`)
   2. **GitLab CI** (`.gitlab-ci.yml`)
   3. **Bitbucket Pipelines** (`bitbucket-pipelines.yml`)

4. **Build the e2e job**

   Use `BASE_URL` from a CI secret/variable — never hardcode the staging URL.

   Per-framework run command (same as `/run-tests` uses):
   - `playwright` → `npx playwright test`
   - `cypress`    → `npx cypress run`
   - `pytest`     → `python -m pytest {testFramework.testDir} -v`
   - `rspec`      → `bundle exec rspec {testFramework.testDir}`
   - `webdriverio`→ `npx wdio {testFramework.configPath}`
   - `selenium`   → `python -m pytest {testFramework.testDir} -v`

   ### GitHub Actions job template
   ```yaml
   e2e:
     name: E2e tests
     runs-on: ubuntu-latest
     # needs: [test]   # uncomment and set to your existing test job name
     env:
       BASE_URL: ${{ secrets.STAGING_URL }}
     steps:
       - uses: actions/checkout@v4
       - name: Set up Node.js       # omit for Python frameworks
         uses: actions/setup-node@v4
         with:
           node-version: '20'
       - name: Install dependencies
         run: npm ci                # or: pip install -r requirements.txt
       - name: Run e2e tests
         run: {framework-run-command}
       - name: Upload test artifacts
         if: failure()
         uses: actions/upload-artifact@v4
         with:
           name: e2e-results
           path: |
             playwright-report/
             test-results/
           retention-days: 7
   ```

   ### GitLab CI job template
   ```yaml
   e2e:
     stage: test
     image: node:20    # or python:3.11 for Python frameworks
     variables:
       BASE_URL: $STAGING_URL
     script:
       - npm ci
       - {framework-run-command}
     artifacts:
       when: on_failure
       paths:
         - playwright-report/
       expire_in: 7 days
   ```

   ### Bitbucket Pipelines step template
   ```yaml
   - step:
       name: E2e tests
       image: node:20
       script:
         - npm ci
         - BASE_URL=$STAGING_URL {framework-run-command}
       artifacts:
         - playwright-report/**
   ```

5. **Write the file**
   Write or edit the file at the appropriate path inside `{codeRepository.localPath}`.
   Create `.github/workflows/` directory if needed.

6. **Report and instruct**
   Tell the engineer:

   ```
   CI configured — {project.name}
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   File:      {path to workflow file}
   Framework: {testFramework.type}
   Trigger:   push to main + pull requests

   Next step — add the staging URL as a CI secret:
   ```

   **GitHub Actions:**
   > Go to your repo → Settings → Secrets and variables → Actions → New repository secret
   > Name: `STAGING_URL`  Value: `{testEnvironmentBaseUrl}`

   **GitLab CI:**
   > Go to your project → Settings → CI/CD → Variables → Add variable
   > Key: `STAGING_URL`  Value: `{testEnvironmentBaseUrl}`  (mark as Protected + Masked)

   **Bitbucket:**
   > Go to your repo → Repository settings → Pipelines → Repository variables
   > Name: `STAGING_URL`  Value: `{testEnvironmentBaseUrl}`  (mark as Secured)

   Then push to trigger the workflow, or open a PR to see it run automatically.
