# Integration Guide

Step-by-step setup for each supported ticket source and code repository.

> **Maintenance note:** When adding a new ticket source or changing an API method, also update `.claude/guides/integration-sources.md` — it contains the reference table Claude uses at runtime to decide how to fetch and upload.

---

## Ticket Sources

### Jira

**Prerequisites:** Atlassian account with access to the Jira project.

1. Sign in to the Atlassian MCP integration at claude.ai → Integrations → Atlassian
2. Open this workspace: `claude`
3. Run `/connect-tickets` — Claude will verify MCP connectivity and ask for your project key
4. Find your project key in Jira: it's the prefix on all your tickets (e.g., `MYAPP` in `MYAPP-123`)

**What gets configured in qa-config.json:**
```json
{
  "ticketSource": {
    "type": "jira",
    "jira": { "projectKey": "MYAPP", "testIssueType": "Test" }
  }
}
```

**Test case upload:** Creates issues of type "Test" (or "Task" if Test type is unavailable) linked to the parent feature ticket.

---

### ClickUp

**Prerequisites:** ClickUp account; API token; List ID where test cases will be created.

1. Get your API token: ClickUp → Profile → Apps → API Token
2. Add to your shell profile: `export CLICKUP_TOKEN=pk_xxxxxxxx`
3. Restart your terminal
4. Find your List ID: open a list in ClickUp → the number in the URL is the list ID
5. Run `/connect-tickets` and select ClickUp

**What gets configured:**
```json
{
  "ticketSource": {
    "type": "clickup",
    "clickup": { "workspaceId": "12345", "listId": "67890", "tokenEnvVar": "CLICKUP_TOKEN" }
  }
}
```

---

### GitHub Issues

**Prerequisites:** GitHub CLI installed and authenticated.

```bash
brew install gh
gh auth login
```

1. Run `/connect-tickets` and select GitHub Issues
2. Provide your repo in `owner/repo` format
3. Claude will create a `test-case` label in your repo if it doesn't exist

**What gets configured:**
```json
{
  "ticketSource": {
    "type": "github",
    "github": { "repo": "acme/my-app", "testLabelName": "test-case" }
  }
}
```

---

### GitLab Issues

**Prerequisites:** GitLab personal access token with `api` scope.

1. Generate a token: GitLab → Preferences → Access Tokens → create with `api` scope
2. Add to shell profile: `export GITLAB_TOKEN=glpat-xxxxxx`
3. Find your project ID: GitLab project → Settings → General (shown at top)
4. Run `/connect-tickets` and select GitLab Issues

---

### Bitbucket Issues

**Prerequisites:** Bitbucket App Password with `issues:read` and `issues:write` permissions.

1. Generate: Bitbucket → Personal Settings → App passwords
2. Add to shell profile: `export BITBUCKET_TOKEN=your_app_password`
3. Run `/connect-tickets` and select Bitbucket Issues

---

## Code Repositories

### GitHub

```bash
gh auth login   # if not already authenticated
```

Run `/connect-repo`, select GitHub, and provide `owner/repo`. Claude will verify access via `gh repo view`.

**Codebase analysis modes:**
- **Local clone (recommended):** Set `localPath` to the local repo path for fast, direct file access
- **API only:** Claude uses `gh api` to fetch file contents remotely

---

### GitLab

1. Set `GITLAB_TOKEN` (same token as GitLab Issues above)
2. Run `/connect-repo`, select GitLab, provide project ID and host

---

### Bitbucket

1. Set `BITBUCKET_TOKEN`
2. Run `/connect-repo`, select Bitbucket, provide workspace and repo slugs

---

## Optional: GitHub MCP Server

For richer GitHub integration (PR diffs, commit context), add the GitHub MCP server in `.claude/settings.local.json` (this file is gitignored):

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

Set `GITHUB_PERSONAL_ACCESS_TOKEN` in your shell profile. This is optional — all harness features work via the `gh` CLI without it.
