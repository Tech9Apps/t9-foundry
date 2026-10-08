#!/usr/bin/env bats
# Lint for .claude/settings.json — the file that wires the safety hooks and the
# permission allowlist. Two ways it has silently broken the harness:
#   1. Hook commands were relative ("bash hooks/prod-guard.sh"): run from any other
#      cwd (a headless/CI run), the hook never executes — Layers 2-4 silently absent.
#   2. Allowlist rules matched "curl -s -H ..." but the commands were changed to
#      "curl -fsS --max-time 30 ..." — every call became a permission prompt, which
#      deadlocks an unattended run.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"
SETTINGS="${QA_SETTINGS_FILE:-$REPO_ROOT/.claude/settings.json}"

@test "settings.json is valid JSON" {
  run jq -e . "$SETTINGS"
  [ "$status" -eq 0 ]
}

@test "every hook command resolves from \$CLAUDE_PROJECT_DIR, not the current directory" {
  bad=$(jq -r '.hooks[][].hooks[].command | select(contains("CLAUDE_PROJECT_DIR") | not)' "$SETTINGS")
  [ -z "$bad" ]
}

@test "every hook script referenced by settings.json exists" {
  while IFS= read -r cmd; do
    script=$(echo "$cmd" | grep -oE 'hooks/[A-Za-z0-9_./-]+\.sh' | head -1)
    [ -n "$script" ]
    [ -f "$REPO_ROOT/$script" ]
  done < <(jq -r '.hooks[][].hooks[].command' "$SETTINGS")
}

# Extract each curl command from the fenced bash blocks of the ticket-writing commands,
# joining "\" continuation lines, one command per line.
curl_commands() {
  awk '
    /^```bash/ { inblock=1; next }
    /^```/     { inblock=0; if (cmd != "") { print cmd; cmd="" } next }
    inblock {
      line=$0
      sub(/^[ \t]+/, "", line)
      if (cmd == "" && line !~ /^curl /) next
      if (line ~ /\\$/) { sub(/\\$/, "", line); cmd = cmd line " "; next }
      cmd = cmd line
      print cmd; cmd=""
    }
  ' "$@"
}

@test "curl calls to hosts that have allowlist rules still match a rule" {
  # Hosts that were allowlisted before the -fsS/--max-time hardening. Azure (-u) was
  # never allowlisted and intentionally still prompts.
  rules=()
  while IFS= read -r r; do rules+=("$r"); done < <(
    jq -r '.permissions.allow[] | select(startswith("Bash(curl")) | sub("^Bash\\("; "") | sub("\\)$"; "")' "$SETTINGS"
  )
  [ "${#rules[@]}" -gt 0 ]

  unmatched=""
  while IFS= read -r cmd; do
    case "$cmd" in
      *api.clickup.com*|*/api/v4/*|*api.bitbucket.org*) ;;
      *) continue ;;
    esac
    matched=0
    for rule in "${rules[@]}"; do
      # shellcheck disable=SC2053
      if [[ "$cmd" == $rule ]]; then matched=1; break; fi
    done
    [ "$matched" -eq 1 ] || unmatched="${unmatched}${cmd}"$'\n'
  done < <(curl_commands "$REPO_ROOT"/.claude/commands/*.md)

  if [ -n "$unmatched" ]; then
    echo "curl commands with no matching allowlist rule (each becomes a permission prompt):"
    echo "$unmatched"
  fi
  [ -z "$unmatched" ]
}
