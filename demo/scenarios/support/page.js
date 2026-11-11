'use strict';

// A minimal stand-in for a browser page, so a UI-style test can run with no browser and no install: it reads the
// app's REAL index.html and offers getByTestId(). A test-id that is not in the page throws, the way a UI test tool
// reports a locator that matches nothing.
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', '..', 'app', 'public', 'index.html');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function openPage() {
  const html = fs.readFileSync(INDEX, 'utf8');
  return {
    html,
    getByTestId(id) {
      if (!new RegExp(`data-testid=["']${escapeRe(id)}["']`).test(html)) throw new Error(`locator not found: getByTestId('${id}')`);
      return { id };
    },
  };
}

module.exports = { openPage, INDEX };
