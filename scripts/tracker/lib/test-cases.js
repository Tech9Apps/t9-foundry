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

function parseTestCases(md) {
  return String(md).split(/^### (?=TC-\d+:)/m).slice(1).map((block) => {
    const [head, ...rest] = block.split('\n');
    const [, tcId, title] = head.match(/^(TC-\d+): (.+)$/);
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
  });
}

module.exports = { parseTestCases };
