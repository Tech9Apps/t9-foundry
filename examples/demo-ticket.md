# Demo Ticket: User Login Feature

**ID:** DEMO-001
**Type:** User Story
**Priority:** High
**Stack:** React SPA + Node.js REST API

---

## Summary

As a registered user, I want to log in with my email and password so that I can access my account dashboard.

## Description

The login flow consists of a React login form that POSTs credentials to `POST /api/auth/login`. On success, the API returns a JWT that is stored in an httpOnly cookie and the user is redirected to `/dashboard`. On failure, an error message is displayed inline.

### Acceptance Criteria

1. A user with valid credentials can submit the login form and be redirected to `/dashboard`.
2. A user with an incorrect password sees the error message "Invalid email or password" without any page reload.
3. A user with a non-existent email sees the same generic error message (no account enumeration).
4. The form is disabled and shows a loading state while the request is in flight.
5. After 5 consecutive failed attempts, the account is locked for 15 minutes and a specific "Account locked" message is displayed.
6. After a successful login, the back button does not allow re-submission of the form.
7. Session tokens expire after 30 minutes of inactivity; the user is then redirected to login with a "Session expired" toast.

## Technical Notes

- Login endpoint: `POST /api/auth/login` → `{ email, password }` → `{ token, user }`
- Auth token stored as `httpOnly` cookie named `auth_token`
- Rate limiting: 5 attempts per 15 minutes per IP, tracked in Redis
- Password hashing: bcrypt (cost factor 12)
- Frontend: React, form validation with react-hook-form, error state managed in component

## Known Risk Areas

- Account lockout logic is new and untested in staging
- The "session expired" redirect was reported as broken in a previous sprint
- Safari has had issues with the httpOnly cookie in cross-origin setups
