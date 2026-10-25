const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CSV_COLUMNS,
  normalizeTestSuite,
  publicTestSuite,
  studentEvaluation,
  finalStatus,
  submissionsToCsv,
  createSubmission,
  candidateSubmission
} = require('../lib/platform');

 test('preserves legacy arrays as hidden cases and keeps sample suites separate', () => {
  const legacy = [{ input: '1', expectedOutput: 'one' }];
  assert.deepEqual(normalizeTestSuite(legacy), { sampleTests: [], hiddenTests: legacy });
  const split = normalizeTestSuite({
    sampleTests: [{ input: '2', expectedOutput: 'two' }],
    hiddenTests: [{ input: '3', expectedOutput: 'three' }]
  });
  assert.equal(split.sampleTests[0].input, '2');
  assert.equal(split.hiddenTests[0].input, '3');
});

test('student hidden-case summaries never reveal inputs or expected/actual output', () => {
  const evaluation = {
    passed: 0, total: 1, percent: 0, complete: true,
    results: [{ index: 1, passed: false, status: 'Wrong Answer', input: 'secret input', expectedOutput: 'secret expected', actualOutput: 'secret actual' }]
  };
  assert.deepEqual(studentEvaluation(evaluation, true).results[0], { index: 1, passed: false, status: 'Wrong Answer' });
  assert.equal(studentEvaluation(evaluation, false).results[0].expectedOutput, 'secret expected');
  assert.deepEqual(publicTestSuite({ sampleTests: [{ input: 'visible', expectedOutput: 'yes' }], hiddenTests: [{ input: 'secret', expectedOutput: 'no' }] }).sampleTests, [{ input: 'visible', expectedOutput: 'yes' }]);
});

test('maps execution outcomes to platform submission statuses', () => {
  assert.equal(finalStatus({ complete: true, passed: 2, total: 2, results: [{ status: 'Accepted', passed: true }, { status: 'Accepted', passed: true }] }), 'ACCEPTED');
  assert.equal(finalStatus({ complete: true, passed: 1, total: 2, results: [{ status: 'Accepted', passed: true }, { status: 'Accepted', passed: false }] }), 'WRONG ANSWER');
  assert.equal(finalStatus({ complete: true, results: [{ status: 'Compilation Error', passed: false }] }), 'COMPILATION ERROR');
  assert.equal(finalStatus({ complete: true, results: [{ status: 'Time Limit Exceeded', passed: false }] }), 'TIME LIMIT EXCEEDED');
  assert.equal(finalStatus({ complete: true, results: [{ status: 'Execution Error', passed: false }] }), 'EXECUTION ERROR');
  assert.equal(finalStatus({ complete: false, results: [] }), 'EXECUTION SERVICE ERROR');
});

test('creates per-attempt official records and a CSV with exactly the required fields', () => {
  const submission = createSubmission({
    attemptId: 'attempt-1',
    question: { id: 9, t: 'Two Sum' },
    language: 'Python 3',
    sourceCode: 'print("a, b")\nprint("quoted \\"text\\"")',
    evaluation: { passed: 1, total: 2, results: [{ index: 1, passed: true, status: 'Accepted', input: '', expectedOutput: 'ok' }] },
    status: 'WRONG ANSWER',
    submittedAt: 123
  });
  assert.equal(submission.userId, 'attempt-1');
  assert.equal(submission.failedTestCases, 1);
  assert.deepEqual(Object.keys(candidateSubmission(submission)), [
    'submissionId', 'questionId', 'questionTitle', 'language', 'status',
    'passedTestCases', 'failedTestCases', 'totalTestCases', 'submittedAt'
  ]);
  const csv = submissionsToCsv([submission]);
  const rows = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  assert.equal(rows[0], CSV_COLUMNS.join(','));
  assert.equal(rows.length, 2);
  assert.match(rows[1], /"print\(""a, b""\)/);
  assert.doesNotMatch(rows[0], /User|Email|Runtime|IP/i);
});
