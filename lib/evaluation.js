const MAX_CASES = 20;
const MAX_VALUE_LENGTH = 8_000;

function latestLanguages(all) {
  const groups = [
    /^C \(/,
    /^C\+\+/,
    /^Java \(/,
    /^JavaScript \(Node/,
    /^Python \(3/
  ];
  const version = name => (name.match(/\d+(?:\.\d+)+/) || ['0'])[0].split('.').map(Number);
  const compare = (a, b) => {
    const left = version(a.name), right = version(b.name);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const delta = (left[i] || 0) - (right[i] || 0);
      if (delta) return delta;
    }
    return a.id - b.id;
  };
  return groups.map(pattern => all.filter(language => pattern.test(language.name)).sort(compare).at(-1))
    .filter(Boolean)
    .map(language => ({ id: language.id, name: language.name }));
}

function normalizeOutput(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function validateCases(value) {
  if (!Array.isArray(value) || value.length > MAX_CASES) {
    throw new Error(`Add no more than ${MAX_CASES} test cases.`);
  }
  return value.map((test, index) => {
    if (typeof test?.input !== 'string' || typeof test?.expectedOutput !== 'string') {
      throw new Error(`Test case ${index + 1} needs input and expected output text.`);
    }
    if (test.input.length > MAX_VALUE_LENGTH || test.expectedOutput.length > MAX_VALUE_LENGTH) {
      throw new Error(`Test case ${index + 1} is too large (8,000 characters maximum per field).`);
    }
    return { input: test.input, expectedOutput: test.expectedOutput };
  });
}

async function evaluateSuite(judgeRun, languageId, code, cases) {
  if (!cases.length) return { passed: 0, total: 0, percent: null, complete: false, score: null, results: [] };
  const results = await Promise.all(cases.map(async (test, index) => {
    try {
      const result = await judgeRun(languageId, code, test.input);
      const passed = result.status === 'Accepted' && normalizeOutput(result.stdout) === normalizeOutput(test.expectedOutput);
      return { index: index + 1, input: test.input, expectedOutput: test.expectedOutput, passed, status: result.status, actualOutput: result.stdout, stderr: result.stderr, compileOutput: result.compileOutput, time: result.time, runnerError: false };
    } catch (error) {
      return { index: index + 1, input: test.input, expectedOutput: test.expectedOutput, passed: false, status: 'Judge Error', actualOutput: '', stderr: error.message || 'Judge service unavailable', compileOutput: '', time: null, runnerError: true };
    }
  }));
  const passed = results.filter(test => test.passed).length;
  const complete = results.every(test => !test.runnerError);
  return { passed, total: results.length, percent: Math.round(passed / results.length * 100), complete, score: complete ? passed / results.length : null, results };
}

function candidateSummary(evaluation) {
  return evaluation && {
    passed: evaluation.passed,
    total: evaluation.total,
    percent: evaluation.percent,
    complete: evaluation.complete
  };
}

function invalidateStaleEvaluation(answer, nextCode) {
  if (answer.code !== nextCode && (answer.submittedAt || answer.testEvaluation)) {
    delete answer.testEvaluation;
    delete answer.submittedAt;
    delete answer.runResult;
    delete answer.sampleCompared;
    delete answer.passed;
    answer.score = null;
    answer.scoreSource = 'ungraded';
  }
}

module.exports = { MAX_CASES, latestLanguages, normalizeOutput, validateCases, evaluateSuite, candidateSummary, invalidateStaleEvaluation };
