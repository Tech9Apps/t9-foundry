'use strict';
// The GitHub tracker mock with its state kept in a FILE, so that a process can be killed and the next one sees what the tracker had by then.
// (The mocks are in-process, and the dev sandbox cannot bind ports; this is the same mock, written to disk after every request.)
const fs = require('node:fs');
const { createGithubMock } = require('../../mocks/tracker-mock/github');

const dump = (state) => ({ issues: [...state.issues], comments: [...state.comments], created: state.created, nextNumber: state.nextNumber, nextCommentId: state.nextCommentId, unindexed: [...state.unindexed] });
function restore(state, saved) {
  state.issues = new Map(saved.issues.map(([k, v]) => [Number(k), v]));
  state.comments = new Map(saved.comments.map(([k, v]) => [Number(k), v]));
  state.created = saved.created; state.nextNumber = saved.nextNumber; state.nextCommentId = saved.nextCommentId; state.unindexed = new Set(saved.unindexed);
}

// A mock backed by `file`. onRequest({ method, path, count }) runs AFTER the request was committed and saved, and before the caller hears the answer:
// the exact window in which a write has happened and nobody knows it.
function fileBackedGithub(file, { onRequest } = {}) {
  const mock = createGithubMock();
  if (fs.existsSync(file)) restore(mock.state, JSON.parse(fs.readFileSync(file, 'utf8')));
  const save = () => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(dump(mock.state))); fs.renameSync(tmp, file); };
  let count = 0;
  const fetch = async (url, init = {}) => {
    const res = await mock.fetch(url, init);
    save();
    count += 1;
    if (onRequest) onRequest({ method: (init.method || 'GET').toUpperCase(), path: new URL(url).pathname, count });
    return res;
  };
  return { ...mock, fetch, save };
}

module.exports = { fileBackedGithub, restore, dump };
