'use strict';

// One recipe per test framework: how to run it so it ALSO writes a structured report we can parse, instead
// of scraping its console summary. Pure: no I/O, so it is easy to test and to print with --dry-run.
//
// plan({ framework, outDir, testDir, configPath, specs, headed })
//   -> { command, args, env, results, format, notes }
//        results = the file (or directory) the run will write      format = normalize.js format hint
//
// Arguments are an array and the runner is spawned without a shell, so paths and spec names are never
// interpreted by one.

const SUPPORTED = ['playwright', 'cypress', 'pytest', 'rspec', 'jest', 'webdriverio', 'node'];

const path = require('path');

function plan({ framework, outDir, testDir, configPath, specs = [], headed = false }) {
  const out = path.resolve(outDir);
  const file = (name) => path.join(out, name);
  const targets = specs.length ? specs : (testDir ? [testDir] : []);
  const notes = [];

  switch (framework) {
    case 'playwright':
      return {
        command: 'npx',
        args: ['playwright', 'test', ...specs, ...(configPath ? ['--config', configPath] : []), ...(headed ? ['--headed'] : []), '--reporter=list,json'],
        env: { PLAYWRIGHT_JSON_OUTPUT_NAME: file('results.json') },
        results: file('results.json'),
        format: 'playwright-json',
        notes: ['--reporter=list,json overrides the reporter in playwright.config; add your own reporters there if you need more (e.g. html)'],
      };
    case 'cypress':
      return {
        command: 'npx',
        args: ['cypress', 'run', ...(configPath ? ['--config-file', configPath] : []), ...(specs.length ? ['--spec', specs.join(',')] : []),
          '--reporter', 'junit', '--reporter-options', `mochaFile=${file('results-[hash].xml')},toConsole=false`],
        env: {},
        results: out,
        format: 'junit',
        notes: ['Cypress replaces its console reporter with junit for this run, so the console shows little; read the normalized result instead'],
      };
    case 'pytest':
      return { command: 'python', args: ['-m', 'pytest', ...targets, '-v', `--junitxml=${file('results.xml')}`], env: {}, results: file('results.xml'), format: 'junit', notes };
    case 'rspec':
      return {
        command: 'bundle',
        args: ['exec', 'rspec', ...targets, '--format', 'progress', '--format', 'RspecJunitFormatter', '--out', file('results.xml')],
        env: {},
        results: file('results.xml'),
        format: 'junit',
        notes: ['needs the rspec_junit_formatter gem in the Gemfile'],
      };
    case 'jest':
      return { command: 'npx', args: ['jest', ...targets, '--verbose', '--json', `--outputFile=${file('results.json')}`], env: {}, results: file('results.json'), format: 'jest-json', notes };
    case 'webdriverio':
      return {
        command: 'npx',
        args: ['wdio', ...(configPath ? [configPath] : []), ...(specs.length ? ['--spec', ...specs] : [])],
        env: { QA_RESULTS_DIR: out },
        results: out,
        format: 'junit',
        notes: ["the wdio config must include the junit reporter writing to process.env.QA_RESULTS_DIR: reporters: ['spec', ['junit', { outputDir: process.env.QA_RESULTS_DIR }]]  (install @wdio/junit-reporter)"],
      };
    case 'node':
      return {
        command: 'node',
        // options must precede the files: anything after a file name is handed to the test file, not to node.
        // TAP, not JUnit: node's JUnit has no file location, and re-running only the failing specs needs one.
        args: ['--test', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=tap', `--test-reporter-destination=${file('results.tap')}`, ...specs],
        env: {},
        results: file('results.tap'),
        format: 'tap',
        notes: ['runs from --cwd; Node 22 takes files, not directories, so pass --spec or let it discover test files'],
      };
    default:
      return null;
  }
}

module.exports = { plan, SUPPORTED };
