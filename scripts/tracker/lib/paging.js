'use strict';

const { TrackerError } = require('./errors');

const PAGE_SIZE = 100;
const MAX_PAGES = 10; // 1000 comments

// Answers "is there an item matching `match` in this list?" by reading the list page by page (1, 2, ...).
//
//   readPage(page) -> { items, more }   `more` is whether another page may exist; it is only ever a signal, never a URL to fetch: the next request is
//                                       built by the adapter from its own base URL, so a "next" link in a response cannot steer the token elsewhere.
//
// Returns the first match, or null once the list has ended. If MAX_PAGES pages were read and the list goes on, the honest answer is neither: a "not
// found" would make the caller post a duplicate, so it stops with VALIDATION (not retriable: reading the same pages again changes nothing) and the
// caller posts nothing.
async function findInPages(readPage, match, what) {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { items, more } = await readPage(page);
    const hit = items.find(match);
    if (hit) return hit;
    if (!more) return null;
  }
  throw new TrackerError('VALIDATION', `${what}: there are more than ${MAX_PAGES * PAGE_SIZE} comments, so it cannot be confirmed whether this one was already posted. nothing was posted.`);
}

module.exports = { findInPages, PAGE_SIZE };
