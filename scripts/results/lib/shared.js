'use strict';

const MAX_DETAILS = 4000;
const ANSI = /\u001b\[[0-9;]*m/g;

const stripAnsi = (s) => String(s || '').replace(ANSI, '');
const truncate = (s, n = MAX_DETAILS) => (s.length > n ? `${s.slice(0, n)}\n… (truncated)` : s);
const firstLine = (s) => (String(s).split('\n').map((l) => l.trim()).find(Boolean) || '');

// "DEMO-101/TC-005: applies once" -> { ticket: 'DEMO-101', caseId: 'TC-005' }. Also accepts TC_005 (pytest
// function names cannot contain hyphens) and normalizes it to TC-005.
const ID = /(?:(?<![A-Za-z0-9])([A-Z][A-Z0-9]*-\d+)[/: ]\s*)?(?<![A-Za-z0-9])TC[-_](\d+)(?!\d)/;
function extractIds(name) {
  const m = String(name).match(ID);
  if (!m) return {};
  return { ...(m[1] ? { ticket: m[1] } : {}), caseId: `TC-${m[2]}` };
}

// "timeout", "timed out", "time-out"
const isTimeout = (s) => /time[ -]?(?:d[ -]?)?out/i.test(String(s));

function finish(format, tests, { framework, durationMs } = {}) {
  const withIds = tests.map((t) => ({ ...t, ...extractIds(t.name) }));
  const passed = withIds.filter((t) => t.status === 'passed').length;
  const failed = withIds.filter((t) => t.status === 'failed').length;
  const skipped = withIds.filter((t) => t.status === 'skipped').length;
  const flaky = withIds.filter((t) => t.flaky).length;
  const out = { format, ...(framework ? { framework } : {}), totals: { total: withIds.length, passed, failed, skipped, ...(flaky ? { flaky } : {}) }, tests: withIds };
  const total = durationMs !== undefined ? durationMs : withIds.reduce((n, t) => n + (t.durationMs || 0), 0);
  if (Number.isFinite(total) && total > 0) out.durationMs = Math.round(total * 1000) / 1000;
  return out;
}

module.exports = { stripAnsi, truncate, firstLine, extractIds, isTimeout, finish };
