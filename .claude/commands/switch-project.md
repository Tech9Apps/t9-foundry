# Switch Active Project

You are given a project profile name: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided:**
1. List the available profiles: run `ls projects/*.json 2>/dev/null` and show each basename without the `.json` extension, alongside its `project.name` (`jq -r '.project.name' <file>`).
2. Tell the user:
> "Usage: `/switch-project <profile-name>` — pick one of the profiles above, or run `/save-project <name>` to snapshot your current config as a new profile."
3. **Stop. Do not proceed.**

## Locate the Profile

The profile must exist at `projects/$ARGUMENTS.json`. If it does not exist, list the available profiles (as above) and stop.

## Validate Before Switching

Run both checks — refuse to switch if either fails:

1. **Schema validation** (requires ajv — `npm install --prefix tests/` if missing):
   ```bash
   node tests/validate-schema.js projects/$ARGUMENTS.json
   ```
   Non-zero exit → print the validation errors, tell the user to fix the profile, and stop.

2. **Production URL guard** (mirrors `hooks/session-init.sh` Layer 2): extract `environments.testEnvironmentBaseUrl` and every `productionProtection.prodUrlPatterns[]` entry from the profile with `jq`. If the URL matches any pattern (`grep -E -e "$pattern"` — always use `-e`, patterns may start with `--`), **refuse the switch**: name the matching pattern, explain that the profile points its test environment at production, and stop. Do not copy the file.

## Perform the Switch

```bash
cp projects/$ARGUMENTS.json qa-config.json
```

`qa-config.json` is gitignored — the committed profile stays the team's shared source of truth, and the copy is this workspace's active config. All skills, commands, agents, and hooks read `qa-config.json`, so the switch takes effect immediately.

## Output

Print an active-project summary read from the new `qa-config.json`:
- **Project**: `project.name`
- **Ticket source**: `ticketSource.type` (plus the key identifying field for that type — Jira `projectKey`, Azure `organization/project`, ClickUp `listId`, etc.)
- **Code repository**: `codeRepository.localPath` (note if the path does not exist on this machine)
- **Test environment**: `environments.testEnvironmentBaseUrl`

Remind the user: if this ticket source needs a token env var (Azure/ClickUp/GitLab/Bitbucket), make sure it is exported in their shell — see `docs/integration-guide.md`.
