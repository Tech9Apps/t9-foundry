'use strict';

const { TrackerError } = require('./errors');

const OPERATIONS = ['fetch', 'search', 'create-test', 'link', 'comment', 'create-bug'];
const PRIORITIES = ['High', 'Medium', 'Low'];

// Idempotency: a create call may carry `idempotencyKey`. The adapter embeds a marker for the
// key in what it creates and, before creating, looks for an existing item carrying it — so a
// retried create (after a timeout, a crash, a re-run) returns the original instead of a duplicate.
const KEY_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;

function assertKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    throw new TrackerError('VALIDATION', 'idempotencyKey must be 1-80 characters of letters, digits, ".", "_" or "-"');
  }
  return key;
}

const keyMarker = (key) => `qa-harness-key:${assertKey(key)}`;
// Trackers that expose tags/labels as a searchable field use this token form instead.
const keyTag = (key) => `qa-key-${assertKey(key)}`;

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A key must be matched as a WHOLE key. Plain `text.includes(marker)` treats the key "bug-1" as present in text that holds "bug-10", so the
// second create silently returned the first item and the second bug was never filed. The marker must END where the key ends: the next
// character may not be one a key can contain.
const hasMarker = (text, key) => new RegExp(`${escapeRe(keyMarker(key))}(?![A-Za-z0-9._-])`).test(String(text == null ? '' : text));
// Tag lists (Azure: "a; b; c"): exact, case-insensitive tag equality.
const hasTag = (tagField, key) => String(tagField || '').split(';').map((t) => t.trim().toLowerCase()).includes(keyTag(key).toLowerCase());

function requireFields(input, fields, what) {
  const missing = fields.filter((f) => input == null || input[f] === undefined || input[f] === null || input[f] === '');
  if (missing.length) throw new TrackerError('VALIDATION', `${what} requires: ${missing.join(', ')}`);
}

function validate(op, input) {
  const i = input || {};
  switch (op) {
    case 'fetch': requireFields(i, ['id'], 'fetch'); break;
    case 'search': requireFields(i, ['query'], 'search'); break;
    case 'create-test':
      requireFields(i, ['parentId', 'tcId', 'title'], 'create-test');
      if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) throw new TrackerError('VALIDATION', `priority must be one of ${PRIORITIES.join(', ')}`);
      if (i.steps !== undefined && !Array.isArray(i.steps)) throw new TrackerError('VALIDATION', 'steps must be an array of { action, expected }');
      break;
    case 'link': requireFields(i, ['childId', 'parentId'], 'link'); break;
    case 'comment': requireFields(i, ['id', 'body'], 'comment'); break;
    case 'create-bug':
      requireFields(i, ['title', 'body'], 'create-bug');
      if (i.priority !== undefined && !PRIORITIES.includes(i.priority)) throw new TrackerError('VALIDATION', `priority must be one of ${PRIORITIES.join(', ')}`);
      break;
    default:
      throw new TrackerError('VALIDATION', `unknown operation "${op}" (expected one of ${OPERATIONS.join(', ')})`);
  }
  if (i.idempotencyKey !== undefined) assertKey(i.idempotencyKey);
  return i;
}

// "1. <action> — Expected: <expected>" lines, for trackers with no structured steps field.
function stepsAsMarkdown(steps = []) {
  return steps.map((s, n) => `${n + 1}. ${s.action}${s.expected ? ` — Expected: ${s.expected}` : ''}`).join('\n');
}

// Pull the "Acceptance Criteria" section out of free text (markdown heading or "Acceptance Criteria:" label).
function extractAcceptanceCriteria(text = '') {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*(#{1,6}\s*)?\**acceptance criteria\**\s*:?\s*$/i.test(l));
  if (start === -1) return '';
  const out = [];
  for (let n = start + 1; n < lines.length; n += 1) {
    if (/^\s*#{1,6}\s+\S/.test(lines[n])) break; // next heading ends the section
    out.push(lines[n]);
  }
  return out.join('\n').trim();
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = {
  OPERATIONS, PRIORITIES, validate, requireFields, keyMarker, keyTag, hasMarker, hasTag, assertKey,
  stepsAsMarkdown, extractAcceptanceCriteria, stripHtml, escapeXml,
};
