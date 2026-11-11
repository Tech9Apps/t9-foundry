'use strict';

// Parser for the harness's manual test-case markdown (the format defined in
// .claude/commands/create-manual-test-cases.md):
//
//   ### TC-001: Title
//   - **Priority:** High
//   - **Type:** Positive
//   - **Description:** ...
//   - **Steps:** 1. ... 2. ...            (inline, or one numbered item per line)
//   - **Expected Result:** ...
//   - **Traceability:** DEMO-101 AC1
//
// -> { tcId, title, priority, description, steps: [{ action, expected }] }
//
// Steps in this format have ONE expected result for the whole case, so it is attached to the last step.

function fieldOf(body, name) {
  const m = body.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*([\\s\\S]*?)(?=\\n- \\*\\*|\\n###|$(?![\\s\\S]))`, 'm'));
  return m ? m[1].replace(/\s*\n\s*/g, ' ').trim() : '';
}

// What is wrong with a cases file, as a list of sentences. parseTestCases reads the cases it can; posting only those would report "ok" while a case is
// silently missing, and a repeated id would make the second case come back as "already existed" (both pointing at the first one's issue). So the file
// is refused as a whole, before anything is created, if any line that LOOKS like a case header is not a valid one, or an id is used twice.
// Windows line endings are read as line endings: "." does not match a carriage return, so "### TC-001: Title\r" is not a header to a regex that ends in ".*$".
const lines = (md) => String(md).replace(/\r\n?/g, '\n').split('\n');
const CASE_HEADER = /^### (TC-\d+): (\S.*)$/;
const LOOKS_LIKE_HEADER = /^###[ \t]*TC[-_ ]?\d/i;
function lintTestCases(md) {
  const problems = [];
  const seen = new Map();
  lines(md).forEach((line, i) => {
    if (!LOOKS_LIKE_HEADER.test(line)) return;
    const m = CASE_HEADER.exec(line);
    if (!m) { problems.push(`line ${i + 1}: "${line.trim()}" is not a case header (expected "### TC-001: Title")`); return; }
    if (seen.has(m[1])) problems.push(`${m[1]} appears twice (lines ${seen.get(m[1])} and ${i + 1})`);
    else seen.set(m[1], i + 1);
  });
  return problems;
}

function parseTestCases(md) {
  return lines(md).join('\n').split(/^### (?=TC-\d+:)/m).slice(1).map((block) => {
    const [head, ...rest] = block.split('\n');
    const header = head.match(/^(TC-\d+): (\S.*)$/);
    if (!header) return null; // lintTestCases reports it; reading must not crash on it
    const [, tcId, title] = header;
    const body = rest.join('\n');

    const priority = (fieldOf(body, 'Priority').match(/^(High|Medium|Low)/) || [])[1];
    const actions = fieldOf(body, 'Steps').split(/(?:^|\s)\d+\.\s+/).map((s) => s.trim()).filter(Boolean);
    const steps = actions.map((action) => ({ action: action.replace(/[.;]$/, ''), expected: '' }));
    if (steps.length) steps[steps.length - 1].expected = fieldOf(body, 'Expected Result');

    const testData = fieldOf(body, 'Test data');
    const trace = fieldOf(body, 'Traceability');
    const description = [fieldOf(body, 'Description'), testData && `Test data: ${testData}`, trace && `Traceability: ${trace}`]
      .filter(Boolean).join('\n\n');

    return { tcId, title: title.trim(), priority, description, steps };
  }).filter(Boolean);
}

module.exports = { parseTestCases, lintTestCases };
