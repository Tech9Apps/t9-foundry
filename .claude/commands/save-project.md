# Save Current Config as a Project Profile

You are given a profile name: **$ARGUMENTS**

**If `$ARGUMENTS` is empty, blank, or not provided, stop immediately and tell the user:**
> "A profile name is required. Usage: `/save-project <profile-name>` (e.g. `/save-project my-app`). Use a short, kebab-case name."
**Do not proceed with any further steps.**

## Prerequisites

- `qa-config.json` must exist in the workspace root. If it doesn't, tell the user to run `/init` first and stop.
- **Check the profile name first.** It becomes part of a file path in a shell command, so it must match `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase letters, digits, hyphens). If it does not, stop and say so — suggest a corrected name, but do not use it until the user agrees.

## Check for Secrets Before Committing Anything

Profiles under `projects/` are **committed and shared with the team**. Before saving, scan `qa-config.json` for anything that looks like a literal credential (tokens, keys, passwords — values, not env var *names* like `AZURE_DEVOPS_PAT`). If found, **stop and tell the user** which field holds a literal secret — it must be replaced with an env var name before the config can be saved as a shared profile.

## Save the Profile

If `projects/$ARGUMENTS.json` already exists, show the user a short diff (`diff <(jq -S . projects/$ARGUMENTS.json) <(jq -S . qa-config.json)`) and ask for confirmation before overwriting.

```bash
mkdir -p projects
cp qa-config.json projects/$ARGUMENTS.json
```

Validate the result (`node tests/validate-schema.js projects/$ARGUMENTS.json`) so a broken config never lands in the shared profiles directory.

## Output

- Confirm the profile was saved at `projects/$ARGUMENTS.json`
- Show the profile summary (project name, ticket source type, repo path, test environment URL)
- Remind the user: commit `projects/$ARGUMENTS.json` so teammates can use `/switch-project $ARGUMENTS`.
