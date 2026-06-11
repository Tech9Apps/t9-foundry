# connect-tickets

Configure the ticket source for this QA workspace.

## When to invoke

Trigger phrases: "connect to Jira", "connect to ClickUp", "connect GitHub Issues", "set up ticket source", "configure issue tracker", "where do I pull tickets from", "set up Jira"

## Steps

1. **Read current config**
   Read `qa-config.json` if it exists. If `ticketSource.type` is already set, show the current configuration and ask: "Your ticket source is already configured as `{type}`. Do you want to reconfigure it?"

2. **Ask which ticket source**
   Present these options:
   - Jira (Atlassian)
   - ClickUp
   - GitHub Issues
   - GitLab Issues
   - Bitbucket Issues
   - No ticket system (describe requirements directly in the harness)

3. **Configure the selected source**

   ### Jira
   - Call `mcp__claude_ai_Atlassian__atlassianUserInfo` to verify the Atlassian MCP is active and the user is authenticated
   - If it fails: "Jira requires the Atlassian MCP. Sign in at claude.ai → Integrations → Atlassian, then re-run /connect-tickets"
   - Ask for the Jira project key (e.g., `MYAPP`)
   - Call `mcp__claude_ai_Atlassian__getVisibleJiraProjects` to confirm the project key exists
   - Call `mcp__claude_ai_Atlassian__getJiraProjectIssueTypesMetadata` with the project key to detect available issue types (look for "Test"; note if only "Task" is available)
   - Write to `qa-config.json`: `ticketSource.type = "jira"`, `ticketSource.jira.projectKey`, `ticketSource.jira.testIssueType` (set to "Test" or "Task" based on what's available)

   ### ClickUp
   - Check if `$CLICKUP_TOKEN` is set: `bash -c 'echo $CLICKUP_TOKEN'`
   - If empty: "Set your ClickUp API token: `export CLICKUP_TOKEN=your_token_here` — add this to your shell profile (~/.zshrc or ~/.bashrc), then restart your terminal and re-run /connect-tickets"
   - Ask for the Workspace ID and List ID where test cases should be uploaded
   - Test connectivity: `curl -s -H "Authorization: $CLICKUP_TOKEN" "https://api.clickup.com/api/v2/list/{list_id}"`
   - Write to `qa-config.json`: `ticketSource.type = "clickup"`, `ticketSource.clickup.workspaceId`, `ticketSource.clickup.listId`

   ### GitHub Issues
   - Run `gh auth status` to verify the gh CLI is authenticated
   - If it fails: "Install the GitHub CLI: `brew install gh`, then authenticate: `gh auth login`"
   - Ask for the repository in `owner/repo` format
   - Test connectivity: `gh repo view {owner/repo} --json name`
   - Ask what label should mark test cases (default: `test-case`). Create the label if it doesn't exist: `gh label create "test-case" --color "#0075ca" --repo {owner/repo}`
   - Write to `qa-config.json`: `ticketSource.type = "github"`, `ticketSource.github.repo`, `ticketSource.github.testLabelName`

   ### GitLab Issues
   - Check if `$GITLAB_TOKEN` is set
   - If empty: prompt to set it in their shell profile
   - Ask for the GitLab project ID (found in the project's Settings → General)
   - Ask for the GitLab host (default: `https://gitlab.com`)
   - Test connectivity: `curl -s -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "{host}/api/v4/projects/{project_id}"`
   - Write to `qa-config.json`: `ticketSource.type = "gitlab"`, `ticketSource.gitlab.projectId`, `ticketSource.gitlab.host`

   ### Bitbucket
   - Check if `$BITBUCKET_TOKEN` is set (this is a Bitbucket App Password)
   - Ask for workspace slug and repository slug
   - Test connectivity using the REST API
   - Write to `qa-config.json`

   ### No ticket system
   - Write `ticketSource.type = "none"` to `qa-config.json`
   - No connectivity check needed
   - When this mode is active, `/create-test-plan` will prompt the engineer to describe the feature and requirements directly instead of fetching a ticket. `/upload-tests` will save test cases to markdown files only.

4. **Verify by fetching a real ticket**
   After writing config, fetch one real ticket from the configured source to confirm end-to-end connectivity. Display the ticket title and ID.
   Skip this step if `ticketSource.type = "none"`.

5. **Confirm success**
   - If a ticket source was configured: "Ticket source configured: {type} / {project-or-repo}. You can now run `/connect-repo` to configure your code repository."
   - If no ticket system: "No ticket system configured. When you run `/create-test-plan`, you'll describe the feature requirements directly. You can now run `/connect-repo` to configure your code repository."

## Config file handling
If `qa-config.json` does not exist, create it from `qa-config.example.json` first, then update the relevant fields.
Use `jq` to read and write individual fields rather than overwriting the entire file.
