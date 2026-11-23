'use strict';
// A child process for the kill-mid-batch test: runs post-tests against the file-backed mock, and when told to, kills ITSELF with SIGKILL right after
// the Nth create was committed on the "tracker" and before it could hear the answer. Usage: node post-and-die.js <state file> <die after N creates | 0> <post-tests args...>
const { main } = require('../../../scripts/tracker/post-tests');
const { fileBackedGithub } = require('./file-backed-mock');

const [, , stateFile, dieAfter, ...argv] = process.argv;
let creates = 0;
const mock = fileBackedGithub(stateFile, {
  onRequest: ({ method, path }) => {
    if (method === 'POST' && /\/issues$/.test(path) && ++creates === Number(dieAfter)) process.kill(process.pid, 'SIGKILL');
  },
});
main({ argv: [...argv, '--base-url', mock.baseUrl], env: { GITHUB_TOKEN: mock.token }, fetch: mock.fetch }).then((code) => { process.exitCode = code; });
