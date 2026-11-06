'use strict';

// Text turned into a pattern that matches exactly that text (RegExp.escape arrives in Node 24; the harness supports 22).
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = { escapeRe };
