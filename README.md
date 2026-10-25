# ⬡ CodeArena — DSA Assessment Platform

A real-time online coding-test platform for administrators and candidates. Candidates solve DSA problems by writing and running code in C, C++, Java, Python, or JavaScript. The administrator monitors both candidates live, reviews submitted code, and awards marks.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🎨 Animated UI | Dark cosmic theme with particle canvas, glassmorphism cards, animated aurora gradient |
| 👤 Candidate portal | Login page, timer, question navigation, syntax-highlighted code editor |
| 🔐 Admin dashboard | Password-protected control room with live candidate monitoring |
| ⚡ Code execution | Server-side via Judge0 CE (safe, sandboxed, never runs on your server) |
| 📊 Analytics | Question-level stats, per-candidate test case pass/fail, score breakdown |
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
8. **Close test**: Toggle access off when done

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
│   └── evaluation.js     Grading utilities
├── local-server.cjs      Local Node.js server
├── questions.json        100 DSA questions
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

This runs the 4 built-in grading unit tests in `test/evaluation.test.js`.

---

## ⚠️ Notes

- **No private test cases by default** — automatic scoring requires you to configure test cases per question in the admin dashboard. Without them, submissions are saved as "ungraded" for manual review.
- **Judge0 public instance** may have rate limits. For heavy use, provision your own Judge0 instance.
- **Local data** is stored in `data/state.json` (created automatically, git-ignored).
- **Production data** requires Upstash Redis. The platform shows a clear error if the database is not configured.

## Code submission CSV export

The admin dashboard can export selected submitted answers, submissions for one candidate, or all submissions. The admin-only POST /api/admin/export-csv endpoint returns exactly these columns: Question ID, Question, Language, Source Code, Test Cases Passed, Test Cases Failed, Total Test Cases, and Final Status. CSV escaping preserves commas, quotes, and multiline code. Drafts and Run Sample executions are excluded.

Each Submit Answer run is saved in the existing local JSON state or the additive dsa:submissions Upstash list. Historical submissions remain selectable after the answer changes. Candidate APIs do not return the hidden test suite or other candidates' submissions.

## Test suite setup boundary

The project includes real Judge0 sandbox execution and an admin-only per-question private test case manager. The imported tutorial question bank does not define a consistent stdin/output contract or validated hidden suite for every problem. Configure and verify question-specific sample and hidden inputs in the admin dashboard before trusting automatic grading. This update does not invent expected outputs or claim two public plus three hidden cases for all 100 questions. A production rollout still needs Upstash and Judge0 environment variables configured; no live Judge0 run or ten-question end-to-end sweep was performed here.
