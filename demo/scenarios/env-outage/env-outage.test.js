'use strict';
// SEEDED SCENARIO: environment outage. The test environment's host cannot be reached. ".invalid" is a reserved
// top-level domain that never resolves (RFC 2606), so this is a real name-resolution failure — the same error a
// test sees when staging is down — with no dependence on any network being up. Expected triage: environment (ENV-2).

const test = require('node:test');
const http = require('node:http');

const BASE_URL = process.env.QA_SCENARIO_BASE_URL || 'http://qa-outage.invalid';

test('DEMO-103/TC-903: the sign-in page is reachable', () => new Promise((resolve, reject) => {
  http.get(`${BASE_URL}/`, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
}));
