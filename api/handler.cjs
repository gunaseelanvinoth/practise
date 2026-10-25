const crypto = require('node:crypto');
const questions = require('../questions.json');
const sets = require('../sets.json');
const questionSpecs = require('../question-specs.json');
const {
  latestLanguages, validateCases, evaluateSuite, candidateSummary, invalidateStaleEvaluation
} = require('../lib/evaluation');
const {
  normalizeTestSuite, mergeTestSuite, publicTestSuite, studentEvaluation, finalStatus,
  submissionsToCsv, createSubmission, candidateSubmission
} = require('../lib/platform');

const DB = process.env.UPSTASH_REDIS_REST_URL;
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const key = (...parts) => ['dsa', ...parts].join(':');
let languageCache = { expires: 0, items: null };

async function command(...args) {
  if (!DB || !DB_TOKEN) throw Error('Online storage is not connected. Configure Upstash Redis on Vercel.');
  const response = await fetch(DB, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  });
  if (!response.ok) throw Error(`Storage service returned ${response.status}`);
  const data = await response.json();
  if (data.error) throw Error(data.error);
  return data.result;
}

async function pipeline(commands) {
  if (!commands.length) return [];
  if (!DB || !DB_TOKEN) throw Error('Online storage is not connected. Configure Upstash Redis on Vercel.');
  const response = await fetch(`${DB.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw Error(`Storage service returned ${response.status}`);
  const rows = await response.json();
  if (rows.some(row => row.error)) throw Error('Storage pipeline failed');
  return rows.map(row => row.result);
}

const parse = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
const getSettings = async () => parse(await command('GET', key('settings'))) || {
  enabled: false, durationMinutes: 240, questionCount: 50, set: 'A'
};
const saveSettings = settings => command('SET', key('settings'), JSON.stringify(settings));
const getAttempt = id => command('GET', key('attempt', id)).then(parse);
const saveAttempt = attempt => command('SET', key('attempt', attempt.id), JSON.stringify(attempt));
const getTestCases = async () => {
  const stored = parse(await command('GET', key('test-cases'))) || {};
  return Object.fromEntries(questions.map(question => {
    const id = String(question.id);
    return [id, mergeTestSuite(questionSpecs[id], stored[id])];
  }));
};
const getAllAttempts = async () => {
  const ids = await command('SMEMBERS', key('attempts'));
  if (!ids?.length) return [];
  return (await pipeline(ids.map(id => ['GET', key('attempt', id)]))).map(parse).filter(Boolean);
};
const getAnswers = async attempt => {
  if (!attempt.questionIds?.length) return {};
  const values = await pipeline(attempt.questionIds.map(id => ['GET', key('answer', attempt.id, id)]));
  return Object.fromEntries(attempt.questionIds.map((id, index) => [String(id), parse(values[index])]).filter(([, value]) => value));
};
const saveAnswer = (attemptId, questionId, answer) => command('SET', key('answer', attemptId, questionId), JSON.stringify(answer));
const getAllSubmissions = async () => {
  const ids = await command('SMEMBERS', key('submissions'));
  if (!ids?.length) return [];
  return (await pipeline(ids.map(id => ['GET', key('submission', id)]))).map(parse).filter(Boolean);
};
const saveSubmission = async submission => {
  await command('SET', key('submission', submission.id), JSON.stringify(submission));
  await command('SADD', key('submissions'), submission.id);
  await command('SADD', key('user-submissions', submission.userId), submission.id);
};
const getUserSubmissions = async userId => {
  const ids = await command('SMEMBERS', key('user-submissions', userId));
  if (!ids?.length) return [];
  return (await pipeline(ids.map(id => ['GET', key('submission', id)]))).map(parse).filter(Boolean);
};

function json(res, status, value) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 400000) throw Error('Request too large');
  }
  try { return JSON.parse(raw || '{}'); } catch { throw Error('Invalid JSON'); }
}

async function session(req, role) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const saved = parse(await command('GET', key('session', token)));
  return saved && (!role || saved.role === role) ? saved : null;
}

const presence = attempt => {
  if (attempt.status === 'submitted') return 'Submitted';
  const age = (Date.now() - (attempt.lastSeenAt || 0)) / 1000;
  return age < 15 ? 'Online' : age < 60 ? 'Idle' : 'Offline';
};
const cleanQuestion = (question, suite) => ({
  id: question.id,
  title: question.t,
  level: question.lvl,
  tags: question.tags,
  statement: question.task,
  sample: question.io || '',
  inputFormat: questionSpecs[String(question.id)]?.inputFormat || question.inputFormat || '',
  outputFormat: questionSpecs[String(question.id)]?.outputFormat || question.outputFormat || '',
  constraints: questionSpecs[String(question.id)]?.constraints || question.constraints || '',
  sampleTests: publicTestSuite(suite, question).sampleTests
});

async function cleanAttempt(attempt, admin = false) {
  const answers = await getAnswers(attempt);
  if (admin) {
    for (const [questionId, answer] of Object.entries(answers)) {
      if (answer.score != null && !answer.testEvaluation && answer.scoreSource !== 'admin') {
        answer.score = null;
        answer.scoreSource = 'legacy-unverified';
        await saveAnswer(attempt.id, questionId, answer);
      }
    }
  }
  return {
    id: attempt.id,
    name: attempt.name,
    set: attempt.set,
    status: presence(attempt),
    submitted: attempt.status === 'submitted',
    startedAt: attempt.startedAt,
    endAt: attempt.endAt,
    lastSeenAt: attempt.lastSeenAt,
    currentIndex: attempt.currentIndex,
    questionIds: attempt.questionIds,
    questionTitles: admin ? Object.fromEntries(attempt.questionIds.map(id => [id, questions.find(q => q.id === id)?.t || `Question ${id}`])) : undefined,
    answers: admin ? answers : undefined,
    marks: Object.values(answers).filter(answer => answer.score > 0).length,
    score: Object.values(answers).reduce((sum, answer) => sum + (Number(answer.score) || 0), 0),
    total: attempt.questionIds.length
  };
}

function candidateAnswers(answers) {
  return Object.fromEntries(Object.entries(answers || {}).map(([id, answer]) => [id, {
    code: answer.code,
    languageId: answer.languageId,
    languageName: answer.languageName,
    savedAt: answer.savedAt,
    submittedAt: answer.submittedAt,
    score: answer.score,
    runResult: answer.runResult,
    sampleCompared: answer.sampleCompared,
    passed: answer.passed,
    testEvaluation: candidateSummary(answer.testEvaluation)
  }]));
}

async function judgeRun(languageId, source, input) {
  const base = (process.env.JUDGE0_URL || 'https://ce.judge0.com').replace(/\/$/, '');
  const headers = {
    'Content-Type': 'application/json',
    ...(process.env.JUDGE0_KEY ? { 'X-Auth-Token': process.env.JUDGE0_KEY } : {})
  };
  const created = await fetch(`${base}/submissions?base64_encoded=true&wait=false`, {
    method: 'POST', headers, signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      language_id: languageId,
      source_code: Buffer.from(source).toString('base64'),
      stdin: Buffer.from(input || '').toString('base64'),
      cpu_time_limit: 3,
      wall_time_limit: 6
    })
  });
  if (!created.ok) throw Error(`Judge service returned ${created.status}`);
  const { token } = await created.json();
  if (!token) throw Error('Judge service did not return a submission token');
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(`${base}/submissions/${token}?base64_encoded=true&fields=stdout,stderr,compile_output,status,time,memory`, {
      headers, signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw Error(`Judge service returned ${response.status}`);
    const result = await response.json();
    if (result.status && ![1, 2].includes(result.status.id)) {
      for (const field of ['stdout', 'stderr', 'compile_output']) {
        if (result[field]) result[field] = Buffer.from(result[field], 'base64').toString('utf8');
      }
      return {
        status: result.status.description,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        compileOutput: result.compile_output || '',
        time: result.time || null,
        memory: result.memory || null
      };
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

async function route(req, res) {
  const url = new URL(req.url, 'https://local');
  const { pathname: path, searchParams } = url;
  const method = req.method;

  if (method === 'GET' && path === '/api/public') {
    const settings = await getSettings();
    return json(res, 200, { enabled: settings.enabled, durationMinutes: settings.durationMinutes, questionCount: settings.questionCount });
  }

  if (method === 'POST' && path === '/api/login') {
    const input = await body(req);
    const role = input.role === 'admin' ? 'admin' : 'candidate';
    const settings = await getSettings();
    if (role === 'admin') {
      if (!ADMIN_PASSWORD || input.password !== ADMIN_PASSWORD) return json(res, 401, { error: 'Incorrect admin password' });
    } else if (!settings.enabled) return json(res, 403, { error: 'The test is closed right now' });
    else if (!String(input.name || '').trim()) return json(res, 400, { error: 'Enter your name' });

    const token = crypto.randomBytes(32).toString('base64url');
    const current = { role, name: String(input.name || 'Administrator').trim(), createdAt: Date.now() };
    if (role === 'candidate') {
      const attempts = await getAllAttempts();
      let attempt = attempts.find(item => item.status === 'active' && item.name.toLowerCase() === current.name.toLowerCase());
      if (!attempt) {
        const assignedSet = settings.set === 'B' ? 'B' : 'A';
        const questionIds = sets[assignedSet === 'A' ? 'setA' : 'setB'].slice(0, settings.questionCount);
        attempt = {
          id: crypto.randomUUID(), name: current.name, set: assignedSet, status: 'active',
          startedAt: Date.now(), endAt: Date.now() + settings.durationMinutes * 60000,
          lastSeenAt: Date.now(), currentIndex: 0, questionIds
        };
        await command('SADD', key('attempts'), attempt.id);
        await saveAttempt(attempt);
      }
      current.attemptId = attempt.id;
    }
    await command('SET', key('session', token), JSON.stringify(current), 'EX', 43200);
    return json(res, 200, { token, role, name: current.name });
  }

  if (method === 'GET' && path === '/api/languages') {
    if (!await session(req, 'candidate')) return json(res, 401, { error: 'Sign in required' });
    try { return json(res, 200, { languages: await getLanguages() }); }
    catch { return json(res, 503, { error: 'Code runner unavailable. Check JUDGE0_URL.' }); }
  }

  if (method === 'GET' && path === '/api/admin/dashboard') {
    if (!await session(req, 'admin')) return json(res, 403, { error: 'Admin access required' });
    let attempts = await getAllAttempts();
    for (const attempt of attempts) {
      if (attempt.status === 'active' && Date.now() >= attempt.endAt) {
        attempt.status = 'submitted';
        attempt.submittedAt = Date.now();
        attempt.autoSubmitted = true;
        await saveAttempt(attempt);
      }
    }
    attempts = await getAllAttempts();
    const [submissions, allAttempts, testCases] = await Promise.all([getAllSubmissions(), getAllAttempts(), getTestCases()]);
    const users = allAttempts.map(attempt => ({ id: attempt.id, name: attempt.name, set: attempt.set }));
    return json(res, 200, {
      settings: await getSettings(),
      attempts: await Promise.all(attempts.map(attempt => cleanAttempt(attempt, true))),
      questions: questions.map(question => ({ id: question.id, title: question.t })),
      testCases,
      submissions,
      users
    });
  }

  if (path.startsWith('/api/admin/')) {
    if (!await session(req, 'admin')) return json(res, 403, { error: 'Admin access required' });
    if (method === 'POST' && path === '/api/admin/test-cases') {
      const input = await body(req), questionId = String(input.questionId);
      if (!questions.some(question => String(question.id) === questionId)) return json(res, 404, { error: 'Question not found' });
      try {
        const all = await getTestCases();
        const suite = normalizeTestSuite(input.suite || input.cases || [], questions.find(question => String(question.id) === questionId));
        all[questionId] = suite;
        await command('SET', key('test-cases'), JSON.stringify(all));
        return json(res, 200, { ok: true, sampleCount: suite.sampleTests.length, hiddenCount: suite.hiddenTests.length });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }

    if (method === 'POST' && path === '/api/admin/settings') {
      const input = await body(req);
      const settings = {
        enabled: !!input.enabled,
        set: input.set === 'B' ? 'B' : 'A',
        durationMinutes: Math.max(1, Math.min(600, Number(input.durationMinutes) || 240)),
        questionCount: Math.max(1, Math.min(50, Number(input.questionCount) || 50))
      };
      await saveSettings(settings);
      return json(res, 200, { settings });
    }

    if (method === 'POST' && path === '/api/admin/grade') {
      const input = await body(req), attempt = await getAttempt(input.attemptId);
      if (!attempt) return json(res, 404, { error: 'Attempt not found' });
      const answer = parse(await command('GET', key('answer', attempt.id, String(input.questionId))));
      if (!answer) return json(res, 404, { error: 'No submitted code for this question' });
      answer.score = Math.max(0, Math.min(1, Number(input.score) || 0));
      answer.adminNote = String(input.note || '').slice(0, 500);
      answer.scoreSource = 'admin';
      await saveAnswer(attempt.id, input.questionId, answer);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/api/admin/submissions/export') {
      const input = await body(req);
      const selected = new Set((Array.isArray(input.submissionIds) ? input.submissionIds : []).map(String));
      if (!selected.size) return json(res, 400, { error: 'Please select at least one submission to export.' });
      const rows = (await getAllSubmissions()).filter(submission => selected.has(submission.id));
      return json(res, 200, { csv: submissionsToCsv(rows), count: rows.length, filename: 'selected-code-submissions.csv' });
    }

    if (method === 'POST' && path === '/api/admin/submissions/export-user') {
      const input = await body(req);
      if (!input.userId) return json(res, 400, { error: 'Select a user to export.' });
      const rows = (await getAllSubmissions()).filter(submission => submission.userId === String(input.userId));
      return json(res, 200, { csv: submissionsToCsv(rows), count: rows.length, filename: 'user-code-submissions.csv' });
    }

    if (method === 'POST' && path === '/api/admin/submissions/export-all') {
      return json(res, 200, { csv: submissionsToCsv(await getAllSubmissions()), filename: 'all-code-submissions.csv' });
    }

    if (method === 'POST' && path === '/api/admin/delete-attempt') {
      const input = await body(req), attemptId = String(input.attemptId || ''), attempt = await getAttempt(attemptId);
      if (attempt?.questionIds) for (const questionId of attempt.questionIds) await command('DEL', key('answer', attemptId, String(questionId)));
      await command('DEL', key('attempt', attemptId));
      await command('SREM', key('attempts'), attemptId);
      const submissions = await getAllSubmissions();
      for (const submission of submissions.filter(item => item.userId === attemptId)) {
        await command('DEL', key('submission', submission.id));
        await command('SREM', key('submissions'), submission.id);
        await command('SREM', key('user-submissions', attemptId), submission.id);
      }
      return json(res, 200, { ok: true, deleted: attemptId });
    }

    if (method === 'POST' && path === '/api/admin/clear-all') {
      const [ids, submissions] = await Promise.all([command('SMEMBERS', key('attempts')), getAllSubmissions()]);
      for (const id of ids || []) {
        const attempt = await getAttempt(id);
        if (attempt?.questionIds) for (const questionId of attempt.questionIds) await command('DEL', key('answer', id, String(questionId)));
        await command('DEL', key('attempt', id));
      }
      for (const submission of submissions) await command('DEL', key('submission', submission.id));
      for (const id of ids || []) await command('DEL', key('user-submissions', id));
      await command('DEL', key('attempts'));
      await command('DEL', key('submissions'));
      return json(res, 200, { ok: true, count: ids?.length || 0 });
    }
    return json(res, 404, { error: 'Admin route not found' });
  }

  if (method === 'GET' && path === '/api/me') {
    const current = await session(req, 'candidate');
    if (!current) return json(res, 401, { error: 'Sign in again' });
    const attempt = await getAttempt(current.attemptId);
    if (!attempt) return json(res, 404, { error: 'Attempt not found' });
    if (attempt.status === 'active' && Date.now() >= attempt.endAt) {
      attempt.status = 'submitted'; attempt.submittedAt = Date.now();
    }
    attempt.lastSeenAt = Date.now();
    await saveAttempt(attempt);
    const [answers, testCases, submissions] = await Promise.all([getAnswers(attempt), getTestCases(), getUserSubmissions(attempt.id)]);
    return json(res, 200, {
      attempt: await cleanAttempt(attempt),
      questions: attempt.questionIds.map(id => cleanQuestion(questions.find(question => question.id === id), testCases[String(id)])),
      answers: candidateAnswers(answers),
      questionCount: attempt.questionIds.length,
      submissions: submissions.map(candidateSubmission)
    });
  }

  if (method === 'GET' && path === '/api/candidate/submissions') {
    const current = await session(req, 'candidate');
    if (!current) return json(res, 401, { error: 'Sign in required' });
    const submissions = (await getUserSubmissions(current.attemptId)).map(candidateSubmission);
    return json(res, 200, { submissions });
  }

  if (path.startsWith('/api/candidate/')) {
    const current = await session(req, 'candidate');
    if (!current) return json(res, 401, { error: 'Sign in required' });
    const attempt = await getAttempt(current.attemptId);
    if (!attempt) return json(res, 404, { error: 'Attempt not found' });

    if (method === 'POST' && path === '/api/candidate/heartbeat') {
      attempt.lastSeenAt = Date.now(); await saveAttempt(attempt);
      return json(res, 200, { status: presence(attempt) });
    }
    if (method === 'POST' && path === '/api/candidate/final-submit') {
      if (attempt.status === 'active') { attempt.status = 'submitted'; attempt.submittedAt = Date.now(); await saveAttempt(attempt); }
      return json(res, 200, { attempt: await cleanAttempt(attempt) });
    }

    if (method === 'POST' && ['/api/candidate/navigate', '/api/candidate/save', '/api/candidate/run'].includes(path)) {
      const input = await body(req);
      if (attempt.status !== 'active' || Date.now() >= attempt.endAt) return json(res, 403, { error: 'Attempt is closed' });
      if (path === '/api/candidate/navigate') {
        attempt.currentIndex = Math.max(0, Math.min(attempt.questionIds.length - 1, Number(input.index) || 0));
        attempt.lastSeenAt = Date.now(); await saveAttempt(attempt);
        return json(res, 200, { index: attempt.currentIndex });
      }

      const questionId = String(input.questionId);
      if (!attempt.questionIds.includes(Number(questionId))) return json(res, 403, { error: 'Question is not assigned to this attempt' });
      if (typeof input.code !== 'string' || input.code.length > 50000) return json(res, 400, { error: 'Code is empty or too large' });
      const answer = parse(await command('GET', key('answer', attempt.id, questionId))) || {};
      invalidateStaleEvaluation(answer, input.code);
      Object.assign(answer, {
        code: input.code,
        languageId: Number(input.languageId),
        languageName: String(input.languageName || ''),
        savedAt: Date.now()
      });
      await saveAnswer(attempt.id, questionId, answer);
      attempt.lastSeenAt = Date.now(); await saveAttempt(attempt);
      if (path === '/api/candidate/save') return json(res, 200, { savedAt: answer.savedAt });

      const question = questions.find(item => item.id === Number(questionId));
      const allSuites = await getTestCases();
      let suite;
      try { suite = normalizeTestSuite(allSuites[questionId], question); }
      catch (error) { return json(res, 422, { error: `Test suite is invalid: ${error.message}` }); }
      const isSubmit = !!input.submit;
      const cases = isSubmit ? suite.hiddenTests : suite.sampleTests;
      if (!String(input.code).trim()) {
        if (!isSubmit) return json(res, 400, { status: 'EMPTY CODE', error: 'Enter code before running.' });
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation: null, status: 'EMPTY CODE' });
        await saveSubmission(submission);
        answer.submittedAt = submission.submittedAt; answer.submissionId = submission.id; answer.finalStatus = submission.status;
        await saveAnswer(attempt.id, questionId, answer);
        return json(res, 200, { result: { status: 'EMPTY CODE', stdout: '', stderr: '', compileOutput: '' }, evaluation: { passed: 0, failed: 0, total: 0, status: submission.status, complete: false, results: [] }, submitted: true });
      }
      if (!Number.isInteger(Number(input.languageId)) || Number(input.languageId) <= 0) {
        if (!isSubmit) return json(res, 400, { status: 'INVALID LANGUAGE', error: 'Select a supported language.' });
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation: null, status: 'INVALID LANGUAGE' });
        await saveSubmission(submission);
        answer.submittedAt = submission.submittedAt; answer.submissionId = submission.id; answer.finalStatus = submission.status;
        await saveAnswer(attempt.id, questionId, answer);
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: '', compileOutput: '' }, evaluation: { passed: 0, failed: 0, total: 0, status: submission.status, complete: false, results: [] }, submitted: true });
      }
      const supportedLanguages = await getLanguages().catch(() => null);
      if (supportedLanguages && !supportedLanguages.some(language => Number(language.id) === Number(input.languageId))) {
        if (!isSubmit) return json(res, 400, { status: 'INVALID LANGUAGE', error: 'That language is not available on the configured Judge0 service.' });
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation: null, status: 'INVALID LANGUAGE' });
        await saveSubmission(submission);
        answer.submittedAt = submission.submittedAt; answer.submissionId = submission.id; answer.finalStatus = submission.status;
        await saveAnswer(attempt.id, questionId, answer);
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: '', compileOutput: '' }, evaluation: { passed: 0, failed: 0, total: 0, status: submission.status, complete: false, results: [] }, submitted: true, submission: candidateSubmission(submission) });
      }
      if (!cases.length) {
        if (!isSubmit) return json(res, 422, { status: 'EXECUTION ERROR', error: 'No visible sample tests are configured for this question yet.' });
        const evaluation = { passed: 0, total: 0, percent: null, complete: false, score: null, results: [], finalStatus: 'EXECUTION ERROR' };
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation, status: 'EXECUTION ERROR' });
        await saveSubmission(submission);
        Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: submission.status, testEvaluation: evaluation, score: null, scoreSource: 'auto' });
        await saveAnswer(attempt.id, questionId, answer);
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: '', compileOutput: '' }, evaluation: studentEvaluation(evaluation, true), submitted: true });
      }

      try {
        const evaluation = await evaluateSuite(judgeRun, Number(input.languageId), input.code, cases);
        const status = finalStatus(evaluation);
        evaluation.finalStatus = status;
        if (isSubmit) {
          const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation, status });
          await saveSubmission(submission);
          Object.assign(answer, {
            submittedAt: submission.submittedAt,
            submissionId: submission.id,
            finalStatus: status,
            testEvaluation: evaluation,
            score: evaluation.complete ? evaluation.score : null,
            scoreSource: 'auto',
            passed: status === 'ACCEPTED',
            runResult: { status, stdout: '', stderr: '', compileOutput: evaluation.results.find(result => result.compileOutput)?.compileOutput || '' },
            lastRunAt: Date.now()
          });
          await saveAnswer(attempt.id, questionId, answer);
          return json(res, 200, {
            result: answer.runResult,
            evaluation: studentEvaluation(evaluation, true),
            submitted: true,
            submission: candidateSubmission(submission)
          });
        }
        answer.runResult = { status: status === 'ACCEPTED' ? 'Accepted' : (evaluation.results.find(result => !result.passed)?.status || status), stdout: evaluation.results.map(result => result.actualOutput || '').join('\n'), stderr: evaluation.results.find(result => result.stderr)?.stderr || '', compileOutput: evaluation.results.find(result => result.compileOutput)?.compileOutput || '' };
        answer.sampleCompared = true;
        answer.passed = status === 'ACCEPTED';
        answer.lastRunAt = Date.now();
        await saveAnswer(attempt.id, questionId, answer);
        return json(res, 200, {
          result: answer.runResult,
          evaluation: studentEvaluation(evaluation, false),
          sampleCompared: true,
          passed: answer.passed,
          submitted: false
        });
      } catch (error) {
        if (!isSubmit) return json(res, 502, { status: 'EXECUTION SERVICE ERROR', error: error.message || 'Code runner unavailable' });
        const evaluation = { passed: 0, total: cases.length, percent: 0, complete: false, score: null, results: [], finalStatus: 'EXECUTION SERVICE ERROR' };
        const submission = createSubmission({ attemptId: attempt.id, question, language: answer.languageName, sourceCode: input.code, evaluation, status: 'EXECUTION SERVICE ERROR' });
        await saveSubmission(submission);
        Object.assign(answer, { submittedAt: submission.submittedAt, submissionId: submission.id, finalStatus: submission.status, testEvaluation: evaluation, score: null, scoreSource: 'auto' });
        await saveAnswer(attempt.id, questionId, answer);
        return json(res, 200, { result: { status: submission.status, stdout: '', stderr: error.message || '', compileOutput: '' }, evaluation: studentEvaluation(evaluation, true), submitted: true, submission: candidateSubmission(submission) });
      }
    }
  }
  return json(res, 404, { error: 'Not found' });
}

module.exports = async (req, res) => {
  try { return await route(req, res); }
  catch (error) {
    console.error(error.message);
    const missingStorage = !DB || !DB_TOKEN;
    return json(res, missingStorage ? 503 : 500, {
      error: missingStorage
        ? 'Online storage is not connected. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel Project Settings → Environment Variables, then redeploy.'
        : (error.message || 'Server error')
    });
  }
};
