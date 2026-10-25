const test = require('node:test');
const assert = require('node:assert/strict');
const { HEADERS, submissionRows, toCsv } = require('../lib/submission-csv');

test('exports only submitted answers with the exact requested columns and escaped source', () => {
  const rows = submissionRows([{ id: 'attempt', name: 'Candidate', answers: {
    1: { code: 'print("x,y")\nprint("done")', languageName: 'Python 3', submittedAt: 1,
      testEvaluation: { passed: 2, total: 3, complete: true, results: [] } },
    2: { code: 'draft', languageName: 'Java', savedAt: 2 }
  } }], [{ id: 1, t: 'Example, question' }]);
  assert.deepEqual(HEADERS, ['Question ID', 'Question', 'Language', 'Source Code', 'Test Cases Passed', 'Test Cases Failed', 'Total Test Cases', 'Final Status']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].columns, ['1', 'Example, question', 'Python 3', 'print("x,y")\nprint("done")', 2, 1, 3, 'WRONG ANSWER']);
  assert.match(toCsv(rows), /"print\(""x,y""\)\nprint\(""done""\)"/);
});

test('preserves multiple attempts and reports compilation errors', () => {
  const rows = submissionRows([], [], [{ id: 'old', attemptId: 'a', user: 'A', questionId: 4, code: 'broken',
    language: 'Java', testEvaluation: { passed: 0, total: 3, complete: true,
      results: [{ status: 'Compilation Error' }, { status: 'Compilation Error' }, { status: 'Compilation Error' }] } }]);
  assert.equal(rows[0].id, 'old');
  assert.deepEqual(rows[0].columns.slice(4), [0, 3, 3, 'COMPILATION ERROR']);
});
