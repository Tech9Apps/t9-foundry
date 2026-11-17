'use strict';
// A child process for the lock tests: runs post-tests against the file-backed mock, and after the Nth create was committed it says so (writes <ready file>) and
// then HANGS, as a run does when the tracker is slow, so that the test can send it a real signal. Usage: node post-and-hang.js <state file> <hang after N creates> <ready file> <post-tests args...>
const fs = require('node:fs');
const { main } = require('../../../scripts/tracker/post-tests');
const { fileBackedGithub } = require('./file-backed-mock');

const [, , stateFile, hangAfter, readyFile, ...argv] = process.argv;
let creates = 0;
const mock = fileBackedGithub(stateFile, {
  onRequest: ({ method, path }) => {
    if (method === 'POST' && /\/issues$/.test(path) && ++creates === Number(hangAfter)) { fs.writeFileSync(readyFile, '1'); setInterval(() => {}, 1000); return new Promise(() => {}); } // the timer keeps the process alive: an unsettled promise alone does not
    return undefined;
  },
});
main({ argv: [...argv, '--base-url', mock.baseUrl], env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch }).then((code) => { process.exitCode = code; });
