'use strict';

// A fingerprint says "this is the same defect" across runs, so a bug is filed once and later runs add to it.
//   fingerprint = sha1(identity | errorKind | signature)[0:12]
// identity  = ticket/caseId when the test name carries them (survives renames and file moves), else file|title
// signature = the error message with volatile parts masked (see lib/text.js)
// The tracker token is ONE alphanumeric word: tracker search tokenizers split on hyphens and punctuation.
const crypto = require('crypto');
const { normalizeSignature, baseName } = require('./lib/text');

const normalizeTitle = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

function identity(test) {
  if (test.ticket && test.caseId) return `${test.ticket}/${test.caseId}`;
  if (test.caseId) return `${baseName(test.file)}|${test.caseId}`;
  return `${baseName(test.file)}|${normalizeTitle(test.name)}`;
}

function fingerprint(test) {
  const error = test.error || {};
  const signature = normalizeSignature(error.message);
  const hash = crypto.createHash('sha1').update([identity(test), error.kind || 'failure', signature].join('|')).digest('hex').slice(0, 12);
  return { fingerprint: hash, token: `qafp${hash}`, identity: identity(test), signature };
}

module.exports = { fingerprint, identity, normalizeTitle };
