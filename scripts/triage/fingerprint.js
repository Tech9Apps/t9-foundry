'use strict';

// A fingerprint says "this is the same defect" across runs, so a bug is filed once and later runs add to it.
//   fingerprint = sha1(identity | errorKind | signature)[0:12]
// identity  = ticket/caseId when the test name carries them (survives renames and file moves), else file|title.
//             "file" is the file NAME only, on purpose: the fingerprint must survive a file being moved to another folder and be the same on every
//             machine. The price is that two same-named files in different folders, with the same test title AND the same error, share a fingerprint
//             (one report covers both). classify.js still keeps them as two separate verdicts; see makeKeyer there.
// signature = the error message plus what it says was expected/received, with volatile parts masked (see lib/text.js)
// The tracker token is ONE alphanumeric word: tracker search tokenizers split on hyphens and punctuation.
const crypto = require('crypto');
const { signatureOf, baseName } = require('./lib/text');

const normalizeTitle = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

const pathTail = (p, n = 2) => String(p || '').split(/[\\/]+/).filter(Boolean).slice(-n).join('/');

function identity(test) {
  if (test.ticket && test.caseId) return `${test.ticket}/${test.caseId}`;
  if (test.caseId) return `${baseName(test.file)}|${test.caseId}`;
  return `${baseName(test.file)}|${normalizeTitle(test.name)}`;
}

function fingerprint(test) {
  const error = test.error || {};
  const signature = signatureOf(error);
  const hash = crypto.createHash('sha1').update([identity(test), error.kind || 'failure', signature].join('|')).digest('hex').slice(0, 12);
  return { fingerprint: hash, token: `qafp${hash}`, identity: identity(test), signature };
}

module.exports = { fingerprint, identity, normalizeTitle, pathTail };
