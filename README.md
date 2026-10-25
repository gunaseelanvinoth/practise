# DSA Coding Assessment Platform

A small-group coding test app for two candidates, created from the supplied 100-question HTML. It has a password-protected administrator dashboard, candidate portal, Set A/B exams, timed attempts, autosaving source code, C/C++/Java/Python/JavaScript runners, submissions, and live candidate monitoring.

## Start on Windows

1. Open PowerShell and change to this folder (quotes matter because `New project` contains a space):

   ```powershell
   cd "C:\Users\ELCOT\OneDrive\Documents\ChatGPT\New project"
   ```

2. Start the app with the Windows npm launcher. This avoids PowerShell's `npm.ps1` script-policy error. Keep this terminal open; the browser will say **Server unavailable** whenever the server is stopped:

   ```powershell
   npm.cmd start
   ```

3. Open the **This computer** address printed in PowerShell (normally **http://localhost:4173**). If that port is busy, the server tries the next available port. The admin dashboard is hidden from the candidate page at the same address plus **/control-room**. It is protected by the password you requested.

4. In the admin dashboard set the duration and question count, then switch **Candidate Access** on. Candidates on the same Wi-Fi can open the **Same Wi-Fi network** address printed in PowerShell. If Windows Firewall asks, allow Node.js on private networks. Keep the PowerShell window and computer running for the duration of the test.

5. When everyone is done, switch Candidate Access off. Review candidate code and marks from the admin dashboard. Marks are out of one per question; you can award or remove a mark for each submitted answer.

The local `.env` file is set to the password you requested. It is ignored by Git and is outside the public web directory. Never share it with candidates. The hidden `/control-room` URL is not a substitute for authentication; the password is still required. `JUDGE0_URL` and `JUDGE0_KEY` can point to an authorized Judge0 instance; defaults are the public Judge0 CE endpoint and no API key.

## Candidate experience

The administrator selects Set A or Set B, test duration, and question count before opening access. Candidates enter only their name; the assigned set is fixed by the server and candidates cannot choose or switch sets. The compiler offers only the newest available Judge0 entry for each of C, C++, Java, JavaScript, and Python. Cached lists are filtered again in the browser, appear immediately, then refresh in the background; the catalogue is cached for six hours in the browser session and server process. The editor keeps separate drafts per language, highlights common syntax, and uses an animated indigo/violet workspace theme. Candidates can run the visible sample or submit an answer. A sample run checks only that public example and does not award a mark. Submit answer runs every admin-configured private test case for that question; candidates see only the number passed and percentage, while the administrator sees per-case results. Each question receives a proportional mark (passed cases / configured cases). The admin dashboard shows attempted questions by default, offers an All assigned view, and opens a circular question report with submitted, completed, not completed, fully correct, failed case, and judge error counts. The dashboard lets you configure up to twenty input/output cases per question. With no cases configured, code is saved for manual review; it is never auto-passed. Code is autosaved to this server. The timer starts on the server and the attempt auto-submits at expiry. Candidate presence is shown as Online (<15 seconds), Idle (15–60 seconds), or Offline (>60 seconds). The admin dashboard refreshes every three seconds.

## Important limits of this question bank and run setup

The imported HTML is a tutorial bank with worked examples. It contains 100 titles/statements and Java/Python reference answers, but it does **not** provide hidden tests or a standard input/output contract for every task. Four questions have no explicit sample input and 18 have no explicit sample output. Accordingly:

- **Run sample** executes the submitted code through Judge0 and compares output with the supplied sample only when the sample is complete. Sample matching is not proof of full correctness.
- The original tutorial bank does not include validated hidden input/output cases or a consistent stdin contract. Add suitable cases in the admin dashboard for every question you want automatically graded. A case must reflect that question's stated input/output format.
- No hidden test suite is invented. For missing/incomplete samples, code is still saved and can be run, but an administrator must review it and assign the mark.
- C, C++, Java, Python and JavaScript execution is performed by the configured Judge0 service. Candidate source code and sample input are sent to that service. The public Judge0 CE service may impose availability or usage limits; for a high-stakes or public exam, configure a private Judge0 deployment and author/validate hidden tests first.

## Deploy on Vercel

This project has a static frontend in `public/` and a serverless API in the root `api/` directory. In Vercel, import the repository with **Root Directory set to the repository root** (not `public/`), Framework Preset **Other**, and Output Directory `public`. The root URL and `/control-room` both open the platform. Vercel deploys the API separately from the static files.

For online tests to work across devices, connect an Upstash Redis database to the Vercel project and add these production environment variables in **Project Settings → Environment Variables**:

- `UPSTASH_REDIS_REST_URL` — Upstash Redis REST endpoint
- `UPSTASH_REDIS_REST_TOKEN` — Upstash Redis REST token
- `ADMIN_PASSWORD` — private administrator password
- `JUDGE0_URL` — optional; defaults to `https://ce.judge0.com`
- `JUDGE0_KEY` — optional Judge0 token, if required by the selected Judge0 service

Redeploy after saving environment variables. Without both Upstash variables, static pages may deploy but login, test access, submissions, and the admin dashboard cannot use shared online storage. The page now reports this missing setup instead of a generic “server unavailable” state. The Vercel settings and an actual public deployment still require access to the owner's Vercel account. Candidate source code and test input are sent to Judge0. Local attempts are stored in `data\state.json`; Vercel attempts persist in Upstash Redis.

## Question source utilities

- `npm.cmd run import:questions` re-parses the default source at `C:\Users\ELCOT\Downloads\DSA Practice Lab.html`; provide another HTML path as an argument if needed.
- `npm.cmd run generate:sets` rebuilds reproducible, non-overlapping 50-question sets. The default seed is `DSA-PLAB-2026`; set `TEST_SEED` to change it.

Import validation from the supplied HTML: **100 questions; 100 unique IDs; 0 missing titles, statements, Java references, or Python references; 4 without explicit sample input; 18 without explicit sample output.**

Run the local grading and language-selection checks with `npm.cmd test`.

