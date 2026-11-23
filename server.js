// Job Agent: AI-style job search assistant.
//  - Searches Google (via Apify) and keeps only company careers pages
//  - Rates each job High / Medium / Low chance against your profile
//  - Tailors a CV + cover letter (HTML + PDF) per job
//  - Daily run prepares up to 50 new application packs
// No npm install needed (Node 18+).  Start: node server.js  ->  http://localhost:5178
// Hosted (Render): set APIFY_TOKEN, APP_PIN and CRON_SECRET; data is mirrored to Apify storage.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Store, DEFAULT_SETTINGS, createApifyKv } = require('./lib/store');
const { runSearch, idFor } = require('./lib/search');
const { scoreJob } = require('./lib/score');
const { prepareApplication, regenerateDocs, createDailyRunner } = require('./lib/pipeline');
const { findBrowser } = require('./lib/pdf');
const apify = require('./lib/apify');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.pdf': 'application/pdf', '.ico': 'image/x-icon',
};
const SESSION_DAYS = 30;

function createApp(opts = {}) {
  const root = opts.root || __dirname;
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  const appDir = path.join(dataDir, 'applications');
  const store = new Store(dataDir, { remote: opts.remote || null });
  const search = opts.search || apify.webSearch;
  const fetchPage = opts.fetchPage || apify.fetchJobPage;
  const pin = String(opts.pin ?? process.env.APP_PIN ?? '');
  const cronSecret = String(opts.cronSecret ?? process.env.CRON_SECRET ?? '');

  // Your real CV lives in data/profile.json (git-ignored) or, when hosted, in your private
  // Apify storage. The public repo only ships data/profile.example.json.
  const exampleProfile = () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'profile.example.json'), 'utf8'));
  const getProfile = () => store.read('profile.json', exampleProfile);
  const usingExample = () => !fs.existsSync(store.file('profile.json'));
  const getSettings = () => ({ ...DEFAULT_SETTINGS, ...store.read('settings.json', {}) });
  const daily = createDailyRunner({ store, getProfile, appDir, search, fetchPage });

  // ---------- auth: PIN -> signed cookie (survives restarts; changing the PIN logs everyone out) ----------
  const sessionKey = crypto.createHash('sha256').update('job-agent-session:' + pin).digest();
  const sign = exp => crypto.createHmac('sha256', sessionKey).update(String(exp)).digest('hex');
  const makeToken = () => { const exp = Date.now() + SESSION_DAYS * 864e5; return `${exp}.${sign(exp)}`; };
  const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  const cookies = req => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  function isAuthed(req) {
    if (!pin) return true;
    const [exp, sig] = String(cookies(req).ja_s || '').split('.');
    return Boolean(exp && sig && Number(exp) > Date.now() && safeEqual(sig, sign(exp)));
  }
  const failures = new Map();
  const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const isHttps = req => req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted);

  const send = (res, code, body, type = MIME['.json'], extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 2e6) { reject(httpError(413, 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(httpError(400, 'Invalid JSON')); } });
    req.on('error', reject);
  });
  const resolveIn = (base, rel) => {
    const file = path.resolve(base, '.' + path.sep + rel);
    return file.startsWith(path.resolve(base) + path.sep) ? file : null;
  };
  const streamFile = (res, file) => {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  };
  const exists = f => f && fs.existsSync(f) && fs.statSync(f).isFile();

  async function serveDoc(res, rel) {
    const file = resolveIn(appDir, rel);
    if (!file) return send(res, 404, { error: 'Not found' });
    if (!exists(file)) {
      // Disk was wiped (hosted free plan): rebuild this application's documents from the tracker.
      const m = rel.match(/^\d{4}-\d{2}-\d{2}\/[^/]*-([a-f0-9]{12})\//);
      const app = m && store.applications().find(a => a.id === m[1]);
      if (app) { const files = await regenerateDocs(app, getProfile(), appDir); if (JSON.stringify(files) !== JSON.stringify(app.files)) store.upsertApplication({ ...app, files }); }
    }
    return exists(file) ? streamFile(res, file) : send(res, 404, { error: 'Not found' });
  }

  const publicApp = a => { const { description, ...rest } = a; return rest; };

  const handlers = {
    'GET /api/status': () => ({
      hasToken: Boolean(process.env.APIFY_TOKEN), pdfEngine: Boolean(findBrowser()), locked: Boolean(pin), exampleProfile: usingExample(),
      name: getProfile().firstName || getProfile().name, settings: getSettings(),
      counts: countStatuses(store.applications()), daily: { running: daily.state.running, phase: daily.state.phase },
    }),
    'GET /api/seed': () => {
      const profile = getProfile();
      const seed = store.read('seed-jobs.json', () => JSON.parse(fs.readFileSync(path.join(root, 'data', 'seed-jobs.json'), 'utf8')));
      const known = new Set(store.applications().map(a => a.id));
      return {
        searchedAt: seed.searchedAt,
        jobs: seed.jobs.map(j => {
          const id = idFor(j.url);
          return { ...j, id, snippet: j.note, date: '', ...scoreJob({ ...j, snippet: j.note }, profile), tracked: known.has(id) };
        }).sort((a, b) => b.score - a.score),
      };
    },
    'POST /api/tailor': async (req) => {
      const { job } = await readBody(req);
      if (!job || !/^https?:\/\//.test(job.url || '')) throw httpError(400, 'A job with a valid url is required.');
      const clean = {
        id: /^[a-f0-9]{12}$/.test(job.id || '') ? job.id : undefined, url: job.url, listing: Boolean(job.listing),
        title: String(job.title || '').slice(0, 200), company: String(job.company || '').slice(0, 120),
        location: String(job.location || '').slice(0, 120), snippet: String(job.snippet || '').slice(0, 2000),
        source: String(job.source || '').slice(0, 120), date: String(job.date || '').slice(0, 20),
      };
      return publicApp(await prepareApplication(clean, { profile: getProfile(), store, appDir, location: getSettings().location, fetchPage }));
    },
    'GET /api/applications': () => ({ applications: store.applications().map(publicApp) }),
    'GET /api/profile': () => getProfile(),
    'PUT /api/profile': async (req) => {
      const p = await readBody(req);
      if (!p || typeof p.name !== 'string' || !Array.isArray(p.projects) || !Array.isArray(p.skills) || !Array.isArray(p.keywords))
        throw httpError(400, 'Profile must include name, skills, projects and keywords.');
      for (const k of [...p.keywords, ...(p.gapKeywords || [])]) {
        try { new RegExp(k.pattern); } catch { throw httpError(400, `Invalid keyword pattern: ${k.pattern}`); }
      }
      return store.write('profile.json', p);
    },
    'GET /api/settings': () => getSettings(),
    'PUT /api/settings': async (req) => {
      const b = await readBody(req);
      const s = getSettings();
      if (Array.isArray(b.queries)) s.queries = b.queries.map(q => String(q).trim().slice(0, 120)).filter(Boolean).slice(0, 10);
      if (typeof b.location === 'string') s.location = b.location.trim().slice(0, 100);
      if (['24h', '3d', '7d', 'any'].includes(b.posted)) s.posted = b.posted;
      if (b.dailyTarget !== undefined) s.dailyTarget = Math.max(1, Math.min(100, Number(b.dailyTarget) || 50));
      if (['Low', 'Medium', 'High'].includes(b.minLabel)) s.minLabel = b.minLabel;
      if (typeof b.autoRun === 'boolean') s.autoRun = b.autoRun;
      if (b.runHour !== undefined) s.runHour = Math.max(0, Math.min(23, Number(b.runHour) || 0));
      if (!s.queries.length) throw httpError(400, 'Add at least one search.');
      return store.write('settings.json', s);
    },
    'POST /api/daily/run': () => startDaily(true),
    'GET /api/daily/status': () => daily.state,
  };

  function startDaily(manual) {
    if (daily.state.running) throw httpError(409, 'A daily run is already in progress.');
    const s = getSettings();
    if (!manual && !s.autoRun) return { started: false, reason: 'Auto-run is switched off in Daily 50 settings.' };
    if (!manual && s.lastRunDate === localDate()) return { started: false, reason: 'Already ran today.' };
    store.write('settings.json', { ...s, lastRunDate: localDate() });
    daily.run(s).catch(e => console.error('[daily]', e.message));
    return { started: true };
  }

  function searchStream(req, res, url) {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const location = (url.searchParams.get('location') || '').trim().slice(0, 100);
    const posted = url.searchParams.get('posted') || 'any';
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (!q) { emit('fail', { message: 'Type what job you want first.' }); return res.end(); }
    let closed = false;
    req.on('close', () => { closed = true; });
    const keepAlive = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
    emit('progress', { done: 0, total: 12, label: 'Planning 12 Google searches across careers sites' });
    const profile = getProfile();
    const known = new Set(store.applications().map(a => a.id));
    runSearch({ q, location, posted, search, onProgress: p => { if (!closed) emit('progress', p); } })
      .then(r => {
        const jobs = r.jobs.map(j => ({ ...j, ...scoreJob(j, profile, { location }), tracked: known.has(j.id) }))
          .sort((a, b) => Number(a.listing) - Number(b.listing) || b.score - a.score)
          .slice(0, limit);
        if (!closed) emit('done', { jobs, queriesRun: r.queriesRun, queryErrors: r.queryErrors });
      })
      .catch(e => { if (!closed) emit('fail', { message: e.message }); })
      .finally(() => { clearInterval(keepAlive); res.end(); });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');

      // Login with the PIN -> 30-day cookie. 5 wrong tries locks that address for 15 minutes.
      if (p === '/api/login' && req.method === 'POST') {
        const ip = clientIp(req);
        const f = failures.get(ip);
        if (f && f.until > Date.now()) return send(res, 429, { error: 'Too many wrong PINs. Try again in 15 minutes.' });
        const { pin: given } = await readBody(req);
        if (!pin || safeEqual(String(given || ''), pin)) {
          failures.delete(ip);
          const cookie = `ja_s=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${isHttps(req) ? '; Secure' : ''}`;
          return send(res, 200, { ok: true }, MIME['.json'], { 'Set-Cookie': cookie });
        }
        // Count wrong PINs in a 15-minute window; the 5th locks this address for 15 minutes.
        const now = Date.now();
        const rec = f && now - f.first < 15 * 60000 ? f : { n: 0, first: now, until: 0 };
        rec.n++;
        if (rec.n >= 5) rec.until = now + 15 * 60000;
        failures.set(ip, rec);
        if (failures.size > 5000) failures.clear(); // memory guard
        return send(res, 401, { error: rec.n >= 5 ? 'Too many wrong PINs. Try again in 15 minutes.' : 'Wrong PIN.' });
      }
      if (p === '/api/logout' && req.method === 'POST') return send(res, 200, { ok: true }, MIME['.json'], { 'Set-Cookie': 'ja_s=; Path=/; Max-Age=0' });

      // Scheduler hook (GitHub Actions) protected by CRON_SECRET instead of the PIN.
      if (p.startsWith('/api/cron/')) {
        const auth = String(req.headers.authorization || '');
        if (!cronSecret || !safeEqual(auth, 'Bearer ' + cronSecret)) return send(res, 401, { error: 'Unauthorized' });
        if (p === '/api/cron/daily' && req.method === 'POST') return send(res, 200, startDaily(false));
        if (p === '/api/cron/status') return send(res, 200, { running: daily.state.running, phase: daily.state.phase, done: daily.state.done, total: daily.state.total, summary: daily.state.summary, error: daily.state.error });
        return send(res, 404, { error: 'Not found' });
      }

      if ((p.startsWith('/api/') || p.startsWith('/files/')) && !isAuthed(req)) return send(res, 401, { error: 'PIN required' });

      if (p === '/api/search/stream' && req.method === 'GET') return searchStream(req, res, url);
      if (p.startsWith('/files/') && req.method === 'GET') return await serveDoc(res, decodeURIComponent(p.slice(7)));

      const appMatch = p.match(/^\/api\/applications\/([a-f0-9]{6,40})$/);
      if (appMatch && req.method === 'PATCH') {
        const a = store.updateApplication(appMatch[1], await readBody(req));
        return a ? send(res, 200, publicApp(a)) : send(res, 404, { error: 'Not found' });
      }
      if (appMatch && req.method === 'DELETE') return send(res, store.deleteApplication(appMatch[1]) ? 200 : 404, { ok: true });

      const h = handlers[`${req.method} ${p}`];
      if (h) return send(res, 200, await h(req, url));

      if (req.method === 'GET' && !p.startsWith('/api/')) {
        const file = resolveIn(publicDir, p === '/' ? 'index.html' : p.slice(1));
        return exists(file) ? streamFile(res, file) : send(res, 404, { error: 'Not found' });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      const code = e.status || (e.code === 'NO_TOKEN' ? 400 : 500);
      if (code === 500) console.error(e);
      if (!res.headersSent) send(res, code, { error: e.message });
      else res.end();
    }
  });

  // Auto-run while the app is awake: once a day after `runHour`.
  let timer = null;
  function startScheduler(intervalMs = 5 * 60 * 1000) {
    const tick = () => {
      const s = getSettings();
      if (s.autoRun && !daily.state.running && new Date().getHours() >= s.runHour && s.lastRunDate !== localDate() && process.env.APIFY_TOKEN) {
        console.log('[daily] starting scheduled run');
        try { startDaily(false); } catch (e) { console.error('[daily]', e.message); }
      }
    };
    timer = setInterval(tick, intervalMs);
    setTimeout(tick, 5000);
  }
  server.on('close', () => clearInterval(timer));
  return { server, store, daily, startScheduler };
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function localDate(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function countStatuses(list) {
  const c = {};
  for (const a of list) c[a.status] = (c[a.status] || 0) + 1;
  return c;
}

if (require.main === module) {
  loadEnv(path.join(__dirname, '.env'));
  const hosted = Boolean(process.env.RENDER || process.env.PUBLIC_MODE);
  const PORT = Number(process.env.PORT) || 5178;
  const HOST = hosted || process.argv.includes('--phone') ? '0.0.0.0' : (process.env.HOST || '127.0.0.1');
  if (hosted && String(process.env.APP_PIN || '').length < 4) {
    console.error('Refusing to start on the internet without a PIN. Set APP_PIN (at least 4 characters).');
    process.exit(1);
  }
  const remote = process.env.APIFY_TOKEN && (hosted || process.env.STORAGE === 'apify')
    ? createApifyKv({ token: process.env.APIFY_TOKEN, storeName: process.env.APIFY_STORE || 'job-agent-data' }) : null;
  const { server, store, startScheduler } = createApp({ remote });
  store.init().then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`\n  Job Agent running:  http://localhost:${PORT}${hosted ? ' (hosted mode)' : ''}`);
      if (remote) console.log('  Data is saved to your Apify storage (key-value store "job-agent-data").');
      if (HOST === '0.0.0.0' && !hosted) {
        const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
        ips.forEach(ip => console.log(`  On your phone (same Wi-Fi):  http://${ip}:${PORT}`));
        if (!process.env.APP_PIN) console.log('  Tip: set APP_PIN in .env so only you can use it on the network.');
      }
      if (!process.env.APIFY_TOKEN) console.log('  Note: APIFY_TOKEN not set. Live search is off; saved jobs still work.');
      if (!findBrowser()) console.log('  Note: Edge/Chrome not found. CVs are saved as HTML (use "Save as PDF").');
      console.log('');
    });
    startScheduler();
  });
  const shutdown = () => store.flush().finally(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
