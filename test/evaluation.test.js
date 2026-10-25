const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_CASES, latestLanguages, normalizeOutput, validateCases, evaluateSuite, candidateSummary } = require('../lib/evaluation');

test('normalizes insignificant whitespace without changing output tokens', () => {
  assert.equal(normalizeOutput(' 1   2\r\n3  '), normalizeOutput('1 2 3\n'));
  assert.notEqual(normalizeOutput('1 2 3'), normalizeOutput('1 2 4'));
});

test('an empty suite cannot be reported as a successful evaluation', async () => {
  const result = await evaluateSuite(async () => ({ status: 'Accepted', stdout: '' }), 1, 'solution', []);
  assert.equal(result.complete, false);
  assert.equal(result.score, null);
  assert.equal(result.total, 0);
});

test('keeps only the newest available Judge0 entry for each language', () => {
  const selected = latestLanguages([
    { id: 1, name: 'C (Clang 18.1.8)' }, { id: 2, name: 'C (Clang 19.1.7)' }, { id: 3, name: 'C (GCC 14.1.0)' },
    { id: 4, name: 'C++ (GCC 7.4.0)' }, { id: 5, name: 'C++ (GCC 14.1.0)' },
    { id: 6, name: 'Java (OpenJDK 13.0.1)' }, { id: 7, name: 'Java (JDK 17.0.6)' },
    { id: 8, name: 'JavaScript (Node.js 20.17.0)' }, { id: 9, name: 'JavaScript (Node.js 22.08.0)' },
    { id: 10, name: 'Python (3.13.2)' }, { id: 11, name: 'Python (3.14.0)' }
  ]);
  assert.deepEqual(selected.map(x => x.id), [2, 5, 7, 9, 11]);
  assert.equal(new Set(selected.map(x => x.name.split(' (')[0])).size, 5);
});

test('validates private input/output cases and enforces the configured limit', () => {
  assert.deepEqual(validateCases([{ input: '2 3', expectedOutput: '5' }]), [{ input: '2 3', expectedOutput: '5' }]);
  assert.deepEqual(validateCases([]), []);
  assert.throws(() => validateCases(Array.from({ length: MAX_CASES + 1 }, () => ({ input: '', expectedOutput: '' }))), /no more than/);
  assert.throws(() => validateCases([{ input: 'stdin' }]), /needs input and expected output/);
});

test('scores each case and awards a proportional mark', async () => {
  const cases = [
    { input: '1', expectedOutput: 'one\n' },
    { input: '2', expectedOutput: 'wrong' },
    { input: '3', expectedOutput: 'three' }
  ];
  const result = await evaluateSuite(async (_language, _code, input) => ({
    status: 'Accepted', stdout: ({ '1': ' one ', '2': 'two', '3': 'three' })[input], stderr: '', compileOutput: '', time: 0.01
  }), 113, 'solution', cases);
  assert.equal(result.passed, 2);
  assert.equal(result.total, 3);
  assert.equal(result.percent, 67);
  assert.equal(result.score, 2 / 3);
  assert.equal(result.complete, true);
  assert.equal(result.results[0].input, '1');
  assert.equal(result.results[0].expectedOutput, 'one\n');
  assert.deepEqual(candidateSummary(result), { passed: 2, total: 3, percent: 67, complete: true });
  assert.equal('results' in candidateSummary(result), false, 'candidate summary must not reveal private case details');
});

test('does not award a score when the judge service fails', async () => {
  const result = await evaluateSuite(async () => { throw new Error('Judge unavailable'); }, 113, 'solution', [
    { input: '', expectedOutput: 'ok' }
  ]);
  assert.equal(result.complete, false);
  assert.equal(result.score, null);
  assert.equal(result.results[0].runnerError, true);
  assert.equal(result.results[0].status, 'Judge Error');
});
