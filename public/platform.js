/* ============================================================
   CodeArena DSA Platform · platform.js
   All candidate and admin logic for the single-page app.
============================================================ */
(() => {

/* ─── Utilities ──────────────────────────────────────────── */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const tokenStore = sessionStorage;

/* ─── Toast notifications ────────────────────────────────── */
function showToast(msg, type = 'info', dur = 4000) {
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${esc(msg)}</span>`;
  $('#toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove());
  }, dur);
}

/* ─── API helper ─────────────────────────────────────────── */
const api = async (path, opts = {}) => {
  const headers = { 'Content-Type': 'application/json',
    ...(opts.auth ? { Authorization: `Bearer ${tokenStore.getItem(opts.auth)}` } : {}) };
  const r = await fetch(path, {
    method: opts.method || 'GET',
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
  });
  let data = {};
  try { data = await r.json(); } catch {}
  if (!r.ok) throw Error(data.error || `Request failed (${r.status})`);
  return data;
};

/* ─── State ──────────────────────────────────────────────── */
let questions = [], attempt = null, index = 0;
let timerHandle, heartbeatHandle, saveHandle;
let adminAttempt = null, saveBusy = false, saveWaiters = [];
let activeLangId = '', drafts = {};
let analyticsAttempts = [], questionAnalyticsFilter = 'attempted';
let dashboardQuestions = [], dashboardCases = {}, caseQuestionKey = '';
let activeQuestionId = '';

/* ─── Language list ──────────────────────────────────────── */
const defaultLanguages = [
  { id: 110, name: 'C (Clang 19.1.7)' },
  { id: 105, name: 'C++ (GCC 14.1.0)' },
  { id: 91,  name: 'Java (JDK 17.0.6)' },
  { id: 102, name: 'JavaScript (Node.js 22.08.0)' },
  { id: 113, name: 'Python (3.14.0)' }
];

let languages = defaultLanguages;

try {
  const cache = JSON.parse(sessionStorage.getItem('judge-language-cache') || 'null');
  if (cache?.languages?.length && Date.now() - cache.savedAt < 21600000)
    languages = newestOnly(cache.languages);
} catch {}

function newestOnly(list) {
  const families = [/^C \(/, /^C\+\+/, /^Java \(/, /^JavaScript \(Node/, /^Python \(3/];
  const version = x => (x.name.match(/\d+(?:\.\d+)+/) || ['0'])[0].split('.').map(Number);
  const cmp = (a, b) => {
    const x = version(a), y = version(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d;
    }
    return a.id - b.id;
  };
  return families.map(re => list.filter(x => re.test(x.name)).sort(cmp).at(-1)).filter(Boolean);
}

function setLanguageOptions(preferred) {
  const select = $('#language');
  select.innerHTML = languages.map(l =>
    `<option value="${l.id}">${esc(l.name)}</option>`).join('');
  if (preferred && languages.some(l => String(l.id) === String(preferred)))
    select.value = String(preferred);
  else if (languages.length) select.selectedIndex = 0;
  activeLangId = select.value;
}
setLanguageOptions();

/* ─── Screen management ──────────────────────────────────── */
function show(id) {
  $$('.screen').forEach(x => {
    const isTarget = x.id === id;
    x.classList.toggle('hidden', !isTarget);
  });
}

/* ─── /api/public polling ────────────────────────────────── */
async function getPublic() {
  try {
    const p = await api('/api/public');
    const badge = $('#global-status');
    badge.classList.toggle('open', p.enabled);
    badge.querySelector('.status-text').textContent = p.enabled ? 'TEST OPEN' : 'TEST CLOSED';
    $('#join').disabled = !p.enabled;
    const note = $('#closed-note');
    if (p.enabled) {
      note.classList.add('hidden');
    } else {
      note.classList.remove('hidden');
      note.querySelector('span:last-child').textContent =
        'The assessment is closed. Ask the administrator to open it.';
    }
    if ($('#assigned-set'))
      $('#assigned-set').textContent = p.enabled
        ? 'The administrator has assigned your question set.'
        : 'Your question set will be assigned by the administrator.';
  } catch (e) {
    const badge = $('#global-status');
    badge.classList.remove('open');
    const isStorageErr = e.message?.includes('UPSTASH_REDIS') || e.message?.includes('storage');
    badge.querySelector('.status-text').textContent = 'API UNAVAILABLE';
    $('#join').disabled = true;
    $('#closed-note')?.classList.remove('hidden');
    const span = $('#closed-note')?.querySelector('span:last-child');
    if (span) span.textContent = isStorageErr
      ? 'Online database not connected. Add Upstash Redis variables in Vercel and redeploy.'
      : 'The platform API is unreachable. Check the server or Vercel deployment logs.';
  }
}

/* ─── Show admin login ───────────────────────────────────── */
function showAdminLogin() { show('admin-login'); }
window.showAdminLogin = showAdminLogin;

$$('[data-home]').forEach(b => b.onclick = () => show('landing'));

getPublic();
setInterval(getPublic, 5000);

/* ─── Candidate login ────────────────────────────────────── */
$('#join').onclick = async () => {
  const name = $('#candidate-name').value.trim();
  if (!name) { showToast('Enter your name to continue.', 'warning'); return; }
  $('#join').disabled = true;
  try {
    const r = await api('/api/login', { method: 'POST', body: { role: 'candidate', name } });
    tokenStore.setItem('candidate-token', r.token);
    await enterExam();
  } catch (e) {
    showToast(e.message, 'error');
    getPublic();
  } finally {
    $('#join').disabled = false;
  }
};

$('#candidate-name').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('#join').click();
});

/* ─── Admin login ────────────────────────────────────────── */
$('#admin-signin').onclick = async () => {
  const btn = $('#admin-signin');
  btn.disabled = true;
  $('#admin-error').textContent = '';
  try {
    const r = await api('/api/login', {
      method: 'POST',
      body: { role: 'admin', password: $('#admin-password').value }
    });
    tokenStore.setItem('admin-token', r.token);
    show('dashboard');
    await loadDashboard();
  } catch (e) {
    $('#admin-error').textContent = e.message;
  } finally {
    btn.disabled = false;
  }
};

$('#admin-password').onkeydown = e => { if (e.key === 'Enter') $('#admin-signin').click(); };
$('#admin-logout').onclick = () => {
  tokenStore.removeItem('admin-token');
  show('landing');
};

/* ─── Enter exam ─────────────────────────────────────────── */
async function enterExam() {
  try {
    const data = await api('/api/me', { auth: 'candidate-token' });
    attempt = data.attempt;
    questions = data.questions;
    index = attempt.currentIndex || 0;
    try { drafts = JSON.parse(sessionStorage.getItem(`dsa-drafts-${attempt.id}`) || '{}'); }
    catch { drafts = {}; }
    if (attempt.submitted) {
      show('exam');
      renderExam();
      finishView('Your attempt has been submitted.');
    } else {
      show('exam');
      renderExam();
      startPings();
      loadLanguages();
    }
  } catch (e) {
    tokenStore.removeItem('candidate-token');
    show('landing');
    showToast(e.message, 'error');
  }
}

/* ─── Heartbeat & timer ──────────────────────────────────── */
function startPings() {
  clearInterval(heartbeatHandle);
  clearInterval(timerHandle);
  heartbeatHandle = setInterval(() =>
    api('/api/candidate/heartbeat', { method: 'POST', body: {}, auth: 'candidate-token' })
      .catch(() => {}), 4000);
  timerHandle = setInterval(clock, 1000);
  clock();
}

/* ─── Load language list from Judge0 ────────────────────── */
async function loadLanguages() {
  try {
    const previous = selectedLanguage(), oldId = activeLangId;
    const r = await api('/api/languages', { auth: 'candidate-token' });
    if (!r.languages?.length) return;
    languages = newestOnly(r.languages);
    sessionStorage.setItem('judge-language-cache', JSON.stringify({ languages, savedAt: Date.now() }));
    const family = previous?.name.startsWith('C++') ? 'C++'
      : previous?.name.startsWith('C (') ? 'C'
      : previous?.name.startsWith('JavaScript') ? 'JavaScript'
      : previous?.name.startsWith('Java (') ? 'Java'
      : previous?.name.startsWith('Python') ? 'Python' : '';
    const next = languages.find(l => family && l.name.startsWith(family))?.id || previous?.id;
    setLanguageOptions(next);
    if (oldId !== String(next || '')) switchLanguage(true);
  } catch {}
}

function selectedLanguage() {
  return languages.find(l => String(l.id) === $('#language').value);
}

/* ─── Code templates ─────────────────────────────────────── */
function template(lang) {
  const n = (lang?.name || '').toLowerCase();
  if (n.includes('c++')) return '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    // Write your solution\n    return 0;\n}\n';
  if (n.startsWith('c (')) return '#include <stdio.h>\n\nint main(void) {\n    // Write your solution\n    return 0;\n}\n';
  if (n.startsWith('java')) return 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        // Write your solution\n    }\n}\n';
  if (n.startsWith('python')) return '# Write your solution\n';
  if (n.startsWith('javascript')) return '// Write your solution\n';
  return '';
}

/* ─── Syntax highlighting ────────────────────────────────── */
const keywordSet = 'auto break case catch char class const continue default do double else enum export extends false final finally float for function if implements import in instanceof int interface let long namespace new null package private protected public return short signed static std string struct super switch this throw true try typeof unsigned var void while using cout cin def elif except from global lambda nonlocal pass raise self with yield print async await'.split(' ');

function renderHighlight() {
  const code = $('#code'), layer = $('#highlight-code');
  if (!code || !layer) return;
  const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Za-z_$][\w$]*\b)/gm;
  let result = '', last = 0, m;
  while ((m = pattern.exec(code.value))) {
    result += esc(code.value.slice(last, m.index));
    const t = m[0];
    let cls = '';
    if (t.startsWith('//') || t.startsWith('/*') || (t.startsWith('#') && !t.startsWith('#include')))
      cls = 'syn-comment';
    else if (t.startsWith('#include')) cls = 'syn-directive';
    else if (/^['"`]/.test(t)) cls = 'syn-string';
    else if (/^\d/.test(t)) cls = 'syn-number';
    else if (keywordSet.includes(t)) cls = 'syn-keyword';
    else if (/^[A-Za-z_$]/.test(t) && code.value.slice(pattern.lastIndex).match(/^\s*\(/))
      cls = 'syn-function';
    result += cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t);
    last = pattern.lastIndex;
  }
  result += esc(code.value.slice(last)) + '\n';
  layer.innerHTML = result;
  const pre = $('#highlight');
  pre.scrollTop = code.scrollTop;
  pre.scrollLeft = code.scrollLeft;
}

/* ─── Language switching ─────────────────────────────────── */
function switchLanguage(preserve = false) {
  if (!attempt) return;
  const q = currentQuestion(), qid = String(q.id);
  const next = String($('#language').value);
  drafts[qid] || (drafts[qid] = {});
  if (preserve) drafts[qid][next] = $('#code').value;
  else if (activeLangId && activeLangId !== next) drafts[qid][activeLangId] = $('#code').value;
  persistDrafts();
  activeLangId = next;
  const saved = attempt.answers?.[q.id], lang = selectedLanguage();
  $('#code').value = drafts[qid][next] ?? (String(saved?.languageId) === next ? saved?.code : null) ?? template(lang);
  renderHighlight();
  $('#save-state').textContent = 'UNSAVED CHANGES';
  if (saveHandle) clearTimeout(saveHandle);
  saveHandle = setTimeout(() => saveCode(), 650);
}

function currentQuestion() { return questions[index]; }

/* ─── Draft persistence ──────────────────────────────────── */
function draftKey() { return attempt ? `dsa-drafts-${attempt.id}` : ''; }
function persistDrafts() { if (attempt) sessionStorage.setItem(draftKey(), JSON.stringify(drafts)); }

/* ─── Question navigation ────────────────────────────────── */
function renderNav() {
  const host = $('#question-nav');
  host.innerHTML = questions.map((q, i) =>
    `<button class="qnav ${i === index ? 'current' : ''} ${attempt.answers?.[q.id]?.savedAt ? 'saved' : ''}"
      data-index="${i}" title="Question ${i + 1}: ${esc(q.title)}">${i + 1}</button>`
  ).join('');
  host.querySelectorAll('button').forEach(b => b.onclick = () => navigate(+b.dataset.index));
}

/* ─── Parse public sample ────────────────────────────────── */
function readableSample(html) {
  const d = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return d.body.textContent.trim() || 'No sample data supplied.';
}

/* ─── Update progress bar ────────────────────────────────── */
function updateProgress() {
  if (!attempt || !questions.length) return;
  const answered = questions.filter(q => attempt.answers?.[q.id]?.savedAt).length;
  const pct = Math.round((answered / questions.length) * 100);
  const fill = $('#exam-progress-fill');
  if (fill) fill.style.width = pct + '%';
}

/* ─── Render exam screen ─────────────────────────────────── */
function renderExam() {
  const q = currentQuestion();
  if (!q) return;
  $('#exam-set').textContent = `SET ${attempt.set} · ${attempt.total} QUESTIONS`;
  $('#candidate-greeting').textContent = `Good luck, ${attempt.name}`;
  $('#question-position').textContent = `QUESTION ${index + 1} / ${questions.length}`;
  $('#question-title').textContent = q.title;
  $('#question-tags').innerHTML = `<div class="tags-row">
    ${q.tags.map(x => `<span class="tag">${esc(x)}</span>`).join('')}
    <span class="tag">LEVEL ${q.level}</span>
  </div>`;
  $('#question-statement').textContent = q.statement;
  $('#question-sample').textContent = readableSample(q.sample);

  const saved = attempt.answers?.[q.id];
  if (saved?.languageId && languages.some(l => String(l.id) === String(saved.languageId)))
    setLanguageOptions(saved.languageId);

  const lang = selectedLanguage();
  activeLangId = String(lang?.id || '');
  const byLang = drafts[q.id] || {};
  const draft = byLang[activeLangId];
  const code = draft ?? (String(saved?.languageId) === activeLangId ? saved?.code : null) ?? template(lang);
  $('#code').value = code;
  renderHighlight();

  $('#save-state').textContent = saved?.savedAt ? 'SAVED TO TEST' : 'READY';
  $('#output-box').classList.toggle('hidden', !saved?.runResult);
  if (saved?.runResult) showOutput(saved.runResult, saved.sampleCompared, saved.passed);
  $('#run-state').textContent = '';

  renderNav();
  updateProgress();
  $('#prev-question').disabled = index === 0;
  $('#next-question').disabled = index === questions.length - 1;
  clock();
}

/* ─── Countdown timer ────────────────────────────────────── */
function clock() {
  if (!attempt) return;
  const n = Math.max(0, Math.floor((attempt.endAt - Date.now()) / 1000));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  const display = $('#timer');
  if (display) {
    display.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
    display.classList.toggle('critical', n > 0 && n <= 300);
  }
  if (n === 0) finalSubmit(true);
}

/* ─── Autosave code ──────────────────────────────────────── */
async function saveCode() {
  if (!attempt || attempt.submitted) return;
  if (saveBusy) {
    await new Promise(resolve => saveWaiters.push(resolve));
    return saveCode();
  }
  const q = currentQuestion(), lang = selectedLanguage();
  if (!lang) return;
  const source = $('#code').value;
  drafts[q.id] || (drafts[q.id] = {});
  drafts[q.id][String(lang.id)] = source;
  persistDrafts();
  saveBusy = true;
  $('#save-state').textContent = 'SAVING…';
  try {
    await api('/api/candidate/save', {
      method: 'POST', auth: 'candidate-token',
      body: { questionId: q.id, code: source, languageId: lang.id, languageName: lang.name }
    });
    attempt.answers[q.id] = {
      ...(attempt.answers[q.id] || {}),
      code: source, languageId: lang.id, languageName: lang.name, savedAt: Date.now()
    };
    $('#save-state').textContent = 'ALL CHANGES SAVED';
    renderNav();
    updateProgress();
  } catch (e) {
    $('#save-state').textContent = 'SAVE FAILED';
    $('#run-state').textContent = e.message;
  } finally {
    saveBusy = false;
    saveWaiters.splice(0).forEach(r => r());
  }
}

/* ─── Editor events ──────────────────────────────────────── */
$('#code').addEventListener('input', () => {
  const q = currentQuestion(), lang = selectedLanguage();
  if (q && lang) {
    drafts[q.id] || (drafts[q.id] = {});
    drafts[q.id][String(lang.id)] = $('#code').value;
    persistDrafts();
  }
  renderHighlight();
  if (saveHandle) clearTimeout(saveHandle);
  $('#save-state').textContent = 'UNSAVED CHANGES';
  saveHandle = setTimeout(() => saveCode(), 650);
});

$('#code').addEventListener('scroll', renderHighlight);
$('#language').onchange = () => switchLanguage(false);

$('#code').addEventListener('keydown', e => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const a = e.target, s = a.selectionStart, end = a.selectionEnd;
    a.value = a.value.slice(0, s) + '    ' + a.value.slice(end);
    a.selectionStart = a.selectionEnd = s + 4;
    a.dispatchEvent(new Event('input'));
  }
});

/* ─── Navigate between questions ─────────────────────────── */
async function navigate(to) {
  if (to < 0 || to >= questions.length) return;
  if (saveHandle) clearTimeout(saveHandle);
  await saveCode();
  index = to;
  await api('/api/candidate/navigate', { method: 'POST', auth: 'candidate-token', body: { index } });
  attempt.currentIndex = index;
  renderExam();
}

$('#prev-question').onclick = () => navigate(index - 1);
$('#next-question').onclick = () => navigate(index + 1);

/* ─── Run / Submit ───────────────────────────────────────── */
async function run(submit) {
  if (saveHandle) clearTimeout(saveHandle);
  const q = currentQuestion(), lang = selectedLanguage();
  const btn = submit ? $('#submit-code') : $('#run-code');
  if (!lang) { showToast('The code runner is unavailable. Try refreshing.', 'error'); return; }
  await saveCode();
  btn.disabled = true;
  $('#run-state').textContent = submit ? 'Checking test cases…' : 'Running sample…';
  try {
    const r = await api('/api/candidate/run', {
      method: 'POST', auth: 'candidate-token',
      body: { questionId: q.id, languageId: lang.id, languageName: lang.name, code: $('#code').value, submit }
    });
    const old = attempt.answers[q.id] || {};
    const code = $('#code').value;
    const changed = old.code !== code;
    attempt.answers[q.id] = {
      ...old, code, languageId: lang.id, languageName: lang.name,
      runResult: r.result, sampleCompared: r.sampleCompared, passed: r.passed,
      testEvaluation: r.evaluation || (changed ? null : old.testEvaluation),
      score: r.evaluation?.total
        ? (r.evaluation.complete ? r.evaluation.passed / r.evaluation.total : null)
        : (changed ? null : old.score),
      submittedAt: submit ? Date.now() : (changed ? null : old.submittedAt)
    };
    showOutput(r.result, r.sampleCompared, r.passed);
    if (submit) {
      const ev = r.evaluation;
      if (ev?.total) {
        const msg = ev.complete
          ? `${ev.passed}/${ev.total} test cases passed (${ev.percent}%)`
          : 'Judge unavailable — ask admin to retry';
        showToast(msg, ev.passed === ev.total ? 'success' : 'warning');
        $('#run-state').textContent = msg;
      } else {
        showToast('No test cases configured — saved for admin review.', 'info');
        $('#run-state').textContent = 'No test cases configured · saved for admin review';
      }
    } else {
      const msg = r.sampleCompared
        ? (r.passed ? '✓ Sample passed' : '✕ Sample did not match expected output')
        : 'Sample run completed';
      $('#run-state').textContent = msg;
      showToast(msg, r.passed ? 'success' : r.sampleCompared ? 'error' : 'info', 3000);
    }
    renderNav();
    updateProgress();
  } catch (e) {
    $('#run-state').textContent = e.message;
    $('#output-box').classList.remove('hidden');
    $('#output-title').textContent = 'RUNNER ERROR';
    $('#output-text').textContent = e.message;
    showToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function showOutput(r, compared, passed) {
  $('#output-box').classList.remove('hidden');
  $('#output-title').textContent =
    `${r.status || 'RESULT'}` +
    (compared ? (passed ? ' · SAMPLE MATCH ✓' : ' · SAMPLE MISMATCH ✕') : '') +
    (r.time ? ` · ${r.time}s` : '');
  $('#output-text').textContent = [
    r.compileOutput && `COMPILE OUTPUT\n${r.compileOutput}`,
    r.stdout && `STDOUT\n${r.stdout}`,
    r.stderr && `STDERR\n${r.stderr}`,
    !r.compileOutput && !r.stdout && !r.stderr ? 'No output.' : null
  ].filter(Boolean).join('\n\n');
}

$('#run-code').onclick = () => run(false);
$('#submit-code').onclick = () => run(true);
$('#finish-exam').onclick = () => finalSubmit(false);

/* ─── Final submission ───────────────────────────────────── */
async function finalSubmit(auto) {
  if (!attempt || attempt.submitted) return;
  if (!auto && !confirm('Finish the test and submit your attempt?\n\nYou cannot edit answers after submission.')) return;
  try {
    if (saveHandle) clearTimeout(saveHandle);
    await saveCode();
    const d = await api('/api/candidate/final-submit', {
      method: 'POST', auth: 'candidate-token', body: { auto }
    });
    attempt = d.attempt;
    attempt.submitted = true;
    finishView(auto ? '⏱ Time is up. Your attempt has been auto-submitted.' : '✓ Your attempt has been submitted successfully.');
  } catch (e) {
    showToast(e.message, 'error');
  }
}

function finishView(message) {
  clearInterval(heartbeatHandle);
  clearInterval(timerHandle);
  clearTimeout(saveHandle);
  $('#exam').innerHTML = `
    <div style="max-width:580px;margin:14vh auto;text-align:center">
      <div class="glass-card" style="padding:48px 40px">
        <div style="font-size:64px;margin-bottom:16px">🏆</div>
        <div class="eyebrow">ASSESSMENT SUBMITTED</div>
        <h1 style="font-size:40px;margin:16px 0 10px">Thank you,<br><em>${esc(attempt?.name || 'Candidate')}</em></h1>
        <p style="color:var(--text2);font-size:16px;margin:16px 0">${esc(message)}</p>
        <p style="color:var(--muted);font-size:12px;margin-top:24px">Your submitted code is saved for administrator review.<br>You may close this window.</p>
      </div>
    </div>`;
}

/* ─── Admin dashboard ────────────────────────────────────── */
async function loadDashboard() {
  if (!sessionStorage.getItem('admin-token')) return show('admin-login');
  try {
    const d = await api('/api/admin/dashboard', { auth: 'admin-token' });
    renderDashboard(d);
  } catch (e) {
    sessionStorage.removeItem('admin-token');
    show('admin-login');
    $('#admin-error').textContent = e.message;
  }
}

async function refreshDashboard() {
  if (!sessionStorage.getItem('admin-token') || $('#dashboard').classList.contains('hidden')) return;
  try {
    const d = await api('/api/admin/dashboard', { auth: 'admin-token' });
    renderDashboard(d);
  } catch {}
}

setInterval(refreshDashboard, 3000);

/* ─── Dashboard rendering ────────────────────────────────── */
function renderDashboard(d) {
  show('dashboard');
  renderCaseManager(d);
  renderQuestionAnalytics(d);

  const s = d.settings;
  const toggle = $('#toggle-test');
  toggle.classList.toggle('on', s.enabled);
  toggle.classList.toggle('off', !s.enabled);
  $('#access-title').textContent = s.enabled ? 'Test is open' : 'Test is closed';
  $('#access-subtitle').textContent = s.enabled
    ? 'Candidates can join now'
    : 'Candidates cannot start while closed';
  $('#set-setting').value = s.set;
  $('#duration-setting').value = String(s.durationMinutes);
  $('#count-setting').value = String(s.questionCount);

  const a = d.attempts;
  const live = a.filter(x => x.status === 'Online').length;
  const done = a.filter(x => x.submitted).length;
  const scored = a.reduce((n, x) => n + x.score, 0);
  const max = a.reduce((n, x) => n + x.total, 0);
  const evs = a.flatMap(x => Object.values(x.answers || {}).map(y => y.testEvaluation).filter(y => y?.total));
  const caseRuns = evs.flatMap(x => x.results || []);
  const judged = caseRuns.filter(x => !x.runnerError);
  const passed = judged.filter(x => x.passed).length;
  const tests = judged.length;
  const judgeErrors = caseRuns.filter(x => x.runnerError).length;
  const percent = tests ? Math.round(passed / tests * 100) : null;

  $('#metrics').innerHTML = [
    { val: a.length, lbl: 'Candidates' },
    { val: live, lbl: 'Online Now' },
    { val: done, lbl: 'Submitted' },
    { val: `${scored.toFixed(1)} / ${max}`, lbl: 'Marks Awarded' },
    { val: tests ? `${percent}%` : '—', lbl: `Cases · ${passed}/${tests}${judgeErrors ? ` · ${judgeErrors} errors` : ''}` }
  ].map(m => `<div class="metric"><strong>${m.val}</strong><span>${m.lbl}</span></div>`).join('');

  // Candidate table
  if (!a.length) {
    $('#candidate-table').innerHTML = '<div class="empty">No candidates have joined yet.</div>';
  } else {
    const statusClass = s => ({
      'Online': 'chip-online', 'Idle': 'chip-idle',
      'Offline': 'chip-offline', 'Submitted': 'chip-submitted'
    })[s] || 'chip-offline';

    $('#candidate-table').innerHTML = `
      <div class="candidate-table-wrap">
        <table class="cand-table">
          <thead><tr>
            <th>Candidate</th><th>Set</th><th>Status</th>
            <th>Position</th><th>Submitted</th><th>Marks</th>
            <th>Cases</th><th>Elapsed</th><th></th>
          </tr></thead>
          <tbody>${a.map(x => {
            const ans = Object.values(x.answers || {});
            const xs = ans.map(y => y.testEvaluation).filter(y => y?.total);
            const res = xs.flatMap(y => y.results || []);
            const jud = res.filter(y => !y.runnerError);
            const p = jud.filter(y => y.passed).length, t = jud.length;
            const errs = res.filter(y => y.runnerError).length;
            const dot = x.status === 'Online' ? '<span class="pulse-dot" style="margin-right:4px"></span>' : '● ';
            return `<tr>
              <td class="td-name">${esc(x.name)}</td>
              <td>Set ${x.set}</td>
              <td><span class="status-chip ${statusClass(x.status)}">${dot}${x.status.toUpperCase()}</span></td>
              <td>${Math.min(x.currentIndex + 1, x.total)} / ${x.total}</td>
              <td>${ans.filter(y => y.submittedAt).length}</td>
              <td>${Number(x.score).toFixed(2)} / ${x.total}</td>
              <td>${t ? `${p}/${t} · ${Math.round(p/t*100)}%${errs ? ` · ${errs} err` : ''}` : '—'}</td>
              <td>${Math.max(0, Math.floor((Date.now() - x.startedAt) / 60000))}m</td>
              <td><button class="btn btn-ghost review-btn" data-id="${x.id}" style="padding:6px 12px;font-size:11px">Review</button></td>
            </tr>`;
          }).join('')}</tbody>
        </table>
      </div>`;
  }

  $$('.review-btn').forEach(b => b.onclick = () => {
    adminAttempt = a.find(x => x.id === b.dataset.id);
    renderReview(adminAttempt);
  });

  if (adminAttempt) {
    const fresh = a.find(x => x.id === adminAttempt.id);
    if (fresh) { adminAttempt = fresh; renderReview(fresh); }
  }
}

/* ─── Question analytics ─────────────────────────────────── */
function measuredCases(evaluation) {
  const results = evaluation?.results || [];
  const judged = results.filter(x => !x.runnerError);
  return { passed: judged.filter(x => x.passed).length, total: judged.length, errors: results.filter(x => x.runnerError).length };
}

function questionRecords(qid) {
  return analyticsAttempts.filter(a => (a.questionIds || []).map(String).includes(String(qid)))
    .map(a => ({ attempt: a, answer: a.answers?.[qid] || a.answers?.[String(qid)] || null }));
}

function questionStats(qid) {
  const records = questionRecords(qid);
  const submitted = records.filter(x => x.answer?.submittedAt);
  const evaluated = submitted.filter(x => x.answer?.testEvaluation?.complete);
  const fullyCorrect = evaluated.filter(x => x.answer.testEvaluation.passed === x.answer.testEvaluation.total);
  const measured = submitted.map(x => measuredCases(x.answer?.testEvaluation));
  const passed = measured.reduce((n, x) => n + x.passed, 0);
  const total = measured.reduce((n, x) => n + x.total, 0);
  const judgeErrors = measured.reduce((n, x) => n + x.errors, 0);
  const notStarted = records.filter(x => !x.answer?.savedAt && !x.answer?.submittedAt).length;
  const notSubmitted = records.length - submitted.length;
  return { records, submitted, evaluated, fullyCorrect, passed, total, judgeErrors, notStarted, notSubmitted, percent: total ? Math.round(passed / total * 100) : null };
}

function renderQuestionAnalytics(d) {
  analyticsAttempts = d.attempts || [];
  const assigned = new Set(analyticsAttempts.flatMap(a => a.questionIds || []));
  const attempted = new Set(analyticsAttempts.flatMap(a =>
    Object.entries(a.answers || {}).filter(([,x]) => x?.savedAt || x?.submittedAt).map(([id]) => Number(id))));
  const available = (d.questions || []).filter(q => assigned.has(q.id));
  const qs = questionAnalyticsFilter === 'all' ? available : available.filter(q => attempted.has(q.id));

  $('#question-count-badge').textContent = `${qs.length} ${questionAnalyticsFilter === 'all' ? 'ASSIGNED' : 'ATTEMPTED'}`;
  $('#question-filter-attempted').textContent = `Attempted · ${attempted.size}`;
  $('#question-filter-all').textContent = `All assigned · ${available.length}`;
  $('#question-filter-attempted').classList.toggle('active', questionAnalyticsFilter === 'attempted');
  $('#question-filter-all').classList.toggle('active', questionAnalyticsFilter === 'all');

  $$('[data-qfilter]').forEach(b => b.onclick = () => {
    questionAnalyticsFilter = b.dataset.qfilter;
    renderQuestionAnalytics(d);
  });

  $('#question-cards').innerHTML = qs.length ? qs.map(q => {
    const s = questionStats(q.id);
    const status = !s.records.length ? 'NO ATTEMPTS'
      : s.notSubmitted ? 'IN PROGRESS'
      : !s.evaluated.length ? 'NEEDS REVIEW'
      : s.fullyCorrect.length === s.submitted.length ? 'FULLY CORRECT'
      : 'CHECK ANSWERS';
    const statusCls = status === 'FULLY CORRECT' ? 'tile-correct'
      : status === 'IN PROGRESS' ? 'tile-progress' : 'tile-review';
    return `<button class="question-tile" data-question-id="${q.id}">
      <span class="question-tile-id">Q${q.id}</span>
      <span class="question-tile-title">${esc(q.title)}</span>
      <span class="question-tile-meta">${s.submitted.length}/${s.records.length} submitted · ${s.total ? `${s.passed}/${s.total} cases` : 'No cases evaluated'}</span>
      <span class="question-tile-status ${statusCls}">${status}</span>
    </button>`;
  }).join('') : '<div class="empty">No attempted questions yet. Switch to "All assigned" to inspect the full test set.</div>';

  $$('.question-tile').forEach(b => b.onclick = () => openQuestionAnalytics(b.dataset.questionId, d.questions || []));
  const modal = $('#question-modal');
  modal.onclick = e => {
    if (e.target === modal || e.target.classList.contains('question-modal-shade')) closeQuestionAnalytics();
  };
  if (activeQuestionId && !modal.classList.contains('hidden'))
    renderQuestionModal(activeQuestionId, d.questions || []);
}

function openQuestionAnalytics(qid, qs) {
  activeQuestionId = String(qid);
  $('#question-modal').classList.remove('hidden');
  renderQuestionModal(activeQuestionId, qs);
  document.body.classList.add('modal-open');
}

function closeQuestionAnalytics() {
  activeQuestionId = '';
  $('#question-modal').classList.add('hidden');
  document.body.classList.remove('modal-open');
}

function renderQuestionModal(qid, qs) {
  const q = qs.find(x => String(x.id) === String(qid));
  if (!q) return;
  const s = questionStats(qid);
  const cases = dashboardCases[qid] || [];
  const ring = s.percent === null ? '0deg' : `${s.percent * 3.6}deg`;
  const fully = s.fullyCorrect.length;
  const content = $('#question-modal-content');
  content.innerHTML = `
    <div class="question-modal-head">
      <div>
        <div class="eyebrow">QUESTION ${esc(qid)} · RESULTS</div>
        <h2>${esc(q.title)}</h2>
      </div>
      <button id="close-question-modal" class="btn btn-ghost" aria-label="Close" style="flex-shrink:0">✕ Close</button>
    </div>
    <div class="question-result-hero">
      <div class="progress-ring" style="--ring:${ring}">
        <div>
          <strong>${s.percent === null ? '—' : `${s.percent}%`}</strong>
          <span>CASE PASS RATE</span>
        </div>
      </div>
      <div class="question-result-summary">
        <h3>${fully && fully === s.submitted.length && s.submitted.length === s.records.length
          ? 'Fully correct' : s.submitted.length ? 'Assessment in progress' : 'Not started'}</h3>
        <p>${s.total ? `${s.passed} of ${s.total} evaluated test cases passed` : 'No test cases evaluated'}${s.judgeErrors ? ` · ${s.judgeErrors} judge errors` : ''}</p>
        <p>${fully} fully correct · ${s.submitted.length - fully} submitted needing review</p>
      </div>
    </div>
    <div class="question-stat-grid">
      <div><strong>${s.records.length}</strong><span>Assigned</span></div>
      <div><strong>${s.submitted.length}</strong><span>Submitted</span></div>
      <div><strong>${s.notStarted}</strong><span>Not started</span></div>
      <div><strong>${s.evaluated.length}</strong><span>Auto-graded</span></div>
      <div><strong>${s.records.length - s.evaluated.length}</strong><span>Not completed</span></div>
      <div><strong>${fully}</strong><span>Fully correct</span></div>
      <div><strong>${s.total - s.passed}</strong><span>Failed cases</span></div>
    </div>
    <div class="eyebrow candidate-results-label">CANDIDATE RESULTS</div>
    <div class="question-candidate-results">
      ${s.records.map(({ attempt, answer }) => {
        const ev = answer?.testEvaluation, mc = measuredCases(ev);
        const state = !answer?.submittedAt
          ? (answer?.savedAt ? 'IN PROGRESS' : 'NOT STARTED')
          : !ev?.total ? 'MANUAL REVIEW'
          : !ev.complete ? 'JUDGE ERROR'
          : ev.passed === ev.total ? 'FULLY CORRECT' : 'NEEDS CORRECTION';
        const results = ev?.results?.map(t => {
          const tc = cases[t.index - 1] || {};
          return `<div class="question-case-row">
            <div class="case-state ${t.passed ? 'case-pass' : t.runnerError ? 'case-error' : 'case-fail'}">
              ${t.passed ? 'PASS' : t.runnerError ? 'JUDGE ERR' : 'FAIL'}
            </div>
            <div>
              <b>Test case ${t.index}</b>
              <small>Input</small><pre>${esc(t.input ?? tc.input ?? '')}</pre>
              <small>Expected</small><pre>${esc(t.expectedOutput ?? tc.expectedOutput ?? '')}</pre>
              <small>Actual</small><pre>${esc(t.compileOutput || t.stderr || t.actualOutput || '(No output)')}</pre>
            </div>
          </div>`;
        }).join('') || '';
        return `<details class="question-candidate-row">
          <summary>
            <span>${esc(attempt.name)}</span>
            <span>${state}</span>
            <span>${ev?.total ? `${mc.passed}/${mc.total} cases · ${mc.total ? Math.round(mc.passed/mc.total*100) : 0}%` : '—'}</span>
          </summary>
          <div class="question-candidate-detail">
            ${ev?.total ? results : '<p class="ungraded-note">No test suite result. Configure cases and have the candidate submit, or review manually.</p>'}
          </div>
        </details>`;
      }).join('') || '<div class="empty">No candidate has been assigned this question.</div>'}
    </div>
    <div class="question-modal-foot">
      <span>${cases.length} admin test case${cases.length !== 1 ? 's' : ''} configured</span>
      <button id="close-question-modal-bottom" class="btn btn-ghost">Close</button>
    </div>`;
  $('#close-question-modal').onclick = closeQuestionAnalytics;
  $('#close-question-modal-bottom').onclick = closeQuestionAnalytics;
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && activeQuestionId) closeQuestionAnalytics();
});

/* ─── Test case manager ──────────────────────────────────── */
function renderCaseRows() {
  const id = $('#case-question').value;
  const cases = dashboardCases[id] || [];
  $('#case-rows').innerHTML = cases.length
    ? cases.map((t, i) => `
      <div class="case-row">
        <div class="case-number">CASE ${i + 1}</div>
        <label>Input<textarea data-test-input rows="4" placeholder="stdin for this case">${esc(t.input)}</textarea></label>
        <label>Expected output<textarea data-test-output rows="4" placeholder="exact expected output">${esc(t.expectedOutput)}</textarea></label>
        <button class="btn btn-ghost remove-case" type="button" aria-label="Remove case" style="align-self:start;margin-top:22px">✕</button>
      </div>`).join('')
    : '<div class="empty">No cases configured. Add a case to enable automatic scoring.</div>';
}

function renderCaseManager(d) {
  dashboardQuestions = d.questions || [];
  dashboardCases = d.testCases || {};
  const key = dashboardQuestions.map(q => q.id).join(',');
  if (key !== caseQuestionKey) {
    caseQuestionKey = key;
    $('#case-question').innerHTML = dashboardQuestions.map(q =>
      `<option value="${q.id}">Q${q.id} · ${esc(q.title)}</option>`).join('');
    $('#case-question').onchange = renderCaseRows;
    renderCaseRows();
  }
}

$('#case-question').onchange = () => renderCaseRows();

$('#add-case').onclick = () => {
  const count = $$('#case-rows .case-row').length;
  if (count >= 20) { showToast('Maximum 20 test cases per question.', 'warning'); return; }
  const div = document.createElement('div');
  div.className = 'case-row';
  div.innerHTML = `
    <div class="case-number">CASE ${count + 1}</div>
    <label>Input<textarea data-test-input rows="4" placeholder="stdin for this case"></textarea></label>
    <label>Expected output<textarea data-test-output rows="4" placeholder="expected output"></textarea></label>
    <button class="btn btn-ghost remove-case" type="button" style="align-self:start;margin-top:22px">✕</button>`;
  $('#case-rows').append(div);
};

$('#case-rows').onclick = e => {
  if (e.target.closest('.remove-case')) {
    e.target.closest('.case-row').remove();
    if (!$$('#case-rows .case-row').length) renderCaseRows();
  }
};

$('#save-cases').onclick = async () => {
  const state = $('#case-save-state');
  const rows = $$('#case-rows .case-row');
  const all = rows.map(row => ({
    input: row.querySelector('[data-test-input]').value,
    expectedOutput: row.querySelector('[data-test-output]').value
  }));
  const cases = all.filter(x => x.input || x.expectedOutput);
  state.textContent = 'Saving…';
  try {
    const id = $('#case-question').value;
    await api('/api/admin/test-cases', {
      method: 'POST', auth: 'admin-token',
      body: { questionId: id, cases }
    });
    dashboardCases[id] = cases;
    state.textContent = `Saved · ${cases.length} case${cases.length !== 1 ? 's' : ''}`;
    showToast(`${cases.length} test case${cases.length !== 1 ? 's' : ''} saved.`, 'success');
    await loadDashboard();
  } catch (e) {
    state.textContent = e.message;
    showToast(e.message, 'error');
  }
};

/* ─── Settings ───────────────────────────────────────────── */
$('#toggle-test').onclick = () => saveSettings({ enabled: !$('#toggle-test').classList.contains('on') });
$('#set-setting').onchange = () => saveSettings({ set: $('#set-setting').value });
$('#duration-setting').onchange = () => saveSettings({ durationMinutes: +$('#duration-setting').value });
$('#count-setting').onchange = () => saveSettings({ questionCount: +$('#count-setting').value });

async function saveSettings(update) {
  const b = $('#settings-saved');
  b.textContent = 'SAVING…';
  try {
    await api('/api/admin/settings', {
      method: 'POST', auth: 'admin-token',
      body: {
        enabled: $('#toggle-test').classList.contains('on'),
        set: $('#set-setting').value,
        durationMinutes: +$('#duration-setting').value,
        questionCount: +$('#count-setting').value,
        ...update
      }
    });
    b.textContent = 'SAVED ✓';
    setTimeout(() => { b.textContent = ''; }, 2000);
    await loadDashboard();
  } catch (e) {
    b.textContent = e.message;
    showToast(e.message, 'error');
  }
}

/* ─── Candidate review ───────────────────────────────────── */
function renderReview(a) {
  const review = $('#review-area');
  if (!a) { review.innerHTML = ''; return; }
  const entries = Object.entries(a.answers || {}).sort((x, y) => Number(x[0]) - Number(y[0]));
  review.innerHTML = `
    <div class="glass-card panel-section candidate-review-card" style="margin-top:14px">
      <div class="review-card-head">
        <div>
          <div class="eyebrow">SUBMISSION REVIEW</div>
          <h3>${esc(a.name)} · Set ${a.set}</h3>
          <span class="review-submeta">${a.submitted ? 'SUBMITTED' : 'IN PROGRESS'} · ${Number(a.score).toFixed(2)} / ${a.total} marks</span>
        </div>
        <button id="close-review" class="btn btn-ghost">✕ Close Review</button>
      </div>
      <div class="answer-list">
        ${entries.map(([qid, x]) => {
          const ev = x.testEvaluation;
          const score = x.score == null ? 'UNMARKED' : `${(Number(x.score) * 100).toFixed(0)}% mark`;
          const results = ev?.results?.map(t =>
            `<div class="case-result ${t.passed ? 'case-pass' : 'case-fail'}">
              <b>Case ${t.index} · ${t.passed ? 'PASS ✓' : esc(t.status) || 'FAIL ✕'}</b>
              <small>${t.time ? `${esc(t.time)}s` : 'Result'}</small>
              <pre>${esc(t.compileOutput || t.stderr || t.actualOutput || '(No output)')}</pre>
            </div>`
          ).join('') || '';
          return `<details>
            <div class="answer-review">
              <summary>${esc(a.questionTitles?.[qid] || `Q${qid}`)} · ${esc(x.languageName || 'Code')} · ${x.submittedAt ? 'Submitted' : 'Draft'} · ${score}${ev?.total ? ` · ${ev.passed}/${ev.total} cases (${ev.percent}%)` : ''}</summary>
              <div class="answer-review-body">
                <pre>${esc(x.code || '(No code saved)')}</pre>
                ${ev?.total ? `<div class="case-results">${results}</div>` : '<p class="ungraded-note">No configured cases — manual review required.</p>'}
                <div class="review-controls">
                  <label>Mark (0–1)</label>
                  <input data-score="${esc(qid)}" type="number" min="0" max="1" step="0.01" value="${x.score == null ? '0' : Number(x.score)}">
                  <input data-note="${esc(qid)}" type="text" placeholder="Feedback / note" value="${esc(x.adminNote || '')}">
                  <button class="btn btn-ghost grade" data-q="${esc(qid)}" style="font-size:11px">Save Mark</button>
                </div>
              </div>
            </div>
          </details>`;
        }).join('') || '<div class="empty">No code submitted.</div>'}
      </div>
    </div>`;

  $('#close-review').onclick = () => { adminAttempt = null; review.innerHTML = ''; };
  review.querySelectorAll('.grade').forEach(b => b.onclick = async () => {
    const id = b.dataset.q;
    try {
      await api('/api/admin/grade', {
        method: 'POST', auth: 'admin-token',
        body: {
          attemptId: a.id, questionId: id,
          score: review.querySelector(`[data-score="${id}"]`).value,
          note: review.querySelector(`[data-note="${id}"]`).value
        }
      });
      showToast('Mark saved successfully.', 'success', 2000);
      await loadDashboard();
    } catch (e) {
      showToast(e.message, 'error');
    }
  });
}

/* ─── Particle canvas ────────────────────────────────────── */
(function initParticles() {
  const canvas = document.getElementById('particle-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function mkParticle() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.4 + 0.3,
      dx: (Math.random() - 0.5) * 0.22,
      dy: (Math.random() - 0.5) * 0.22,
      a: Math.random() * 0.55 + 0.1
    };
  }

  function init() {
    resize();
    particles = Array.from({ length: 90 }, mkParticle);
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(139,111,255,${p.a})`;
      ctx.fill();
      p.x += p.dx; p.y += p.dy;
      if (p.x < -5) p.x = W + 5;
      if (p.x > W + 5) p.x = -5;
      if (p.y < -5) p.y = H + 5;
      if (p.y > H + 5) p.y = -5;
    });
    requestAnimationFrame(draw);
  }

  init();
  window.addEventListener('resize', resize);
  draw();
})();

/* ─── Route on load ──────────────────────────────────────── */
if (location.pathname === '/control-room' || location.search.includes('admin')) {
  if (sessionStorage.getItem('admin-token')) {
    show('dashboard');
    loadDashboard();
  } else {
    show('admin-login');
  }
} else {
  const candidateToken = sessionStorage.getItem('candidate-token');
  if (candidateToken) enterExam();
}

})();
