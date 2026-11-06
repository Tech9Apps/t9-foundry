# Result fixtures

| File | Source |
|---|---|
| `node-test.tap`, `node-test.junit.xml` | **Real output** of `node --test` on `demo/app` (22 tests, 2 planted failures). Only the absolute path was rewritten to `/work/…`. |
| `real/` | **Real output** of Jest 30.5.2 and Playwright 1.65.0 for a small demo app with known failure causes, with its source and a README saying what each failure is. |
| everything else | **Hand-written from memory** of each tool's report schema — representative, not captured from a live run. They pin what the parsers do with the documented shape; confirm against a real run of the tool before relying on a quirk. |

Never name a fixture `qa-config.json` (it is git-ignored everywhere in this repo).
