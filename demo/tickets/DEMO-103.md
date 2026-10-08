# DEMO-103: Sign in with account lockout

**Type:** User Story   **Priority:** Medium   **Component:** Accounts

## Summary

As a shopper, I want to sign in with my email and password, and as the business I want accounts locked after
repeated failures so that passwords can't be guessed.

### Acceptance Criteria

1. Valid credentials sign the shopper in and return a session token.
2. A wrong password shows the generic error "Invalid email or password".
3. An unknown email shows the **same** error (no account enumeration).
4. After 5 consecutive failed attempts the account is locked for 15 minutes; while locked, even the correct
   password is refused with "Account locked. Try again in 15 minutes."
5. The lock lifts automatically after 15 minutes.
6. A successful sign-in resets the failed-attempt counter.

## Technical Notes

- `POST /api/auth/login` with `{ email, password }` → `{ data: { token, user } }` or an error envelope
  (`INVALID_CREDENTIALS` 401, `ACCOUNT_LOCKED` 423).
- Demo accounts: `ada@brewandco.test` / `espresso123`, `ben@brewandco.test` / `pourover456`.

## Known Risk Areas

- Lockout logic is new and time-dependent — easy to get wrong at the 15-minute boundary.
