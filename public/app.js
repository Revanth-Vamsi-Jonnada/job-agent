/* Job Agent front-end (no framework). All job data is inserted with textContent. */
(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.style.cssText = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return e;
}
const safeUrl = u => { try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : '#'; } catch { return '#'; } };
// Documents and the search stream use the login cookie, so links need no extra token.
const withPin = u => u;

// PIN login screen (shown when the hosted app answers 401).
let loginWait = null;
function login() {
  if (loginWait) return loginWait;
  loginWait = new Promise(resolve => {
    const box = $('#login'); box.hidden = false;
    const input = $('#pinInput'); const msg = $('#loginMsg'); input.value = ''; msg.textContent = '';
    setTimeout(() => input.focus(), 50);
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: input.value }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { box.hidden = true; loginWait = null; resolve(); }
      else { msg.textContent = d.error || 'Wrong PIN'; input.select(); }
    };
  });
  return loginWait;
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (res.status === 401) { await login(); return api(path, opts); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

/* ---------- navigation ---------- */
function show(view) {
  $$('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  ls.set('view', view);
  if (view === 'tracker') loadTracker();
  if (view === 'daily') { loadSettings(); pollDaily(); }
  if (view === 'profile') loadProfile();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
$$('.nav button').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));

/* ---------- status ---------- */
let status = {};
async function loadStatus() {
  try {
    status = await api('/api/status');
    if (status.name) $('#greet').textContent = `Hi ${status.name}! What job should I hunt for today?`;
    const c = $('#conn'); c.replaceChildren(
      el('div', {}, el('span', { class: 'dot' + (status.hasToken ? ' ok' : '') }), status.hasToken ? 'Apify connected' : 'Apify token missing'),
      el('div', {}, el('span', { class: 'dot' + (status.pdfEngine ? ' ok' : '') }), status.pdfEngine ? 'PDF engine ready' : 'PDF: HTML only'),
    );
    if (status.exampleProfile) {
      const warn = el('div', { class: 'panel', style: 'border-color:var(--med)' },
        el('strong', {}, 'Using the example CV. '),
        'Tailored CVs will contain placeholder text until you add yours: run "npm run upload-profile" on your PC, or paste your profile in the My CV tab.');
      if (!$('#exampleWarn')) { warn.id = 'exampleWarn'; $('#view-agent').prepend(warn); }
    } else if ($('#exampleWarn')) $('#exampleWarn').remove();
    const ready = (status.counts || {})['Ready to apply'] || 0;
    const b = $('#trackerBadge'); b.hidden = !ready; b.textContent = ready;
  } catch (e) { toast(e.message); }
}

/* ---------- search (agent) ---------- */
const QUICK = ['Graduate data scientist', 'Graduate AI engineer', 'Graduate data analyst', 'Junior machine learning engineer', 'Data science graduate scheme 2027', 'AI graduate programme'];
$('#quick').append(...QUICK.map(q => el('button', { class: 'chip', type: 'button', onclick: () => { $('#q').value = q; startSearch(); } }, q)));

let posted = ls.get('posted', '7d');
function setSeg(box, v) { $$(box + ' button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
setSeg('#posted', posted);
$$('#posted button').forEach(b => b.addEventListener('click', () => { posted = b.dataset.v; ls.set('posted', posted); setSeg('#posted', posted); }));
$('#loc').value = ls.get('loc', 'UK');
$('#loc').addEventListener('change', () => ls.set('loc', $('#loc').value));

let results = []; let chance = ''; let resultMode = 'saved';
$$('#chanceFilter button').forEach(b => b.addEventListener('click', () => { chance = b.dataset.v; setSeg('#chanceFilter', chance); renderCards(); }));
$('#filter').addEventListener('input', renderCards);

let es = null;
async function startSearch() {
  const q = $('#q').value.trim();
  if (!q) { $('#q').focus(); return; }
  try { await api('/api/status'); } catch {} // makes sure we are logged in before opening the stream
  if (es) es.close();
  const loc = $('#loc').value.trim();
  const params = new URLSearchParams({ q, location: loc, posted, limit: $('#limit').value });
  const log = $('#agentlog'); log.hidden = false; log.classList.remove('done');
  $('#agentTitle').textContent = `Searching for “${q}”${loc ? ' in ' + loc : ''}…`;
  $('#agentSteps').replaceChildren(); $('#agentBar').style.width = '3%'; $('#agentCount').textContent = '';
  $('#goBtn').disabled = true;
  es = new EventSource(withPin('/api/search/stream?' + params));
  let found = 0;
  es.addEventListener('progress', ev => {
    const p = JSON.parse(ev.data);
    if (p.label && p.done) { found += p.found || 0; $('#agentSteps').append(el('li', { class: p.error ? 'err' : '' }, p.error ? `${p.label}: failed (${p.error.slice(0, 80)})` : `${p.label}: ${p.found} results`)); }
    else if (p.label) $('#agentSteps').append(el('li', {}, p.label));
    $('#agentBar').style.width = Math.max(3, Math.round((p.done / p.total) * 100)) + '%';
    $('#agentCount').textContent = p.done ? `${p.done}/${p.total} searches · ${found} raw results` : '';
  });
  es.addEventListener('done', ev => {
    const d = JSON.parse(ev.data); es.close(); es = null;
    results = d.jobs; resultMode = 'live';
    log.classList.add('done');
    $('#agentTitle').textContent = `Found ${d.jobs.length} careers-page jobs for “${q}”`;
    $('#agentSteps').append(el('li', {}, `Removed job boards and duplicates, rated each job against your CV`));
    $('#agentBar').style.width = '100%';
    $('#goBtn').disabled = false;
    chance = ''; setSeg('#chanceFilter', '');
    renderCards();
    ls.set('lastResults', { q, jobs: d.jobs, at: Date.now() });
  });
  es.addEventListener('fail', ev => {
    const d = JSON.parse(ev.data); es.close(); es = null;
    log.classList.add('done'); $('#goBtn').disabled = false;
    $('#agentTitle').textContent = 'Search stopped';
    $('#agentSteps').append(el('li', { class: 'err' }, d.message));
  });
  es.onerror = () => { if (es) { es.close(); es = null; $('#goBtn').disabled = false; log.classList.add('done'); $('#agentTitle').textContent = 'Connection lost. Is the app still running?'; } };
}
$('#searchForm').addEventListener('submit', e => { e.preventDefault(); startSearch(); });

function ring(job) {
  return el('div', { class: 'ring ' + job.label, style: `--p:${job.score}`, title: `Match score ${job.score}/100` }, el('b', {}, job.score));
}
function chanceLabel(l) { return { High: 'High chance', Medium: 'Medium chance', Low: 'Low chance' }[l] || l; }

function jobCard(job) {
  const tags = el('div', { class: 'tags' },
    (job.matched || []).slice(0, 6).map(m => el('span', { class: 'tag' }, '✓ ' + m)),
    (job.gaps || []).slice(0, 3).map(m => el('span', { class: 'tag gap' }, '+ ' + m)),
    (job.warnings || []).map(w => el('span', { class: 'tag warn' }, '⚠ ' + w)));
  return el('article', { class: 'card' },
    ring(job),
    el('div', {},
      el('h3', {}, job.title || '(untitled)'),
      el('div', { class: 'co' }, [job.company, job.location].filter(Boolean).join(' · ')),
      el('div', { class: 'meta' },
        el('span', { class: 'pill ' + job.label }, chanceLabel(job.label)),
        job.listing ? el('span', { class: 'pill neutral' }, 'Careers board') : null,
        job.date ? el('span', { class: 'pill neutral' }, 'Posted ' + job.date) : null,
        job.status ? el('span', { class: 'pill neutral' }, job.status) : null,
        job.tracked ? el('span', { class: 'pill neutral' }, 'In tracker') : null,
        el('span', { class: 'muted small' }, job.source || '')),
      job.snippet || job.note ? el('div', { class: 'snip' }, job.snippet || job.note) : null,
      tags),
    el('div', { class: 'actions' },
      el('button', { class: 'btn primary', onclick: () => openTailor(job) }, 'Tailor CV & letter'),
      el('a', { class: 'btn', href: safeUrl(job.url), target: '_blank', rel: 'noopener noreferrer' }, 'Open careers page')));
}

function renderCards() {
  const f = $('#filter').value.toLowerCase();
  const rows = results.filter(j => (!chance || j.label === chance) && (!f || [j.title, j.company, j.snippet, j.note, j.location].join(' ').toLowerCase().includes(f)));
  const counts = { High: 0, Medium: 0, Low: 0 }; results.forEach(j => counts[j.label]++);
  $('#resCount').textContent = `${rows.length} jobs`;
  $('#resNote').textContent = (resultMode === 'saved' ? 'Saved list from 23 Nov 2026 · ' : '') + `${counts.High} high · ${counts.Medium} medium · ${counts.Low} low chance`;
  const box = $('#cards');
  box.replaceChildren(...(rows.length ? rows.map(jobCard) : [el('div', { class: 'empty' }, results.length ? 'No jobs match this filter.' : 'No results yet. Try a quick search above.')]));
}

$('#csvBtn').addEventListener('click', () => {
  const cols = ['score', 'label', 'company', 'title', 'location', 'date', 'url', 'source', 'snippet'];
  const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = [cols.join(','), ...results.map(j => cols.map(c => esc(j[c])).join(','))].join('\r\n');
  const a = el('a', { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: 'jobs.csv' });
  document.body.append(a); a.click(); a.remove();
});

async function loadSeed() {
  try {
    const d = await api('/api/seed');
    results = d.jobs; resultMode = 'saved'; renderCards();
  } catch (e) { toast(e.message); }
}

/* ---------- tailor sheet ---------- */
function closeSheet() { $('#sheetBg').hidden = true; }
$('#sheetClose').addEventListener('click', closeSheet);
$('#sheetBg').addEventListener('click', e => { if (e.target.id === 'sheetBg') closeSheet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function openTailor(job) {
  const company = el('input', { value: job.company || '' });
  const title = el('input', { value: job.title || '' });
  const go = el('button', { class: 'btn primary lg', style: 'width:100%' }, 'Generate tailored CV & cover letter');
  const body = $('#sheetBody');
  body.replaceChildren(
    el('p', { class: 'muted' }, 'Check the company and job title (they come from Google), then generate. The agent reads the full job page via Apify, re-rates your chance and reorders your real CV content for this job.'),
    el('label', {}, 'Company', company), el('label', {}, 'Job title', title), go);
  $('#sheetBg').hidden = false; title.focus();
  go.addEventListener('click', async () => {
    go.disabled = true; go.replaceChildren(el('span', { class: 'spinner' }), ' Reading job page & tailoring… (up to 1 min)');
    try {
      const app = await api('/api/tailor', { method: 'POST', body: JSON.stringify({ job: { ...job, company: company.value.trim(), title: title.value.trim() } }) });
      renderTailored(app, job);
      job.tracked = true; job.score = app.score; job.label = app.label; job.matched = app.matched; job.gaps = app.gaps; job.warnings = app.warnings;
      renderCards(); loadStatus();
    } catch (e) {
      go.disabled = false; go.textContent = 'Try again'; toast(e.message);
    }
  });
}

function docBox(name, pdf, html) {
  return el('div', { class: 'doc' },
    el('strong', {}, name),
    pdf ? el('a', { class: 'btn primary', href: withPin(pdf), target: '_blank', rel: 'noopener' }, 'Open PDF') : null,
    el('a', { class: 'btn', href: withPin(html), target: '_blank', rel: 'noopener' }, pdf ? 'View / print HTML' : 'Open (Save as PDF)'));
}

function renderTailored(app, job) {
  const body = $('#sheetBody');
  body.replaceChildren(
    el('div', { style: 'display:flex;gap:14px;align-items:center' }, ring(app),
      el('div', {}, el('div', { class: 'big' }, chanceLabel(app.label)),
        el('div', { class: 'muted small' }, app.confidence === 'full' ? 'Rated from the full job description' : 'Rated from the search snippet (job page could not be read)'))),
    el('div', { class: 'tags' },
      (app.matched || []).map(m => el('span', { class: 'tag' }, '✓ ' + m)),
      (app.gaps || []).map(m => el('span', { class: 'tag gap' }, '+ ' + m)),
      (app.warnings || []).map(w => el('span', { class: 'tag warn' }, '⚠ ' + w))),
    el('div', { class: 'docs' }, docBox('Tailored CV', app.files.cvPdf, app.files.cvHtml), docBox('Cover letter', app.files.coverPdf, app.files.coverHtml)),
    el('p', { class: 'muted small' }, 'Read both documents before sending. Then apply on the careers page and mark it as applied.'),
    el('div', { class: 'row-actions' },
      el('a', { class: 'btn primary', href: safeUrl(app.url), target: '_blank', rel: 'noopener noreferrer' }, 'Apply on careers page'),
      el('button', { class: 'btn', onclick: async () => { await api('/api/applications/' + app.id, { method: 'PATCH', body: JSON.stringify({ status: 'Applied' }) }); toast('Marked as applied'); closeSheet(); loadStatus(); } }, 'Mark as applied')));
}

/* ---------- tracker ---------- */
const STATUSES = ['Ready to apply', 'Applied', 'Interview', 'Offer', 'Rejected', 'Skipped'];
let tFilterStatus = '';
$('#statusFilter').append(...['All', ...STATUSES].map(s => el('button', { 'data-v': s === 'All' ? '' : s, class: s === 'All' ? 'on' : '', onclick: () => { tFilterStatus = s === 'All' ? '' : s; setSeg('#statusFilter', tFilterStatus); renderTracker(); } }, s)));
$('#tFilter').addEventListener('input', () => renderTracker());
let apps = [];
async function loadTracker() {
  try { apps = (await api('/api/applications')).applications; renderTracker(); } catch (e) { toast(e.message); }
}
function renderTracker() {
  const counts = {}; apps.forEach(a => counts[a.status] = (counts[a.status] || 0) + 1);
  $('#stats').replaceChildren(...['Ready to apply', 'Applied', 'Interview', 'Offer'].map(s => el('div', { class: 'stat' }, el('b', {}, counts[s] || 0), el('span', {}, s))));
  const f = $('#tFilter').value.toLowerCase();
  const rows = apps.filter(a => (!tFilterStatus || a.status === tFilterStatus) && (!f || [a.title, a.company].join(' ').toLowerCase().includes(f)));
  $('#tCards').replaceChildren(...(rows.length ? rows.map(trackerCard) : [el('div', { class: 'empty' }, apps.length ? 'Nothing here with this filter.' : 'No applications yet. Tailor a job from Search, or run the Daily 50.')]));
}
function trackerCard(a) {
  const sel = el('select', { class: 'status-sel', 'aria-label': 'Status', onchange: async e => {
    try { const u = await api('/api/applications/' + a.id, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }); Object.assign(a, u); renderTracker(); loadStatus(); toast('Status: ' + u.status); }
    catch (err) { toast(err.message); }
  } }, STATUSES.map(s => el('option', { selected: s === a.status }, s)));
  return el('article', { class: 'card' }, ring(a),
    el('div', {},
      el('h3', {}, a.title), el('div', { class: 'co' }, a.company),
      el('div', { class: 'meta' }, el('span', { class: 'pill ' + a.label }, chanceLabel(a.label)), sel,
        el('span', { class: 'muted small' }, 'Prepared ' + new Date(a.tailoredAt || a.foundAt).toLocaleDateString('en-GB'))),
      el('div', { class: 'tags' }, (a.gaps || []).slice(0, 3).map(m => el('span', { class: 'tag gap' }, '+ ' + m)), (a.warnings || []).map(w => el('span', { class: 'tag warn' }, '⚠ ' + w)))),
    el('div', { class: 'actions' },
      el('a', { class: 'btn primary', href: safeUrl(a.url), target: '_blank', rel: 'noopener noreferrer' }, 'Apply'),
      el('a', { class: 'btn', href: withPin(a.files.cvPdf || a.files.cvHtml), target: '_blank', rel: 'noopener' }, 'CV'),
      el('a', { class: 'btn', href: withPin(a.files.coverPdf || a.files.coverHtml), target: '_blank', rel: 'noopener' }, 'Cover letter')));
}

/* ---------- daily 50 ---------- */
async function loadSettings() {
  try {
    const s = await api('/api/settings');
    const f = $('#settingsForm');
    f.queries.value = s.queries.join('\n'); f.location.value = s.location; f.posted.value = s.posted;
    f.dailyTarget.value = s.dailyTarget; f.minLabel.value = s.minLabel; f.autoRun.checked = s.autoRun; f.runHour.value = s.runHour;
    $('#dailySub').textContent = `${s.queries.length} searches · ${s.location} · up to ${s.dailyTarget} jobs · ${s.autoRun ? 'auto-runs daily at ' + s.runHour + ':00' : 'manual'}${s.lastRunDate ? ' · last run ' + s.lastRunDate : ''}`;
  } catch (e) { toast(e.message); }
}
$('#settingsForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({
      queries: f.queries.value.split('\n'), location: f.location.value, posted: f.posted.value,
      dailyTarget: Number(f.dailyTarget.value), minLabel: f.minLabel.value, autoRun: f.autoRun.checked, runHour: Number(f.runHour.value),
    }) });
    toast('Settings saved'); loadSettings();
  } catch (err) { toast(err.message); }
});
$('#runBtn').addEventListener('click', async () => {
  try { await api('/api/daily/run', { method: 'POST' }); toast('Daily run started'); $('#dailyLogBox').open = true; pollDaily(); }
  catch (e) { toast(e.message); }
});
let pollTimer;
async function pollDaily() {
  clearTimeout(pollTimer);
  try {
    const s = await api('/api/daily/status');
    const pct = s.phase === 'searching' ? 8 : s.total ? Math.round(8 + (s.done / s.total) * 92) : s.phase === 'done' ? 100 : 0;
    $('#dailyBar').style.width = pct + '%';
    $('#dailyHead').textContent = s.running ? (s.phase === 'searching' ? 'Searching careers sites…' : `Tailoring ${s.done}/${s.total}…`) : s.phase === 'done' ? 'Today\'s packs are ready' : s.phase === 'error' ? 'Run stopped' : 'Ready';
    $('#runBtn').disabled = s.running;
    $('#dailyLog').replaceChildren(...s.log.map(l => el('li', {}, `${new Date(l.t).toLocaleTimeString('en-GB')} ${l.msg}`)));
    const sum = s.summary;
    $('#dailySummary').replaceChildren(...(sum ? [['Prepared', sum.prepared], ['High chance', sum.high], ['Medium', sum.medium], ['Low', sum.low]].map(([k, v]) => el('div', { class: 'stat' }, el('b', {}, v), el('span', {}, k))) : []));
    if (s.running) pollTimer = setTimeout(pollDaily, 2000);
    else if (s.phase === 'done') loadStatus();
  } catch (e) { toast(e.message); }
}

/* ---------- profile ---------- */
async function loadProfile() {
  try {
    const p = await api('/api/profile');
    $('#profileJson').value = JSON.stringify(p, null, 2);
    $('#profileView').replaceChildren(el('div', { class: 'pv' },
      el('h2', {}, p.name), el('div', { class: 'muted' }, [p.contact?.location, p.contact?.email].filter(Boolean).join(' · ')),
      el('h3', {}, 'Skills the agent matches'), el('div', { class: 'tags' }, p.keywords.map(k => el('span', { class: 'tag' }, k.label))),
      el('h3', {}, 'Skills flagged as gaps'), el('div', { class: 'tags' }, (p.gapKeywords || []).map(k => el('span', { class: 'tag gap' }, k.label))),
      el('h3', {}, 'Projects (reordered per job)'), el('ul', {}, p.projects.map(x => el('li', {}, x.title)))));
  } catch (e) { toast(e.message); }
}
$('#saveProfile').addEventListener('click', async () => {
  let data;
  try { data = JSON.parse($('#profileJson').value); } catch { return toast('That is not valid JSON. Check commas and quotes.'); }
  try { await api('/api/profile', { method: 'PUT', body: JSON.stringify(data) }); toast('Profile saved'); loadProfile(); loadStatus(); } catch (e) { toast(e.message); }
});

/* ---------- start ---------- */
loadStatus();
const last = ls.get('lastResults', null);
if (last && Date.now() - last.at < 864e5 && Array.isArray(last.jobs)) { results = last.jobs; resultMode = 'live'; $('#q').value = last.q; renderCards(); }
else loadSeed();
show(ls.get('view', 'agent'));
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
})();
