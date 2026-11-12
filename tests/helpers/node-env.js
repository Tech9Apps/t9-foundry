'use strict';
// The environment for a child process that runs `node --test` (or code that does). A test run exports NODE_TEST_CONTEXT, and a nested
// `node --test` that inherits it thinks it is part of that run and reports nothing of its own: a mutation check then "survives" everything and
// a real run looks green without running. Every test that starts such a child builds its environment here, so none can forget to drop it.
module.exports.cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
};
