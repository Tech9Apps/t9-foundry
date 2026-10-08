'use strict';
// A throwaway workspace for exercising post-tests.js / cli.js against an in-process mock tracker:
// a config, a copy of a test-cases file, a seeded parent ticket, and a post() helper that runs the
// real command with the mock's fetch injected. Shared by the unit tests and by evals/run.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../../scripts/tracker/post-tests');
const { createGithubMock } = require('../mocks/tracker-mock/github');
const { createClickupMock } = require('../mocks/tracker-mock/clickup');
const { createAzureMock } = require('../mocks/tracker-mock/azure');

const MOCKS = { github: createGithubMock, clickup: createClickupMock, azure: createAzureMock };

function workspace(type, { casesFile, title = 'DEMO-101: Apply a discount code', description = 'story', acceptance = '1. a', parentName = 'DEMO-101' }) {
  const mock = MOCKS[type]();
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-post-'));
  const config = path.join(dir, 'qa-config.json');
  fs.writeFileSync(config, JSON.stringify({ ticketSource: { type, [type]: mock.settings } }));
  const cases = path.join(dir, `${parentName}.md`);
  fs.copyFileSync(casesFile, cases);
  const keysFile = path.join(dir, 'keys', `${parentName}-test-keys.json`);
  const parent = mock.seedTicket({ title, description, acceptance });

  async function post(extra = [], { env, parentId = parent } = {}) {
    let out = ''; let err = '';
    const code = await main({
      argv: ['--parent', parentId, '--cases', cases, '--keys-file', keysFile, '--config', config, '--base-url', mock.baseUrl, ...extra],
      env: env || { [mock.tokenEnv]: mock.token }, fetch: mock.fetch, now: () => Date.UTC(2026, 0, 2),
      stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
    });
    return { code, out, err, json: out ? JSON.parse(out) : null };
  }
  const keys = () => JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  return { type, mock, dir, config, cases, keysFile, parent, post, keys };
}

module.exports = { workspace, MOCKS };
