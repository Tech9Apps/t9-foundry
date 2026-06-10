# connect-repo

Configure the code repository and test environment URL for this QA workspace.

## When to invoke

Trigger phrases: "connect to the repo", "configure repository", "set up code repository", "connect GitHub repo", "connect GitLab", "connect Bitbucket", "point at the codebase", "set the staging URL", "configure test environment"

## Steps

1. **Read current config**
   Read `qa-config.json`. If `codeRepository.type` is already set, show the current configuration and ask if they want to reconfigure.

2. **Ask where the code lives**
   Present options:
   - GitHub
   - GitLab
   - Bitbucket
   - Local filesystem only (no remote API needed)

3. **Ask if a local clone exists**
   "Is the repository cloned locally? If yes, provide the path (e.g., `../my-app`). If no, I'll use the remote API for code analysis."

4. **Configure the selected repository source**

   ### GitHub
   - Run `gh auth status` to verify gh CLI is authenticated
   - If it fails: prompt to install and authenticate the gh CLI
   - Ask for the repository in `owner/repo` format
   - Verify access: `gh repo view {owner/repo} --json name,description`
   - Write to `qa-config.json`: `codeRepository.type = "github"`, `codeRepository.github.repo`

   ### GitLab
   - Check for `$GITLAB_TOKEN`
   - Ask for project ID and host (default: `https://gitlab.com`)
   - Test: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "{host}/api/v4/projects/{id}"`
   - Write to `qa-config.json`

   ### Bitbucket
   - Check for `$BITBUCKET_TOKEN`
   - Ask for workspace and repo slug
   - Test connectivity
   - Write to `qa-config.json`

   ### Local only
   - Verify the path exists using `ls {path}`
   - Write `codeRepository.type = "local"` and `codeRepository.localPath`

5. **Set the test environment URL — CRITICAL STEP**
   Ask: "What is the base URL for your **staging or test** environment? This must NOT be your production URL."

   Examples of valid answers: `https://staging.myapp.com`, `https://test.myapp.com`, `http://localhost:3000`, `https://dev.myapp.com`

   **Validate the URL:**
   - If `qa-config.json` already has `productionProtection.prodUrlPatterns`, check the entered URL against those patterns
   - Also perform a heuristic check: reject URLs that look like production without a staging/test/dev qualifier. Specifically block URLs that:
     - Are bare apex domains without a staging subdomain (e.g., `https://myapp.com`)
     - Contain the word `prod` or `production` in the subdomain
     - Match `app.` prefix without `staging`, `test`, `dev`, or `qa` qualification
   - If the URL fails validation: "That URL looks like a production environment. Production testing is prohibited. Please provide your staging, test, or dev URL."
   - If the URL passes: write to `qa-config.json > environments.testEnvironmentBaseUrl`

6. **Populate production URL patterns**
   Ask: "What are your production URL patterns? I'll use these to block any test execution against production."

   Provide examples: `myapp\.com$`, `app\.myapp\.com`, `production\.myapp\.com`

   Write to `qa-config.json > productionProtection.prodUrlPatterns`

7. **Write local repo path if provided**
   Write `codeRepository.localPath` to `qa-config.json`

8. **Confirm success**
   Report:
   - Repository: {type} / {repo-or-path}
   - Test environment: {baseUrl}
   - Production patterns: {count} patterns configured
   - "Run `/analyze-codebase` to analyze the codebase, or `/create-test-plan TICKET-ID` to start on a ticket."
