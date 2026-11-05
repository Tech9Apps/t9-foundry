# Sets PY to a Python 3 that actually RUNS, or leaves it empty. `python3` on macOS can be a shim that exists but fails (an unaccepted
# Xcode licence), so "is it installed" is the wrong question: run it. Used by tests that exercise the Python templates.
find_python() {
  PY=""
  local candidate
  for candidate in python3 /Library/Developer/CommandLineTools/usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(0)' >/dev/null 2>&1; then
      PY="$candidate"
      return 0
    fi
  done
  return 1
}
