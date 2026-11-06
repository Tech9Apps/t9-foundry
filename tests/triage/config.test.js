'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Ajv = require('../node_modules/ajv');
const { triageConfig, validate, DEFAULTS, MAX_RERUNS, FORMATS } = require('../../scripts/triage/lib/config');
const { FORMATS: NORMALIZER_FORMATS } = require('../../scripts/results/normalize');

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qa-cfg-'));
const write = (obj) => { const f = path.join(dir, `c-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const fails = (triage, re) => assert.throws(() => validate(triage, 'cfg'), (e) => e.isUsage && re.test(e.message), JSON.stringify(triage));

describe('triage config: values', () => {
  test('a config with no triage block gives the documented defaults', () => {
    const c = triageConfig({ configPath: write({ project: { name: 'x' } }) });
    assert.equal(c.reruns, 2);
    assert.equal(c.confidenceThreshold, 0.8);
    assert.deepEqual(c.selfHeal, { enabled: false, paths: null, maxFiles: 5, maxLines: 20, branchPrefix: 'qa/heal-' });
    assert.deepEqual(c.trustedFormats, ['tap']);
    assert.deepEqual(c.explicit, { reruns: false, confidenceThreshold: false, trustedFormats: false });
    assert.deepEqual([DEFAULTS.reruns, DEFAULTS.confidenceThreshold, MAX_RERUNS], [2, 0.8, 5]);
  });

  test('set values win, and are reported as explicit', () => {
    const c = triageConfig({ configPath: write({ triage: { reruns: 4, confidenceThreshold: 0.9, selfHeal: { enabled: true, maxFiles: 2, maxLines: 7, branchPrefix: 'qa/fix-', paths: ['e2e'] } } }) });
    assert.deepEqual([c.reruns, c.confidenceThreshold], [4, 0.9]);
    assert.deepEqual(c.selfHeal, { enabled: true, paths: ['e2e'], maxFiles: 2, maxLines: 7, branchPrefix: 'qa/fix-' });
    assert.deepEqual(c.explicit, { reruns: true, confidenceThreshold: true, trustedFormats: false });
  });

  test('trusted formats: the default is tap only; a list in the config wins and is reported as explicit; the caller\'s copy cannot change the default', () => {
    const d = triageConfig({ configPath: write({}) });
    assert.deepEqual(d.trustedFormats, ['tap']);
    d.trustedFormats.push('junit');
    assert.deepEqual(triageConfig({ configPath: write({}) }).trustedFormats, ['tap'], 'mutating a result must not widen the default for the next caller');
    assert.deepEqual(DEFAULTS.trustedFormats, ['tap']);
    const c = triageConfig({ configPath: write({ triage: { trustedFormats: ['tap', 'playwright-json'] } }) });
    assert.deepEqual(c.trustedFormats, ['tap', 'playwright-json']);
    assert.equal(c.explicit.trustedFormats, true);
    assert.deepEqual(triageConfig({ configPath: write({ triage: { trustedFormats: [] } }) }).trustedFormats, [], 'an empty list is a real setting: nothing may act');
  });

  test('0 re-runs is a real setting, not "unset" (the zero must not fall back to the default)', () => {
    const c = triageConfig({ configPath: write({ triage: { reruns: 0 } }) });
    assert.equal(c.reruns, 0);
    assert.equal(c.explicit.reruns, true);
  });

  test('self-heal paths default to testFramework.testDir, and an explicit list overrides it', () => {
    assert.deepEqual(triageConfig({ configPath: write({ testFramework: { testDir: 'tests/e2e' } }) }).selfHeal.paths, ['tests/e2e']);
    assert.deepEqual(triageConfig({ configPath: write({ testFramework: { testDir: 'tests/e2e' }, triage: { selfHeal: { paths: ['pages'] } } }) }).selfHeal.paths, ['pages']);
    assert.equal(triageConfig({ configPath: write({}) }).selfHeal.paths, null);
  });
});

describe('triage config: validation names the key', () => {
  test('re-runs: whole numbers from 0 to 5', () => {
    for (const bad of [-1, 6, 1.5, '2', null, NaN]) fails({ reruns: bad }, /"triage\.reruns" must be a whole number from 0 to 5/);
    for (const ok of [0, 1, 5]) assert.doesNotThrow(() => validate({ reruns: ok }, 'cfg'));
  });
  test('threshold: above 0, at most 1', () => {
    for (const bad of [0, -0.1, 1.01, '0.8', null]) fails({ confidenceThreshold: bad }, /"triage\.confidenceThreshold" must be a number above 0 and at most 1/);
    for (const ok of [0.01, 0.8, 1]) assert.doesNotThrow(() => validate({ confidenceThreshold: ok }, 'cfg'));
  });
  test('self-heal settings are bounded', () => {
    fails({ selfHeal: { enabled: 'yes' } }, /selfHeal\.enabled" must be true or false/);
    fails({ selfHeal: { maxFiles: 0 } }, /selfHeal\.maxFiles" must be a whole number from 1 to 20/);
    fails({ selfHeal: { maxFiles: 21 } }, /selfHeal\.maxFiles/);
    fails({ selfHeal: { maxLines: 201 } }, /selfHeal\.maxLines" must be a whole number from 1 to 200/);
    fails({ selfHeal: { paths: 'tests' } }, /selfHeal\.paths" must be a list/);
    fails({ selfHeal: { paths: [''] } }, /selfHeal\.paths/);
  });
  test('heal branches must live under qa/ (so they can never be a default branch)', () => {
    for (const bad of ['main', 'heal-', 'feature/x', '', 'qa/has space', '/qa/x', 'qa/../main']) fails({ selfHeal: { branchPrefix: bad } }, /branchPrefix" must start with "qa\//);
    for (const ok of ['qa/heal-', 'qa/', 'qa/fix_1.x-']) assert.doesNotThrow(() => validate({ selfHeal: { branchPrefix: ok } }, 'cfg'));
  });
  test('an unknown key is an error that lists the known ones (a typo must not silently do nothing)', () => {
    fails({ rerun: 3 }, /unknown key "triage\.rerun" \(known: reruns, confidenceThreshold, trustedFormats, selfHeal\)/);
    fails({ selfHeal: { enable: true } }, /unknown key "triage\.selfHeal\.enable"/);
  });
  test('trusted formats: only known formats, each once, in a list', () => {
    fails({ trustedFormats: ['playwrite-json'] }, /"triage\.trustedFormats" must be a list of distinct formats from: junit, tap, playwright-json, jest-json/);
    fails({ trustedFormats: ['tap', 'tap'] }, /"triage\.trustedFormats"/);
    fails({ trustedFormats: 'tap' }, /"triage\.trustedFormats"/);
    fails({ trustedFormats: [1] }, /"triage\.trustedFormats"/);
    assert.doesNotThrow(() => validate({ trustedFormats: [] }, 'cfg'));
  });
  test('"triage": null is rejected, as the schema rejects it (it used to read as "no triage block")', () => {
    fails(null, /"triage" must be an object/);
    assert.doesNotThrow(() => validate(undefined, 'cfg'), 'absent is fine');
  });
  test('the format list is one list: the loader, the normalizer that produces the formats, and qa-config.schema.json agree', () => {
    assert.deepEqual([...FORMATS].sort(), [...NORMALIZER_FORMATS].sort());
    const schema = require('../../qa-config.schema.json').properties.triage.properties.trustedFormats;
    assert.deepEqual([...schema.items.enum].sort(), [...FORMATS].sort());
    assert.deepEqual(schema.default, DEFAULTS.trustedFormats);
  });
  test('wrong shapes', () => {
    fails([], /"triage" must be an object/);
    fails({ selfHeal: [] }, /"triage\.selfHeal" must be an object/);
    fails({ selfHeal: null }, /"triage\.selfHeal" must be an object/);
  });
  test('an unreadable config file is a usage error naming the file', () => {
    const f = path.join(dir, 'broken.json'); fs.writeFileSync(f, '{nope');
    assert.throws(() => triageConfig({ configPath: f }), (e) => e.isUsage && e.message.includes('broken.json'));
  });
});

describe('the schema and the loader agree', () => {
  const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(require('../../qa-config.schema.json'));
  const base = { project: { name: 'x' }, ticketSource: { type: 'none' }, codeRepository: { type: 'local' }, environments: { testEnvironmentBaseUrl: 'https://staging.example.test' }, productionProtection: { prodUrlPatterns: ['prod'] } };
  const accepts = (triage) => validateSchema({ ...base, triage });

  test('everything the loader accepts, the schema accepts — and the reverse', () => {
    const cases = [
      [{ reruns: 0 }, true], [{ reruns: 5 }, true], [{ reruns: 6 }, false], [{ reruns: 1.5 }, false], [{ reruns: -1 }, false],
      [{ confidenceThreshold: 1 }, true], [{ confidenceThreshold: 0 }, false], [{ confidenceThreshold: 1.1 }, false],
      [{ selfHeal: { enabled: true, maxFiles: 20, maxLines: 200, branchPrefix: 'qa/heal-', paths: ['e2e'] } }, true],
      [{ selfHeal: { maxFiles: 21 } }, false], [{ selfHeal: { maxLines: 0 } }, false], [{ selfHeal: { branchPrefix: 'main' } }, false],
      [{ selfHeal: { paths: [] } }, true], [{ selfHeal: { enable: true } }, false], [{ rerun: 2 }, false], [{ selfHeal: { enabled: 'yes' } }, false],
    ];
    for (const [triage, ok] of cases) {
      assert.equal(accepts(triage), ok, `schema: ${JSON.stringify(triage)}`);
      let loaderOk = true;
      try { validate(triage, 'cfg'); } catch { loaderOk = false; }
      // the one deliberate difference: the loader also requires each path to be a non-empty string, the schema an empty list is fine either way
      assert.equal(loaderOk, ok, `loader: ${JSON.stringify(triage)}`);
    }
  });
  test('the defaults the schema documents are the defaults the code uses', () => {
    const t = require('../../qa-config.schema.json').properties.triage.properties;
    assert.equal(t.reruns.default, DEFAULTS.reruns);
    assert.equal(t.reruns.maximum, MAX_RERUNS);
    assert.equal(t.confidenceThreshold.default, DEFAULTS.confidenceThreshold);
    for (const k of ['enabled', 'maxFiles', 'maxLines', 'branchPrefix']) assert.equal(t.selfHeal.properties[k].default, DEFAULTS.selfHeal[k], k);
    assert.equal(t.selfHeal.properties.maxFiles.maximum, 20);
    assert.equal(t.selfHeal.properties.maxLines.maximum, 200);
  });

  test('no triage block at all is valid', () => {
    assert.ok(validateSchema(base), JSON.stringify(validateSchema.errors));
  });
});
