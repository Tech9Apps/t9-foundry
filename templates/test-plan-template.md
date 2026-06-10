# Test Plan: [Ticket ID] — [Ticket Title]

**Ticket:** [TICKET-ID] — [URL]
**Author:** [QA Engineer Name]
**Date:** [YYYY-MM-DD]
**Status:** Draft | In Review | Approved

---

## Objective

[1-2 sentences: what this test plan validates and why it matters to the user]

---

## Scope

**In scope:**
- [Feature area or user flow 1]
- [Feature area or user flow 2]
- [API endpoints being tested]

**Out of scope:**
- [Related feature explicitly NOT tested here — and why]
- [Performance / load testing — covered separately]
- [Third-party service internals]

---

## Test Environment

| Property | Value |
|----------|-------|
| Environment | [staging / dev / qa] |
| Base URL | [from qa-config.json — NEVER production] |
| Test User | [describe what user account is needed] |
| Data State | [what baseline data must exist] |

> **Production is excluded.** Tests run only against the environment specified above.

---

## Test Types

| Type | Priority | Notes |
|------|----------|-------|
| Functional (happy path) | High | Core acceptance criteria |
| Negative / error cases | High | Invalid input, unauthorized access |
| Boundary / edge cases | Medium | Limits, empty states, max values |
| Regression | Medium | Known prior bugs in this area |
| Security (basic) | High if auth-related | OWASP basics, privilege escalation |
| Performance | Low | Only if ticket has perf requirements |

---

## Risk Areas

[From codebase analysis — highlight the code paths or data mutations that carry the most risk]

- **[Risk 1]:** [Description] — [why it's risky]
- **[Risk 2]:** [Description]

---

## Test Scenarios

[List of test scenario titles — these become the basis for individual test cases in /write-test-cases]

**Happy Path**
- TC-001: [User can successfully ...]
- TC-002: [System correctly returns ...]

**Negative Cases**
- TC-003: [Error shown when ...]
- TC-004: [User cannot access ... without ...]

**Boundary Cases**
- TC-005: [Maximum allowed ... is enforced]
- TC-006: [Empty/null ... is handled gracefully]

**Regression**
- TC-007: [Previously broken behavior: ...]

---

## Test Data Requirements

| Entity | Quantity | Notes |
|--------|----------|-------|
| [User with role X] | 1 | Created by DataFactory |
| [Order in state Y] | 2 | One complete, one pending |
| [Product with attribute Z] | 1 | Edge case data |

---

## Dependencies

- [ ] [Ticket TICKET-ID must be deployed to staging first]
- [ ] [External service X must be in test mode]
- [ ] [Auth token needed for test user]

---

## Automation Candidates

Scenarios marked for e2e automation (to be picked up by `/write-e2e-tests`):

- TC-001, TC-002, TC-003 (happy path + key negative)

Manual only (too complex to automate or low ROI):

- TC-007 (requires manual data state manipulation)

---

## Estimated Test Count

| Type | Count |
|------|-------|
| Automated e2e | ~5 |
| Manual | ~3 |
| Total | ~8 |
