const { randomUUID } = require('node:crypto');
const { validateCases } = require('./evaluation');

const CSV_COLUMNS = [
  'Question ID', 'Question', 'Language', 'Source Code',
  'Test Cases Passed', 'Test Cases Failed', 'Total Test Cases', 'Final Status'
];

function normalizeTestSuite(value, question) {
  let sampleTests = [];
  let hiddenTests = [];
  if (Array.isArray(value)) {
    // Existing deployments stored only a private suite as an array. Preserve it as hidden.
    hiddenTests = value;
  } else if (value && typeof value === 'object') {
    sampleTests = value.sampleTests || [];
    hiddenTests = value.hiddenTests || [];
  }
  if (question && Array.isArray(question.sampleTests) && sampleTests.length === 0) {
    sampleTests = question.sampleTests;
  }
  if (question && Array.isArray(question.hiddenTests) && hiddenTests.length === 0) {
    hiddenTests = question.hiddenTests;
  }
  return {
    sampleTests: validateCases(sampleTests),
    hiddenTests: validateCases(hiddenTests)
  };
}

function publicTestSuite(value, question) {
  return { sampleTests: normalizeTestSuite(value, question).sampleTests };
}

function studentEvaluation(evaluation, hidden) {
  if (!evaluation) return null;
  return {
    passed: evaluation.passed,
    failed: Math.max(0, (evaluation.total || 0) - (evaluation.passed || 0)),
    total: evaluation.total,
    percent: evaluation.percent,
    complete: evaluation.complete,
    status: evaluation.finalStatus || (evaluation.complete && evaluation.passed === evaluation.total ? 'ACCEPTED' : 'WRONG ANSWER'),
    results: (evaluation.results || []).map(result => hidden ? {
      index: result.index,
      passed: result.passed,
      status: result.status
    } : {
      index: result.index,
      passed: result.passed,
      status: result.status,
      expectedOutput: result.expectedOutput,
      actualOutput: result.actualOutput,
      stderr: result.stderr,
      compileOutput: result.compileOutput
    })
  };
}

function finalStatus(evaluation) {
  if (!evaluation) return 'EXECUTION ERROR';
  if (evaluation.finalStatus) return evaluation.finalStatus;
  if (!evaluation.complete) return 'EXECUTION SERVICE ERROR';
  const statuses = (evaluation.results || []).map(result => String(result.status || ''));
  if (statuses.some(status => /compilation error/i.test(status))) return 'COMPILATION ERROR';
  if (statuses.some(status => /time limit|timed out/i.test(status))) return 'TIME LIMIT EXCEEDED';
  if (statuses.some(status => /memory limit/i.test(status))) return 'MEMORY LIMIT EXCEEDED';
  if (statuses.some(status => /runtime error|non.zero|signal/i.test(status))) return 'RUNTIME ERROR';
  if (statuses.some(status => /internal error|judge error|service error/i.test(status))) return 'EXECUTION SERVICE ERROR';
  if (statuses.some(status => /execution error|exec format|permission error|bad system call/i.test(status))) return 'EXECUTION ERROR';
  if ((evaluation.results || []).some(result => !result.passed)) return 'WRONG ANSWER';
  return evaluation.passed === evaluation.total ? 'ACCEPTED' : 'WRONG ANSWER';
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function submissionsToCsv(submissions) {
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const submission of submissions) {
    lines.push([
      submission.questionId,
      submission.questionTitle,
      submission.language,
      submission.sourceCode,
      submission.passedTestCases,
      submission.failedTestCases,
      submission.totalTestCases,
      submission.status
    ].map(csvCell).join(','));
  }
  // A UTF-8 BOM helps spreadsheet applications preserve source text and punctuation.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function createSubmission({ attemptId, question, language, sourceCode, evaluation, status, submittedAt = Date.now() }) {
  const total = Number(evaluation?.total) || 0;
  const passed = Number(evaluation?.passed) || 0;
  return {
    id: randomUUID(),
    userId: String(attemptId),
    questionId: Number(question.id),
    questionTitle: String(question.t || question.title || `Question ${question.id}`),
    language: String(language || 'Unknown'),
    sourceCode: String(sourceCode),
    status: status || finalStatus(evaluation),
    passedTestCases: passed,
    failedTestCases: Math.max(0, total - passed),
    totalTestCases: total,
    testCaseResults: (evaluation?.results || []).map(result => ({
      index: result.index,
      passed: !!result.passed,
      status: String(result.status || ''),
      input: result.input,
      expectedOutput: result.expectedOutput,
      actualOutput: result.actualOutput,
      stderr: result.stderr,
      compileOutput: result.compileOutput,
      runnerError: !!result.runnerError
    })),
    submittedAt
  };
}

function candidateSubmission(submission) {
  return {
    submissionId: submission.id,
    questionId: submission.questionId,
    questionTitle: submission.questionTitle,
    language: submission.language,
    status: submission.status,
    passedTestCases: submission.passedTestCases,
    failedTestCases: submission.failedTestCases,
    totalTestCases: submission.totalTestCases,
    submittedAt: submission.submittedAt
  };
}

module.exports = {
  CSV_COLUMNS,
  normalizeTestSuite,
  publicTestSuite,
  studentEvaluation,
  finalStatus,
  submissionsToCsv,
  createSubmission,
  candidateSubmission
};
