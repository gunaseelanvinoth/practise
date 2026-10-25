const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const root = __dirname;
const staticRoot = path.join(root, 'public');
const dataDir = process.env.DSA_DATA_DIR ? path.resolve(process.env.DSA_DATA_DIR) : path.join(root, 'data');
const stateFile = path.join(dataDir, 'state.json');
const secretFile = path.join(dataDir, 'admin-secret.txt');
const questions = require('./questions.json');
const questionSpecs = require('./question-specs.json');
const sets = require('./sets.json');
const { latestLanguages, validateCases, evaluateSuite, candidateSummary, invalidateStaleEvaluation } = require('./lib/evaluation');
const {
  normalizeTestSuite, mergeTestSuite, publicTestSuite, studentEvaluation, finalStatus,
  submissionsToCsv, createSubmission, candidateSubmission
} = require('./lib/platform');

fs.mkdirSync(dataDir, { recursive: true });
const emptyState = () => ({ settings: { enabled: false, durationMinutes: 240, questionCount: 50, set: 'A' }, attempts: [], testCases: {}, submissions: [] });
function readState() {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return { ...emptyState(), ...saved, settings: { ...emptyState().settings, ...(saved.settings || {}) }, attempts: saved.attempts || [], testCases: saved.testCases || {}, submissions: saved.submissions || [] };
  } catch { return emptyState(); }
}
let state = readState();
function persist() {
  const temporary = `${stateFile}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, stateFile);
}
state.settings.set = state.settings.set === 'B' ? 'B' : 'A';
for (const attempt of state.attempts) {
  attempt.answers ||= {};
  for (const answer of Object.values(attempt.answers)) {
    if (answer.score != null && !answer.testEvaluation && answer.scoreSource !== 'admin') {
      answer.score = null;
      answer.scoreSource = 'legacy-unverified';
    }
  }
}
persist();

function loadEnvFile() {
  try {
    for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
}
loadEnvFile();
let adminPassword = process.env.ADMIN_PASSWORD;
if (!adminPassword) {
  try { adminPassword = fs.readFileSync(secretFile, 'utf8').trim(); }
  catch {
    adminPassword = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(secretFile, adminPassword, { mode: 0o600 });
    console.log(`\nADMIN PASSWORD (save this): ${adminPassword}\n`);
  }
}

const sessions = new Map();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
let languageCache = { expires: 0, items: null };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const presence = attempt => {
  if (attempt.status === 'submitted') return 'Submitted';
  const age = (Date.now() - (attempt.lastSeenAt || 0)) / 1000;
  return age < 15 ? 'Online' : age < 60 ? 'Idle' : 'Offline';
};
function testCases() {
  return Object.fromEntries(questions.map(question => {
    const id = String(question.id);
    return [id, mergeTestSuite(questionSpecs[id], state.testCases[id])];
  }));
}
function candidateQuestion(question, suite) {
  return {
    id: question.id, title: question.t, level: question.lvl, tags: question.tags,
    statement: question.task, sample: question.io || '',
    inputFormat: questionSpecs[String(question.id)]?.inputFormat || question.inputFormat || '',
    outputFormat: questionSpecs[String(question.id)]?.outputFormat || question.outputFormat || '',
    constraints: questionSpecs[String(question.id)]?.constraints || question.constraints || '',
    sampleTests: publicTestSuite(suite, question).sampleTests
  };
}
function cleanAttempt(attempt, role) {
  const answers = attempt.answers || {};
  return {
    id: attempt.id, name: attempt.name, set: attempt.set, status: presence(attempt), submitted: attempt.status === 'submitted',
    startedAt: attempt.startedAt, endAt: attempt.endAt, lastSeenAt: attempt.lastSeenAt, currentIndex: attempt.currentIndex,
    questionIds: attempt.questionIds,
    questionTitles: role === 'admin' ? Object.fromEntries(attempt.questionIds.map(id => [id, questions.find(q => q.id === id)?.t || `Question ${id}`])) : undefined,
    answers: role === 'admin' ? answers : undefined,
    marks: Object.values(answers).filter(answer => answer.score > 0).length,
    score: Object.values(answers).reduce((sum, answer) => sum + (Number(answer.score) || 0), 0),
    total: attempt.questionIds.length,
    integrity: attempt.integrity || []
  };
}
function candidateAnswers(attempt) {
  return Object.fromEntries(Object.entries(attempt.answers || {}).map(([id, answer]) => [id, {
    code: answer.code, languageId: answer.languageId, languageName: answer.languageName,
    savedAt: answer.savedAt, submittedAt: answer.submittedAt, score: answer.score,
    runResult: answer.runResult, sampleCompared: answer.sampleCompared, passed: answer.passed,
    testEvaluation: candidateSummary(answer.testEvaluation)
  }]));
}
function auth(req, role) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const current = sessions.get(token);
  return current && (!role || current.role === role) ? current : null;
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 400000) { reject(Error('Request too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { reject(Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function sendStatic(req, res, url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('Bad request'); return; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/control-room') pathname = '/platform.html';
  if (pathname === '/admin') { res.writeHead(404).end('Not found'); return; }
  if (pathname === '/candidate') pathname = '/platform.html';
  const target = path.resolve(staticRoot, `.${pathname}`);
  if (!target.startsWith(`${staticRoot}${path.sep}`)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(target, (error, content) => {
    if (error) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }).end(content);
  });
}
async function judgeRun(languageId, source, input) {
  const base = (process.env.JUDGE0_URL || 'https://ce.judge0.com').replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json', ...(process.env.JUDGE0_KEY ? { 'X-Auth-Token': process.env.JUDGE0_KEY } : {}) };
  const created = await fetch(`${base}/submissions?base64_encoded=true&wait=false`, {
    method: 'POST', headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({ language_id: languageId, source_code: Buffer.from(source).toString('base64'), stdin: Buffer.from(input || '').toString('base64'), cpu_time_limit: 3, wall_time_limit: 6 })
  });
  if (!created.ok) throw Error(`Judge service returned ${created.status}`);
  const { token } = await created.json();
  if (!token) throw Error('Judge service did not return a submission token');
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(`${base}/submissions/${token}?base64_encoded=true&fields=stdout,stderr,compile_output,status,time,memory`, { headers, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error(`Judge service returned ${response.status}`);
    const result = await response.json();
    if (result.status && ![1, 2].includes(result.status.id)) {
      for (const field of ['stdout', 'stderr', 'compile_output']) if (result[field]) result[field] = Buffer.from(result[field], 'base64').toString('utf8');
      return { status: result.status.description, stdout: result.stdout || '', stderr: result.stderr || '', compileOutput: result.compile_output || '', time: result.time || null, memory: result.memory || null };
    }
  }
  throw Error('Code run timed out while waiting for the judge');
}
async function getLanguages() {
  if (languageCache.items && languageCache.expires > Date.now()) return languageCache.items;
  const base = (process.env.JUDGE0_URL || 'https://ce.judge0.com').replace(/\/$/, '');
  const headers = process.env.JUDGE0_KEY ? { 'X-Auth-Token': process.env.JUDGE0_KEY } : {};
  const response = await fetch(`${base}/languages`, { headers, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('Language list request failed');
  languageCache.items = latestLanguages(await response.json());
  languageCache.expires = Date.now() + 6 * 60 * 60 * 1000;
  return languageCache.items;
}
async function deleteSubmission(submission) {
  state.submissions = state.submissions.filter(item => item.id !== submission.id);
}
function saveSubmission(submission) { state.submissions.unshift(submission); persist(); }

async function route(req, res, url) {
  const method = req.method, pathName = url.pathname;
  if (method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }).end(); return; }
  if (method === 'GET' && pathName === '/api/ping') return json(res, 200, { ok: true, time: Date.now() });
  if (method === 'GET' && pathName === '/api/public') return json(res, 200, { enabled: state.settings.enabled, durationMinutes: state.settings.durationMinutes, questionCount: state.settings.questionCount });

  if (method === 'POST' && pathName === '/api/login') {
    const input = await body(req), role = input.role === 'admin' ? 'admin' : 'candidate';
    if (role === 'admin') {
      if (!adminPassword || input.password !== adminPassword) return json(res, 401, { error: 'Incorrect admin password' });
    } else {
      if (!state.settings.enabled) return json(res, 403, { error: 'The test is closed right now' });
      if (!String(input.name || '').trim()) return json(res, 400, { error: 'Enter your name' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const current = { role, name: String(input.name || 'Administrator').trim(), createdAt: Date.now() };
    if (role === 'candidate') {
      let attempt = state.attempts.find(item => item.status === 'active' && item.name.toLowerCase() === current.name.toLowerCase());
      if (!attempt) {
        const set = state.settings.set === 'B' ? 'B' : 'A';
        const questionIds = sets[set === 'A' ? 'setA' : 'setB'].slice(0, state.settings.questionCount);
        attempt = { id: crypto.randomUUID(), name: current.name, set, status: 'active', startedAt: Date.now(), endAt: Date.now() + state.settings.durationMinutes * 60000, lastSeenAt: Date.now(), currentIndex: 0, questionIds, answers: {}, integrity: [] };
        state.attempts.push(attempt); persist();
      }
      current.attemptId = attempt.id;
    }
    sessions.set(token, current);
    return json(res, 200, { token, role, name: current.name });
  }

  if (method === 'GET' && pathName === '/api/languages') {
    if (!auth(req, 'candidate')) return json(res, 401, { error: 'Sign in required' });
    try { return json(res, 200, { languages: await getLanguages() }); }
    catch { return json(res, 503, { error: 'Code runner unavailable. Check internet access and JUDGE0_URL.' }); }
  }

  if (pathName.startsWith('/api/admin/')) {
    if (!auth(req, 'admin')) return json(res, 403, { error: 'Admin access required' });
    if (method === 'GET' && pathName === '/api/admin/dashboard') {
      for (const attempt of state.attempts) if (attempt.status === 'active' && Date.now() >= attempt.endAt) { attempt.status = 'submitted'; attempt.submittedAt = Date.now(); attempt.autoSubmitted = true; }
      persist();
      return json(res, 200, {
        settings: state.settings,
        attempts: state.attempts.map(attempt => cleanAttempt(attempt, 'admin')),
        integrity: state.attempts.reduce((count, attempt) => count + (attempt.integrity || []).length, 0),
        questions: questions.map(question => ({ id: question.id, title: question.t })),
        testCases: testCases(),
        submissions: state.submissions,
        users: state.attempts.map(attempt => ({ id: attempt.id, name: attempt.name, set: attempt.set }))
      });
    }
    if (method === 'POST' && pathName === '/api/admin/test-cases') {
      const input = await body(req), questionId = String(input.questionId), question = questions.find(item => String(item.id) === questionId);
      if (!question) return json(res, 404, { error: 'Question not found' });
      try {
        const suite = normalizeTestSuite(input.suite || input.cases || [], question);
        state.testCases[questionId] = suite; persist();
        return json(res, 200, { ok: true, sampleCount: suite.sampleTests.length, hiddenCount: suite.hiddenTests.length });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (method === 'POST' && pathName === '/api/admin/settings') {
      const input = await body(req);
      state.settings = { enabled: !!input.enabled, durationMinutes: Math.max(1, Math.min(600, Number(input.durationMinutes) || 240)), questionCount: Math.max(1, Math.min(50, Number(input.questionCount) || 50)), set: input.set === 'B' ? 'B' : 'A' };
      persist(); return json(res, 200, { settings: state.settings });
    }
    if (method === 'POST' && pathName === '/api/admin/grade') {
      const input = await body(req), attempt = state.attempts.find(item => item.id === input.attemptId);
      if (!attempt) return json(res, 404, { error: 'Attempt not found' });
      const answer = attempt.answers?.[String(input.questionId)];
      if (!answer) return json(res, 404, { error: 'No submitted code for this question' });
      answer.score = Math.round(Math.max(0, Math.min(1, Number(input.score) || 0)) * 100) / 100;
      answer.adminNote = String(input.note || '').slice(0, 500); answer.scoreSource = 'admin'; persist();
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathName === '/api/admin/submissions/export') {
      const input = await body(req), ids = new Set((Array.isArray(input.submissionIds) ? input.submissionIds : []).map(String));
      if (!ids.size) return json(res, 400, { error: 'Please select at least one submission to export.' });
      const rows = state.submissions.filter(item => ids.has(item.id));
      return json(res, 200, { csv: submissionsToCsv(rows), count: rows.length, filename: 'selected-code-submissions.csv' });
    }
    if (method === 'POST' && pathName === '/api/admin/submissions/export-user') {
      const input = await body(req); if (!input.userId) return json(res, 400, { error: 'Select a user to export.' });
      const rows = state.submissions.filter(item => item.userId === String(input.userId));
      return json(res, 200, { csv: submissionsToCsv(rows), count: rows.length, filename: 'user-code-submissions.csv' });
    }
    if (method === 'POST' && pathName === '/api/admin/submissions/export-all') return json(res, 200, { csv: submissionsToCsv(state.submissions), filename: 'all-code-submissions.csv' });

    if (method === 'POST' && pathName === '/api/admin/delete-attempt') {
      const input = await body(req), attemptId = String(input.attemptId || '');
      state.attempts = state.attempts.filter(attempt => attempt.id !== attemptId);
      state.submissions = state.submissions.filter(submission => submission.userId !== attemptId);
      persist(); return json(res, 200, { ok: true, deleted: attemptId });
    }
    if (method === 'POST' && pathName === '/api/admin/clear-all') {
      const count = state.attempts.length; state.attempts = []; state.submissions = []; persist();
      return json(res, 200, { ok: true, count });
    }
    return json(res, 404, { error: 'Admin route not found' });
  }

  if (method === 'GET' && pathName === '/api/me') {
    const current = auth(req, 'candidate'); if (!current) return json(res, 401, { error: 'Sign in again' });
    const attempt = state.attempts.find(item => item.id === current.attemptId); if (!attempt) return json(res, 404, { error: 'Attempt not found' });
    if (attempt.status === 'active' && Date.now() >= attempt.endAt) { attempt.status = 'submitted'; attempt.submittedAt = Date.now(); attempt.autoSubmitted = true; }
    attempt.lastSeenAt = Date.now(); persist();
    const suites = testCases();
    return json(res, 200, {
      attempt: cleanAttempt(attempt, 'candidate'),
      questions: attempt.questionIds.map(id => candidateQuestion(questions.find(question => question.id === id), suites[String(id)])),
      answers: candidateAnswers(attempt), questionCount: attempt.questionIds.length,
      submissions: state.submissions.filter(submission => submission.userId === attempt.id).map(candidateSubmission)
    });
  }

  if (method === 'GET' && pathName === '/api/candidate/submissions') {
    const current = auth(req, 'candidate'); if (!current) return json(res, 401, { error: 'Sign in required' });
    return json(res, 200, { submissions: state.submissions.filter(submission => submission.userId === current.attemptId).map(candidateSubmission) });
  }

  if (pathName.startsWith('/api/candidate/')) {
    const current = auth(req, 'candidate'); if (!current) return json(res, 401, { error: 'Sign in required' });
    const attempt = state.attempts.find(item => item.id === current.attemptId); if (!attempt) return json(res, 404, { error: 'Attempt not found' });
    if (method === 'POST' && pathName === '/api/candidate/heartbeat') { attempt.lastSeenAt = Date.now(); persist(); return json(res, 200, { status: presence(attempt) }); }
    if (method === 'POST' && pathName === '/api/candidate/final-submit') {
      if (attempt.status === 'active') { attempt.status = 'submitted'; attempt.submittedAt = Date.now(); persist(); }
      return json(res, 200, { attempt: cleanAttempt(attempt, 'candidate') });
    }
    if (method === 'POST' && ['/api/candidate/navigate', '/api/candidate/save', '/api/candidate/run'].includes(pathName)) {
      const input = await body(req);
      if (attempt.status !== 'active' || Date.now() >= attempt.endAt) return json(res, 403, { error: 'Attempt is closed' });
      if (pathName === '/api/candidate/navigate') {
        attempt.lastSeenAt = Date.now(); attempt.currentIndex = Math.max(0, Math.min(attempt.questionIds.length - 1, Number(input.index) || 0)); persist();
        return json(res, 200, { index: attempt.currentIndex });
      }
      const questionId = String(input.questionId);
      if (!attempt.questionIds.includes(Number(questionId))) return json(res, 403, { error: 'Question is not assigned to this attempt' });
      if (typeof input.code !== 'string' || input.code.length > 50000) return json(res, 400, { error: 'Code is empty or too large' });
      const answer = attempt.answers[questionId] || {};
      invalidateStaleEvaluation(answer, input.code);
      Object.assign(answer, { code: input.code, languageId: Number(input.languageId), languageName: String(input.languageName || ''), savedAt: Date.now() });
      attempt.answers[questionId] = answer; attempt.lastSeenAt = Date.now(); persist();
      if (pathName === '/api/candidate/save') return json(res, 200, { savedAt: answer.savedAt });

      const question = questions.find(item => item.id === Number(questionId));
      let suite;
      try { suite = normalizeTestSuite(testCases()[questionId], question); }
      catch (error) { return json(res, 422, { error: `Test suite is invalid: ${error.message}` }); }
      const isSubmit = !!input.submit, cases = isSubmit ? suite.hiddenTests : suite.sampleTests;
      if (!String(input.code).trim()) {
        if (!isSubmit) return json(res, 400, { status: 'EMPTY CODE', error: 'Enter code before running.' });
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation: null, status: 'EMPTY CODE' });
        saveSubmission(submission); Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: submission.status }); persist();
        return json(res, 200, { result: { status: 'EMPTY CODE', stdout: '', stderr: '', compileOutput: '' }, evaluation: { passed: 0, failed: 0, total: 0, status: submission.status, complete: false, results: [] }, submitted: true });
      }
      if (!Number.isInteger(Number(input.languageId)) || Number(input.languageId) <= 0) {
        if (!isSubmit) return json(res, 400, { status: 'INVALID LANGUAGE', error: 'Select a supported language.' });
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation: null, status: 'INVALID LANGUAGE' });
        saveSubmission(submission); Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: submission.status }); persist();
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: '', compileOutput: '' }, evaluation: { passed: 0, failed: 0, total: 0, status: submission.status, complete: false, results: [] }, submitted: true });
      }
      const supportedLanguages = await getLanguages().catch(() => null);
      if (supportedLanguages && !supportedLanguages.some(language => Number(language.id) === Number(input.languageId))) {
        if (!isSubmit) return json(res, 400, { status: 'INVALID LANGUAGE', error: 'That language is not available on the configured Judge0 service.' });
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation: null, status: 'INVALID LANGUAGE' });
        saveSubmission(submission); Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: submission.status }); persist();
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: '', compileOutput: '' }, evaluation: { passed: 0, failed: 0, total: 0, status: submission.status, complete: false, results: [] }, submitted: true, submission: candidateSubmission(submission) });
      }
      if (!cases.length) {
        if (!isSubmit) return json(res, 422, { status: 'EXECUTION ERROR', error: 'No visible sample tests are configured for this question yet.' });
        const evaluation = { passed: 0, total: 0, percent: null, complete: false, score: null, results: [], finalStatus: 'EXECUTION ERROR' };
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation, status: 'EXECUTION ERROR' });
        saveSubmission(submission); Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: submission.status, testEvaluation: evaluation, score: null, scoreSource: 'auto' }); persist();
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: '', compileOutput: '' }, evaluation: studentEvaluation(evaluation, true), submitted: true });
      }
      try {
        const evaluation = await evaluateSuite(judgeRun, Number(input.languageId), input.code, cases);
        const status = finalStatus(evaluation); evaluation.finalStatus = status;
        if (isSubmit) {
          const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation, status });
          saveSubmission(submission);
          Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: status, testEvaluation: evaluation, score: evaluation.complete ? evaluation.score : null, scoreSource: 'auto', passed: status === 'ACCEPTED', runResult: { status, stdout: '', stderr: '', compileOutput: evaluation.results.find(result => result.compileOutput)?.compileOutput || '' }, lastRunAt: Date.now() });
          persist();
          return json(res, 200, { result: answer.runResult, evaluation: studentEvaluation(evaluation, true), submitted: true, submission: candidateSubmission(submission) });
        }
        answer.runResult = { status: status === 'ACCEPTED' ? 'Accepted' : (evaluation.results.find(result => !result.passed)?.status || status), stdout: evaluation.results.map(result => result.actualOutput || '').join('\n'), stderr: evaluation.results.find(result => result.stderr)?.stderr || '', compileOutput: evaluation.results.find(result => result.compileOutput)?.compileOutput || '' };
        answer.sampleCompared = true; answer.passed = status === 'ACCEPTED'; answer.lastRunAt = Date.now(); persist();
        return json(res, 200, { result: answer.runResult, evaluation: studentEvaluation(evaluation, false), sampleCompared: true, passed: answer.passed, submitted: false });
      } catch (error) {
        if (!isSubmit) return json(res, 502, { status: 'EXECUTION SERVICE ERROR', error: error.message || 'Code runner unavailable' });
        const evaluation = { passed: 0, total: cases.length, percent: 0, complete: false, score: null, results: [], finalStatus: 'EXECUTION SERVICE ERROR' };
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation, status: 'EXECUTION SERVICE ERROR' });
        saveSubmission(submission); Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: submission.status, testEvaluation: evaluation, score: null, scoreSource: 'auto' }); persist();
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: error.message || '', compileOutput: '' }, evaluation: studentEvaluation(evaluation, true), submitted: true, submission: candidateSubmission(submission) });
      }
    }
  }
  return sendStatic(req, res, url);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return sendStatic(req, res, url);
  route(req, res, url).catch(error => { console.error(error.message); json(res, 500, { error: error.message || 'Server error' }); });
});
setInterval(() => {
  let changed = false;
  for (const attempt of state.attempts) if (attempt.status === 'active' && Date.now() >= attempt.endAt) { attempt.status = 'submitted'; attempt.submittedAt = Date.now(); attempt.autoSubmitted = true; changed = true; }
  if (changed) persist();
}, 1000).unref();
function listen(port) {
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && !process.env.PORT && port < 4180) { console.warn(`Port ${port} is already in use; trying ${port + 1}.`); listen(port + 1); return; }
    console.error(`Could not start the server on port ${port}: ${error.message}`); process.exitCode = 1;
  });
  server.listen(port, '0.0.0.0', () => {
    console.log(`\nDSA Test Platform running on port ${port}`);
    console.log(`This computer: http://localhost:${port}`);
    for (const [name, items] of Object.entries(os.networkInterfaces())) for (const item of items || []) if (item.family === 'IPv4' && !item.internal) console.log(`Same Wi-Fi network: http://${item.address}:${port}`);
    console.log('Admin password is configured. Keep it private.\n');
  });
}
listen(Number(process.env.PORT || 4173));
