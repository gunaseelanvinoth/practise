# ⬡ CodeArena — DSA Assessment Platform

A real-time online coding-test platform for administrators and candidates. Candidates solve DSA problems by writing and running code in C, C++, Java, Python, or JavaScript. The administrator monitors both candidates live, reviews submitted code, and awards marks.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎨 Animated UI | Dark cosmic theme with particle canvas, glassmorphism cards, animated aurora gradient |
| 👤 Candidate portal | Login page, timer, question navigation, Monaco editor with a textarea fallback, reset/clear controls |
| 🔐 Admin dashboard | Password-protected control room with live candidate monitoring |
| ⚡ Code execution | Server-side via Judge0 CE; sample runs use visible tests and official submissions use private tests |
| 📊 Analytics | Question-level stats, per-candidate test case pass/fail, score breakdown |
| 🧾 Official submissions | Saved source, language, timestamp, status and per-test results; candidates see only their own history |
| 📤 CSV exports | Admin-selected submissions, user-filtered exports, or all results; eight documented columns, no email/IP fields |
| 🧪 Separate test suites | Admins can maintain public samples and hidden grading cases independently for every question |
| 💾 Persistent storage | Upstash Redis for production; local file-based for development |
| 🔄 Autosave | Code saved every 650 ms of idle time, preserved across refreshes |
| 🌐 Dual deployment | Works locally and on Vercel |

---

## 🚀 Quick Start (Local)

### Prerequisites
- Node.js 18+

### Steps

```bash
# 1. Clone the repository
git clone https://github.com/gunaseelanvinoth/practise.git
cd practise

# 2. Create your local config
cp .env.example .env
# Edit .env — set ADMIN_PASSWORD=something-secret

# 3. Start the server (Windows)
npm.cmd start

# 4. Open in browser
# Candidate: http://localhost:4173
# Admin:     http://localhost:4173/control-room
```

The admin password is printed to the console on first start if you don't set it in `.env`.

---

## 🌐 Vercel Production Deployment

### Step 1 — Set up Upstash Redis

1. Go to [console.upstash.com](https://console.upstash.com)
2. Create a **new Redis database** (free tier works fine)
3. Copy the **REST URL** and **REST Token**

### Step 2 — Deploy to Vercel

1. Push your code to GitHub
2. Go to [vercel.com](https://vercel.com) → **New Project** → import the repository
3. Framework: **Other** (no framework)
4. Output directory: `public`
5. Click **Deploy**

### Step 3 — Set Environment Variables

In Vercel project → **Settings** → **Environment Variables**, add:

| Variable | Value |
|----------|-------|
| `ADMIN_PASSWORD` | A strong secret password |
| `UPSTASH_REDIS_REST_URL` | From Upstash dashboard |
| `UPSTASH_REDIS_REST_TOKEN` | From Upstash dashboard |
| `JUDGE0_URL` | `https://ce.judge0.com` (or your own) |

### Step 4 — Redeploy

After adding env vars, go to **Deployments** → **Redeploy** (check "Redeploy with existing build cache").

### URLs (production)
- Candidate: `https://your-project.vercel.app`
- Admin: `https://your-project.vercel.app/control-room`

---

## 🛠️ Admin Workflow

1. Open `/control-room` and sign in with admin password
2. **Configure**: Set question set (A or B), duration, question count
3. **Open test**: Toggle "Candidate Access" to open
4. **Monitor**: Watch the live candidate table — Online/Idle/Offline status updates every 3 seconds
5. **Analyse**: Click any question card to see per-candidate test case results
6. **Review code**: Click "Review" on any candidate to read their submitted code
7. **Award marks**: Use the manual grader (0.00–1.00) for ungraded questions
8. **Export submissions**: Filter by user, question, language or status; select records, export one user's code, or export all code results
9. **Close test**: Toggle access off when done

In **Test Cases**, choose a question and select either **Visible sample tests** or **Hidden tests**. Only visible samples are returned to candidate browsers. Hidden-case inputs and expected outputs remain server-side and are exposed only in the authenticated admin dashboard.

Each official submission is tied to its attempt ID (the internal user ID) so the candidate history endpoint cannot list another candidate's submissions. Sample runs are not official submissions and do not affect official grade totals. CSV files contain exactly these fields: `Question ID`, `Question`, `Language`, `Source Code`, `Test Cases Passed`, `Test Cases Failed`, `Total Test Cases`, `Final Status`.

---

## 📋 Project Structure

```
├── public/
│   ├── index.html        Redirect to platform.html
│   ├── platform.html     Main SPA (candidate + admin views)
│   ├── platform.css      All styles (animated dark theme)
│   └── platform.js       All frontend logic
├── api/
│   ├── handler.cjs       Vercel API handler (Upstash Redis)
│   └── [...path].mjs     Vercel serverless entry point
├── lib/
│   ├── evaluation.js     Output normalization and grading utilities
│   └── platform.js       Test-suite normalization, submission model, CSV export
├── local-server.cjs      Local Node.js server
├── questions.json        100 DSA questions
├── question-specs.json   Input/output formats and runnable suites for curated questions
├── sets.json             Set A and Set B question ID lists
├── vercel.json           Vercel configuration
├── .env.example          Environment variable template
└── package.json
```

---

## 🔒 Security

- Admin password checked server-side on every authenticated request
- Candidate tokens stored in `sessionStorage` only (not `localStorage`)
- Private test cases never sent to candidates
- Code execution sandboxed on Judge0 — never runs on your server
- All secrets in environment variables, never in source code
- `.env`, `data/`, and `*.local` are git-ignored

---

## 🧪 Running Tests

```bash
npm.cmd test
```

This runs the offline unit tests for grading, hidden-data projection, CSV shape, and question-suite quality.

Two opt-in integration commands submit test programs to Judge0 (internet access required):

```bash
npm.cmd run test:live   # Java and Python against all authored tests; flawed-code, compile, runtime and timeout probes
npm.cmd run test:e2e    # isolated local server, real Judge0, private-history and admin CSV authorization checks
```

Both commands explicitly opt in to external code execution. They use disposable test data; `test:e2e` cleans up its isolated temporary directory.

---

## ⚠️ Notes

- **Question data coverage** — twelve existing questions (IDs 1, 2, 3, 5, 6, 13, 14, 15, 17, 18, 22 and 25) have authored input/output formats, visible samples and question-specific hidden tests. The other legacy questions are retained; coverage is being completed from their actual problem statements rather than treating fixed tutorial examples as executable tests.
- **Judge0 public instance** may have rate limits. For heavy use, provision your own Judge0 instance.
- **Local data** is stored in `data/state.json` (created automatically, git-ignored).
- **Production data** requires Upstash Redis. The platform shows a clear error if the database is not configured.
