// One job -> fetch its description -> score -> tailored CV + cover letter (HTML + PDF) -> tracker.
// Also the daily run that does this for up to N new jobs.
const fs = require('fs');
const path = require('path');
const { fetchJobPage } = require('./apify');
const { scoreJob } = require('./score');
const { buildDocs } = require('./tailor');
const { htmlToPdf } = require('./pdf');
const { runSearch, idFor } = require('./search');

const slug = s => String(s || '').normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_').slice(0, 40) || 'job';
const today = () => new Date().toISOString().slice(0, 10);

// Writes the CV + cover letter (HTML, and PDF when a browser is available).
async function writeDocs(job, profile, score, description, appDir, dateStr) {
  const docs = buildDocs(job, profile, score, description);
  const dir = path.join(appDir, dateStr, `${slug(job.company)}-${job.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const base = slug(profile.name);
  const cvHtml = path.join(dir, `CV_${base}_${slug(job.company)}.html`);
  const clHtml = path.join(dir, `Cover_Letter_${base}_${slug(job.company)}.html`);
  fs.writeFileSync(cvHtml, docs.cvHtml);
  fs.writeFileSync(clHtml, docs.coverHtml);
  const cvPdf = await htmlToPdf(cvHtml, cvHtml.replace(/\.html$/, '.pdf'));
  const clPdf = await htmlToPdf(clHtml, clHtml.replace(/\.html$/, '.pdf'));
  const toUrl = f => f ? '/files/' + path.relative(appDir, f).split(path.sep).map(encodeURIComponent).join('/') : null;
  return {
    files: { cvHtml: toUrl(cvHtml), coverHtml: toUrl(clHtml), cvPdf: toUrl(cvPdf), coverPdf: toUrl(clPdf) },
    projectOrder: docs.projectOrder,
  };
}

// Rebuilds an application's documents from the saved tracker record (same paths as before).
async function regenerateDocs(app, profile, appDir) {
  const m = String(app.files && app.files.cvHtml || '').match(/^\/files\/(\d{4}-\d{2}-\d{2})\//);
  const dateStr = m ? m[1] : today();
  const score = { matched: app.matched || [], gaps: app.gaps || [], warnings: app.warnings || [] };
  const job = { id: app.id, company: app.company, title: app.title, snippet: app.snippet || '' };
  const { files } = await writeDocs(job, profile, score, app.description || '', appDir, dateStr);
  return files;
}

async function prepareApplication(job, ctx) {
  const { profile, store, appDir, location, fetchPage = fetchJobPage, log = () => {} } = ctx;
  const id = job.id || idFor(job.url);
  let description = '';
  if (!job.listing && job.url) {
    try {
      const page = await fetchPage(job.url);
      description = page.text || '';
    } catch (e) {
      log(`Could not read the job page for ${job.company} (${e.code === 'NO_TOKEN' ? 'no Apify token' : 'fetch failed'}); using the search snippet.`);
    }
  }
  const score = scoreJob({ ...job, description }, profile, { location });
  const { files, projectOrder } = await writeDocs({ ...job, id }, profile, score, description, appDir, today());

  const app = {
    id,
    company: job.company,
    title: job.title,
    url: job.url,
    location: job.location || location || '',
    source: job.source || '',
    date: job.date || '',
    score: score.score,
    label: score.label,
    matched: score.matched,
    gaps: score.gaps,
    reasons: score.reasons,
    warnings: score.warnings,
    confidence: score.confidence,
    projectOrder,
    files,
    snippet: String(job.snippet || '').slice(0, 1000),
    // Kept so documents can be rebuilt if the server's disk is wiped (Render free plan).
    description: description.slice(0, 8000),
    status: 'Ready to apply',
    notes: '',
    foundAt: new Date().toISOString(),
    tailoredAt: new Date().toISOString(),
  };
  return store.upsertApplication(app);
}

const LABEL_RANK = { Low: 0, Medium: 1, High: 2 };

// Daily run: search every saved query, keep new jobs above the minimum chance,
// and prepare up to `dailyTarget` applications.
function createDailyRunner({ store, getProfile, appDir, search, fetchPage }) {
  const state = { running: false, startedAt: null, finishedAt: null, phase: 'idle', done: 0, total: 0, log: [], summary: null, error: null };
  const log = msg => { state.log.push({ t: new Date().toISOString(), msg }); if (state.log.length > 300) state.log.shift(); };

  async function run(settings) {
    if (state.running) throw new Error('A daily run is already in progress.');
    Object.assign(state, { running: true, startedAt: new Date().toISOString(), finishedAt: null, phase: 'searching', done: 0, total: 0, log: [], summary: null, error: null });
    try {
      const profile = getProfile();
      const target = Math.max(1, Math.min(100, Number(settings.dailyTarget) || 50));
      const known = new Set(store.applications().map(a => a.id));
      const found = new Map();
      for (const q of settings.queries) {
        log(`Searching Google for "${q}" in ${settings.location || 'any location'} (posted: ${settings.posted})…`);
        try {
          const { jobs } = await runSearch({ q, location: settings.location, posted: settings.posted, search });
          let fresh = 0;
          for (const j of jobs) if (!j.listing && !known.has(j.id) && !found.has(j.id)) { found.set(j.id, j); fresh++; }
          log(`"${q}": ${jobs.length} careers-page results, ${fresh} new job pages.`);
        } catch (e) {
          log(`"${q}" failed: ${e.message}`);
          if (e.code === 'NO_TOKEN') throw e;
        }
      }
      const min = LABEL_RANK[settings.minLabel] ?? 1;
      const ranked = [...found.values()]
        .map(j => ({ j, s: scoreJob(j, profile, { location: settings.location }) }))
        .filter(x => LABEL_RANK[x.s.label] >= min)
        .sort((a, b) => b.s.score - a.s.score)
        .slice(0, target);
      state.phase = 'tailoring';
      state.total = ranked.length;
      log(`${found.size} new jobs found; ${ranked.length} meet your minimum chance (${settings.minLabel}). Tailoring CVs and cover letters…`);

      const queue = ranked.slice();
      const results = [];
      const worker = async () => {
        while (queue.length) {
          const { j } = queue.shift();
          try {
            const app = await prepareApplication(j, { profile, store, appDir, location: settings.location, fetchPage, log });
            results.push(app);
            log(`✓ ${app.label} (${app.score}) · ${app.title} at ${app.company}`);
          } catch (e) {
            log(`✗ ${j.title} at ${j.company}: ${e.message}`);
          }
          state.done++;
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      state.summary = {
        prepared: results.length,
        high: results.filter(a => a.label === 'High').length,
        medium: results.filter(a => a.label === 'Medium').length,
        low: results.filter(a => a.label === 'Low').length,
      };
      log(`Done: ${results.length} application packs ready in your Tracker.`);
      state.phase = 'done';
      return state.summary;
    } catch (e) {
      state.error = e.message;
      state.phase = 'error';
      log(`Stopped: ${e.message}`);
      throw e;
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  }
  return { run, state };
}

module.exports = { prepareApplication, regenerateDocs, createDailyRunner };
