# Result fixtures

| File | Source |
|---|---|
| `node-test.tap`, `node-test.junit.xml` | **Real output** of `node --test` on `demo/app` (22 tests, 2 planted failures). Only the absolute path was rewritten to `/work/…`. |
| `node-hook-failure.tap` | **Real output** of `node --test --test-reporter=tap` (Node 22.17) on a file with one suite whose `after` hook throws (its child passes: `failureType: 'hookFailed'`) and one suite with a failing child (`failureType: 'subtestsFailed'`). Only the absolute path was rewritten to `/work/…`. |
| everything else | **Hand-written from memory** of each tool's report schema — representative, not captured from a live run. They pin what the parsers do with the documented shape; confirm against a real run of the tool before relying on a quirk. |

Never name a fixture `qa-config.json` (it is git-ignored everywhere in this repo).
