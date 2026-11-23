# Job Agent

An AI-style job search agent that runs on your PC and works in any browser, phone or desktop.

| Feature | What it does |
|---|---|
| **Search like a chat** | Type any role ("graduate AI engineer", "data analyst") or tap a quick chip. The agent shows each step live as it searches. |
| **Company careers pages only** | 12 Google searches (via Apify) across Workday, Greenhouse, Lever, SmartRecruiters, Ashby, Workable, Oracle, Taleo, Avature and company sites. LinkedIn, Indeed, Glassdoor and other job boards are removed. |
| **Filters** | Posted: **Yesterday / 3 days / Week / Any time**. Location: any city, "UK" or "Remote". Results: 25 / 50 / 100. |
| **High / Medium / Low chance** | Every job gets a 0–100 match score from your skills, graduate vs senior level, years of experience asked, missing skills, visa wording and closed listings. |
| **Tailored CV + cover letter** | One click: reads the full job page (Apify), re-scores, then builds a CV and cover letter as PDF + HTML. It reorders **your real CV content** for each job and never invents experience. Missing skills are acknowledged honestly in the letter. |
| **Daily 50** | Runs your saved searches, picks up to 50 **new** jobs above your minimum chance and prepares a CV + cover letter pack for each. Can run automatically every morning. |
| **Tracker** | Ready to apply → Applied → Interview → Offer / Rejected, with links to each CV, cover letter and careers page. |
| **Install as an app** | Works as a website and installs as an app (PWA) on PC. On a phone it runs in the browser over home Wi-Fi. |

> **Why it doesn't press "Submit" for you:** company careers sites need your own account, legal declarations (right to work, criminal record, data consent), CAPTCHAs and screening answers that only you can give. The agent does the slow part, finding jobs and tailoring documents. You review each pack and submit it yourself, which takes about 2–5 minutes per job.

## Start it (Windows)

1. Install Node.js 18+ from nodejs.org if you don't have it. Nothing else to install.
2. Copy `.env.example` to `.env` and paste your Apify token (console.apify.com → Settings → API & Integrations).
3. Double-click **`start.bat`**. The app opens at http://localhost:5178.

Without a token, the saved list of 50 jobs and CV tailoring still work. Tailoring then uses the search snippet instead of the full job page.

### On your phone
1. Double-click **`start-phone.bat`**. It prints an address like `http://192.168.1.20:5178`.
2. Open that address on your phone (same Wi-Fi). Use the browser's **Add to Home Screen** for an app icon.
3. Set `APP_PIN=1234` (your own PIN) in `.env` so nobody else on the Wi-Fi can use it.

Phones can only fully *install* web apps served over HTTPS. To use it away from home, host it online (e.g. Render or Railway) or use a secure tunnel.

### On your PC as an app
Open http://localhost:5178 in Edge or Chrome → install icon in the address bar (or ⋮ → *Install Job Agent*).

## Host it online (Render, free) so it works on your phone anywhere

What's already set up in this repo:
- `Dockerfile`: the app plus Chromium, so PDFs work on the server
- `render.yaml`: a free Render web service
- `.github/workflows/daily.yml`: wakes the app every morning and runs the Daily 50

How the free plan's limits are handled:
- **Sleeps after 15 minutes idle:** the first visit takes about 1 minute to wake.
- **Disk wiped on restart:** your tracker, settings and CV edits are saved in your Apify account (key-value store `job-agent-data`). Documents are rebuilt automatically when you open them.
- **Login:** the app will not start online without `APP_PIN`. Five wrong PINs lock that device out for 15 minutes. Logins last 30 days.

Steps:
1. Push this folder to GitHub. The repo can be public: your real CV (`data/profile.json`) is git-ignored, and only an anonymous `data/profile.example.json` is published.
2. Send your CV to your private Apify storage, where the hosted app reads it: put `APIFY_TOKEN` in `.env`, then run `npm run upload-profile`. Run it again whenever you edit `data/profile.json`, or edit your CV in the app's **My CV** tab instead.
3. On render.com: **New → Blueprint**, then pick the repo. When asked, enter:
   - `APIFY_TOKEN`: your Apify token
   - `APP_PIN`: a PIN only you know (4+ characters)
4. Wait for the first deploy (about 5 minutes). Your link looks like `https://job-agent-xxxx.onrender.com`.
5. Daily 50 every morning:
   1. In GitHub → repo **Settings → Secrets and variables → Actions**, add `APP_URL` (your Render link) and `CRON_SECRET` (copy it from Render → job-agent → Environment).
   2. In the app, tick **Run automatically every day** in the Daily 50 tab.
6. On your phone, open the link → browser menu → **Add to Home Screen / Install app**.

## Daily 50 schedule
Daily 50 tab → tick **Run automatically every day** and choose the hour. It runs once a day after that hour while the app is open. Leave `start.bat` running, or add it to Windows Task Scheduler at login.

**Cost:** each search query is 12 Google searches on Apify, and each prepared job adds one page fetch. With 3 saved searches and 50 jobs per day, that is about 36 searches + 50 fetches a day. Check prices on the Apify Store pages for `apify/web-search` and `apify/web-fetch`. Lower "Jobs per day" if you need to.

## Your CV data
`data/profile.json` (or the **My CV** tab) holds your CV content, the skills the agent matches, and the skills it flags as gaps. Edit it once and every future CV uses it. Generated documents are saved in `data/applications/<date>/<company>/`.

## Tests
```bash
npm test
```
20 automated tests: scoring, job-board filtering, date filters, tailoring (escaping, no invented content), the full HTTP API with a fake Apify, PDF generation, the daily run and PIN protection.

## Files
- `server.js`: web server and API
- `lib/search.js`: Google queries and careers-page filtering
- `lib/score.js`: High / Medium / Low chance
- `lib/tailor.js`: CV and cover letter builder
- `lib/pipeline.js`: tailoring and the Daily 50 run
- `lib/pdf.js`: PDF output through Edge or Chrome
- `lib/apify.js`: Apify web-search and web-fetch client
- `public/`: the app (HTML/CSS/JS, PWA manifest, service worker, icons)
- `data/`: profile, saved jobs, settings, tracker, generated documents
