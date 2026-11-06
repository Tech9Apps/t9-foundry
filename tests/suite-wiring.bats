#!/usr/bin/env bats
# A test that nothing runs proves nothing. These fail when a test file exists but is not wired into run-tests.sh (and so not into CI):
# four node test files, including the credential-redaction tests, went unrun that way until this check existed.

REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/.." && pwd)"

@test "every .bats file in tests/ is run by run-tests.sh" {
  cd "$REPO_ROOT"
  missing=""
  for f in tests/*.bats; do grep -q "$f" tests/run-tests.sh || missing="$missing $f"; done
  [ -z "$missing" ] || { echo "not run by tests/run-tests.sh:$missing"; false; }
}

@test "every node test file (*.test.js) is run by some .bats file" {
  cd "$REPO_ROOT"
  missing=""
  for f in $(find tests -name '*.test.js' -not -path '*/node_modules/*' -not -path 'tests/fixtures/*'); do
    grep -q "$(basename "$f")" tests/*.bats || missing="$missing $f"
  done
  [ -z "$missing" ] || { echo "not run by any .bats file:$missing"; false; }
}
