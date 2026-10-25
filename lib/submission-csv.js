const HEADERS = [
  'Question ID', 'Question', 'Language', 'Source Code', 'Test Cases Passed',
  'Test Cases Failed', 'Total Test Cases', 'Final Status'
];

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function columnsFor(questionId, title, language, code, evaluation) {
  const total = Number(evaluation?.total) || 0;
  const passed = Math.max(0, Math.min(total, Number(evaluation?.passed) || 0));
  const statuses = evaluation?.results?.map(result => result.status) || [];
  const status = !total ? 'MANUAL REVIEW'
    : statuses.some(value => value === 'Compilation Error') ? 'COMPILATION ERROR'
      : statuses.some(value => value === 'Time Limit Exceeded') ? 'TIME LIMIT EXCEEDED'
        : !evaluation?.complete ? 'JUDGE ERROR'
          : passed === total ? 'ACCEPTED' : 'WRONG ANSWER';
  return [String(questionId), title || `Question ${questionId}`, language || '', code || '', passed, total - passed, total, status];
}

function submissionRows(attempts, questions, history = []) {
  const titles = new Map(questions.map(question => [String(question.id), question.t]));
  const historicalPairs = new Set(history.map(item => `${item.attemptId}:${item.questionId}`));
  const current = attempts.flatMap(attempt => Object.entries(attempt.answers || {}).flatMap(([questionId, answer]) => {
    if (!answer?.submittedAt || typeof answer.code !== 'string' || historicalPairs.has(`${attempt.id}:${questionId}`)) return [];
    return [{ id: `${attempt.id}:${questionId}:${answer.submittedAt}`, user: attempt.name,
      columns: columnsFor(questionId, titles.get(String(questionId)), answer.languageName, answer.code, answer.testEvaluation) }];
  }));
  const prior = history.map(item => ({
    id: item.id, user: item.user,
    columns: columnsFor(item.questionId, titles.get(String(item.questionId)), item.language, item.code, item.testEvaluation)
  }));
  return [...prior, ...current];
}

function toCsv(rows) {
  return [HEADERS, ...rows.map(row => row.columns)].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { HEADERS, submissionRows, toCsv };
