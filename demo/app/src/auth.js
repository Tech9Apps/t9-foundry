'use strict';

const crypto = require('crypto');

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

// Demo only — real systems use a slow password hash (bcrypt/argon2).
const hash = (password) => crypto.createHash('sha256').update(password).digest('hex');

function createAuth({ now = Date.now } = {}) {
  const users = new Map([
    ['ada@brewandco.test', { name: 'Ada', passwordHash: hash('espresso123') }],
    ['ben@brewandco.test', { name: 'Ben', passwordHash: hash('pourover456') }],
  ]);
  const attempts = new Map(); // email -> { failures, lockedUntil }
  const sessions = new Map(); // token -> email

  function login(emailRaw, passwordRaw) {
    const email = String(emailRaw || '').trim().toLowerCase();
    const password = String(passwordRaw || '');
    const state = attempts.get(email) || { failures: 0, lockedUntil: 0 };

    if (state.lockedUntil > now()) {
      return { ok: false, status: 423, code: 'ACCOUNT_LOCKED', message: 'Account locked. Try again in 15 minutes.' };
    }
    if (state.lockedUntil) {
      state.failures = 0;
      state.lockedUntil = 0;
    }

    const user = users.get(email);
    if (!user || user.passwordHash !== hash(password)) {
      state.failures += 1;
      if (state.failures >= MAX_FAILED_ATTEMPTS) state.lockedUntil = now() + LOCK_MS;
      attempts.set(email, state);
      // Same response for unknown email and wrong password: no account enumeration.
      return { ok: false, status: 401, code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' };
    }

    attempts.delete(email);
    const token = crypto.randomUUID();
    sessions.set(token, email);
    return { ok: true, token, user: { email, name: user.name } };
  }

  return { login, authenticate: (token) => sessions.get(token) || null };
}

module.exports = { createAuth, MAX_FAILED_ATTEMPTS, LOCK_MS };
