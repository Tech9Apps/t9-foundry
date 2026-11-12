'use strict';

const { TrackerError } = require('./errors');
const { escapeRe } = require('../../lib/regex');

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

// The shapes schemas/tracker-inputs.schema.json declares, enforced here (tests/tracker/inputs.test.js holds the two to the same answers). An id goes into a
// URL path, `limit` into a query string: without these checks "10&page=9" and "../../list/999/task?x=" went straight through.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const TC_ID = /^TC-[A-Za-z0-9-]+$/;
const KINDS = ['any', 'bug', 'test'];
const bad = (field, what) => new TrackerError('VALIDATION', `${field} ${what}`);
const isId = (v) => (typeof v === 'string' && ID.test(v)) || (Number.isSafeInteger(v) && ID.test(String(v)));
const isText = (v) => typeof v === 'string';
const defined = (v) => v !== undefined;

function checkId(i, field) { if (!isId(i[field])) throw bad(field, 'must be a ticket id: letters, digits, "_" and "-" only (at most 64), or a number'); }
function checkText(i, field, { required = true } = {}) {
  if ((required || defined(i[field])) && !isText(i[field])) throw bad(field, 'must be text');
}
function checkPriority(i) { if (defined(i.priority) && !PRIORITIES.includes(i.priority)) throw bad('priority', `must be one of ${PRIORITIES.join(', ')}`); }

function validate(op, input) {
  const i = input || {};
  switch (op) {
    case 'fetch':
      requireFields(i, ['id'], 'fetch');
      checkId(i, 'id');
      break;
    case 'search':
      requireFields(i, ['query'], 'search');
      checkText(i, 'query');
      if (defined(i.kind) && !KINDS.includes(i.kind)) throw bad('kind', `must be one of ${KINDS.join(', ')}`);
      if (defined(i.limit) && !(Number.isInteger(i.limit) && i.limit >= 1 && i.limit <= 100)) throw bad('limit', 'must be a whole number from 1 to 100');
      break;
    case 'create-test':
      requireFields(i, ['parentId', 'tcId', 'title'], 'create-test');
      checkId(i, 'parentId');
      if (!isText(i.tcId) || !TC_ID.test(i.tcId)) throw bad('tcId', 'must look like TC-001 (TC- then letters, digits or hyphens)');
      checkText(i, 'title');
      checkText(i, 'description', { required: false });
      checkPriority(i);
      if (defined(i.steps)) {
        if (!Array.isArray(i.steps)) throw bad('steps', 'must be an array of { action, expected }');
        i.steps.forEach((s, n) => {
          if (!s || typeof s !== 'object' || Array.isArray(s) || !isText(s.action) || (defined(s.expected) && !isText(s.expected))) throw bad(`steps[${n}]`, 'must be { action: text, expected?: text }');
        });
      }
      break;
    case 'link':
      requireFields(i, ['childId', 'parentId'], 'link');
      checkId(i, 'childId');
      checkId(i, 'parentId');
      break;
    case 'comment':
      requireFields(i, ['id', 'body'], 'comment');
      checkId(i, 'id');
      checkText(i, 'body');
      break;
    case 'create-bug':
      requireFields(i, ['title', 'body'], 'create-bug');
      checkText(i, 'title');
      checkText(i, 'body');
      checkPriority(i);
      if (defined(i.labels) && !(Array.isArray(i.labels) && i.labels.every(isText))) throw bad('labels', 'must be an array of text');
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
