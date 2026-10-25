#!/usr/bin/env node
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { CSV_COLUMNS } = require('../lib/platform');

if (!process.argv.includes('--live')) {
  console.error('This starts an isolated local server and submits code to Judge0. Re-run with --live to opt in.');
  process.exit(2);
}
const root = path.resolve(__dirname, '..');
const password = `e2e-${Date.now()}-private`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsa-platform-e2e-'));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => socket.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function request(base, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120000)
  });
  const data = await response.json();
  if (!response.ok) throw Error(`${method} ${route} returned ${response.status}: ${data.error || JSON.stringify(data)}`);
  return data;
}

(async () => {
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [path.join(root, 'local-server.cjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DSA_DATA_DIR: dataDir, ADMIN_PASSWORD: password },
    stdio: ['ignore', 'ignore', 'inherit']
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { if ((await fetch(`${base}/api/ping`)).ok) { ready = true; break; } } catch {}
      if (server.exitCode != null) throw Error(`Local server exited with status ${server.exitCode}`);
      await wait(250);
    }
    assert.ok(ready, 'local server should start');
    const admin = await request(base, '/api/login', { method: 'POST', body: { role: 'admin', password } });
    await request(base, '/api/admin/settings', { method: 'POST', token: admin.token, body: { enabled: true, set: 'B', questionCount: 50, durationMinutes: 60 } });
    const languages = (await request(base, '/api/languages', { token: (await request(base, '/api/login', { method: 'POST', body: { role: 'candidate', name: 'E2E Candidate' } })).token })).languages;
    const java = languages.find(language => /^Java \(/.test(language.name));
    assert.ok(java, 'Judge0 Java language is available');
    const candidate = await request(base, '/api/login', { method: 'POST', body: { role: 'candidate', name: 'E2E Candidate 2' } });
    const me = await request(base, '/api/me', { token: candidate.token });
    const question = me.questions.find(item => item.id === 3);
    assert.ok(question, 'Set B assigns the configured sum question');
    assert.equal(question.sampleTests.length, 2);
    assert.equal(question.inputFormat.length > 0, true);
    const answer = me.answers['3'] || {};
    const javaCode = 'import java.util.*; public class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in); int n=s.nextInt(); long sum=0; for(int i=0;i<n;i++)sum+=s.nextLong(); System.out.println(sum); } }';

    const sample = await request(base, '/api/candidate/run', { method: 'POST', token: candidate.token, body: { questionId: 3, languageId: java.id, languageName: java.name, code: javaCode, submit: false } });
    assert.equal(sample.evaluation.passed, 2, 'both public samples pass');
    assert.equal(sample.sampleCompared, true);
    assert.equal(sample.submitted, false);

    const official = await request(base, '/api/candidate/run', { method: 'POST', token: candidate.token, body: { questionId: 3, languageId: java.id, languageName: java.name, code: javaCode, submit: true } });
    assert.equal(official.evaluation.passed, 3, 'all three hidden tests pass');
    assert.equal(official.evaluation.status, 'ACCEPTED');
    assert.equal(official.submitted, true);
    assert.ok(official.submission?.submissionId);
    assert.ok(!JSON.stringify(official.evaluation).includes('6\\n-10 -5 0 7 8 20'));

    const wrong = await request(base, '/api/candidate/run', { method: 'POST', token: candidate.token, body: { questionId: 3, languageId: java.id, languageName: java.name, code: 'public class Main { public static void main(String[] args) { System.out.println(42); } }', submit: true } });
    assert.equal(wrong.evaluation.status, 'WRONG ANSWER');
    assert.equal(wrong.evaluation.failed, 3);

    const history = await request(base, '/api/candidate/submissions', { token: candidate.token });
    assert.equal(history.submissions.length, 2);
    assert.ok(!JSON.stringify(history).includes('sourceCode'));
    assert.equal((await fetch(`${base}/api/admin/dashboard`, { headers: { Authorization: `Bearer ${candidate.token}` } })).status, 403);
    assert.equal((await fetch(`${base}/api/admin/submissions/export-all`, { method: 'POST', headers: { Authorization: `Bearer ${candidate.token}`, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);

    const dashboard = await request(base, '/api/admin/dashboard', { token: admin.token });
    assert.equal(dashboard.submissions.length, 2);
    const adminAttempt = dashboard.attempts.find(item => item.name === 'E2E Candidate 2');
    assert.ok(adminAttempt);
    assert.equal(dashboard.testCases['3'].hiddenTests.length, 3);

    const selected = await request(base, '/api/admin/submissions/export', { method: 'POST', token: admin.token, body: { submissionIds: [official.submission.submissionId] } });
    assert.equal(selected.count, 1);
    const csvHeader = selected.csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    assert.deepEqual(csvHeader.split(','), CSV_COLUMNS);
    assert.ok(selected.csv.includes(javaCode));
    assert.ok(!/email|ip address|user id/i.test(csvHeader));
    const userExport = await request(base, '/api/admin/submissions/export-user', { method: 'POST', token: admin.token, body: { userId: adminAttempt.id } });
    assert.equal(userExport.count, 2);
    const allExport = await request(base, '/api/admin/submissions/export-all', { method: 'POST', token: admin.token, body: {} });
    assert.ok(allExport.csv.includes(javaCode));

    console.log(`PASS: local API + Judge0 ${java.name}; 2 visible cases, 3 hidden cases, accepted/wrong answer judgments, owner-only history, admin access control, and selected/user/all CSV export.`);
  } finally {
    server.kill('SIGTERM');
    await wait(300);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
