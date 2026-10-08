# Test Cases: DEMO-103 - Sign in with account lockout

> **Sample output.** TC-001…TC-006 are automated in `demo/app/test/login-lockout.test.js`; TC-007 is a UI check.
> All six automated cases pass on the demo app — a good reminder that a run's value is also "what is *not* broken".

## Ticket Summary
Sign in with email + password. Wrong or unknown credentials show one generic error. Five consecutive failures lock the
account for 15 minutes (even the correct password is refused); the lock lifts on its own; success resets the counter.

## Module / Feature
Accounts → Sign in (`POST /api/auth/login`, sign-in form in `public/index.html`)

## Preconditions
- App running; demo account `ada@brewandco.test`; a controllable clock is used for the 15-minute cases

## Test Cases

### TC-001: Valid credentials return a session token
- **Priority:** High · **Type:** Positive
- **Steps:** 1. Sign in with `ada@brewandco.test` and the correct password.
- **Expected Result:** HTTP 200; a token and the user's email are returned.
- **Selectors/Elements:** `login-email`, `login-password`, `login-submit`, `session-user`
- **Traceability:** DEMO-103 AC1

### TC-002: A wrong password shows the generic error
- **Priority:** High · **Type:** Negative
- **Steps:** 1. Sign in with a wrong password.
- **Expected Result:** HTTP 401; message exactly "Invalid email or password".
- **Selectors/Elements:** `login-error`
- **Traceability:** DEMO-103 AC2

### TC-003: An unknown email gets the same error (no account enumeration)
- **Priority:** High · **Type:** Negative (security)
- **Steps:** 1. Sign in as `nobody@brewandco.test`. 2. Sign in as `ada@…` with a wrong password. 3. Compare.
- **Expected Result:** Identical status and body for both.
- **Selectors/Elements:** `login-error`
- **Traceability:** DEMO-103 AC3

### TC-004: Five failed attempts lock the account, even for the right password
- **Priority:** High · **Type:** Negative / Edge Case
- **Steps:** 1. Fail 5 times. 2. Sign in with the correct password.
- **Expected Result:** HTTP 423, code `ACCOUNT_LOCKED`, "Account locked. Try again in 15 minutes."
- **Selectors/Elements:** `login-error`
- **Traceability:** DEMO-103 AC4

### TC-005: The lock lifts after 15 minutes
- **Priority:** High · **Type:** Edge Case (boundary)
- **Steps:** 1. Lock the account. 2. After 14 minutes try again (still locked). 3. After 15 minutes + 1 ms try again.
- **Expected Result:** Locked at 14 minutes; sign-in succeeds after 15.
- **Traceability:** DEMO-103 AC5

### TC-006: A successful sign-in resets the failed-attempt counter
- **Priority:** Medium · **Type:** Edge Case
- **Steps:** 1. Fail 4 times. 2. Sign in successfully. 3. Fail 4 more times. 4. Sign in successfully.
- **Expected Result:** Never locked — only 4 consecutive failures at any point.
- **Traceability:** DEMO-103 AC6

### TC-007: The sign-in button is disabled while the request is in flight
- **Priority:** Low · **Type:** UI Validation
- **Steps:** 1. Submit the form on a throttled connection. 2. Observe `login-submit`.
- **Expected Result:** Button disabled until the response arrives, then re-enabled.
- **Selectors/Elements:** `login-submit`
- **Traceability:** UI behavior — *manual / browser only*
