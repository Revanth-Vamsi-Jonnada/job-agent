// End-to-end: real HTTP server + fake Apify search/fetch (no credits used).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server');
const { findBrowser } = require('../lib/pdf');

const FAKE_RESULTS = [
  { url: 'https://lbg.wd3.myworkdayjobs.com/en-US/Graduate_careers/job/DS_1', title: 'Data Science & AI Graduate Scheme - Myworkdayjobs.com', snippet: 'Graduate scheme. Python, SQL, machine learning, GenAI.', date: '2026-11-21' },
  { url: 'https://jobs.lever.co/acme/abc', title: 'Senior Data Scientist', snippet: '5+ years of experience required', date: '2026-11-22' },
  { url: 'https://uk.linkedin.com/jobs/view/123', title: 'Graduate Data Analyst at X' },
  { url: 'https://careers.sky.com/earlycareers/graduates/data/data-and-analytics', title: 'Data and Analytics Graduate programme', snippet: 'Tableau, SQL, dashboards' },
];

let app, base, dataDir;
test.before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-agent-test-'));
  fs.copyFileSync(path.join(__dirname, '..', 'data', 'seed-jobs.json'), path.join(dataDir, 'seed-jobs.json'));
  app = createApp({
    dataDir,
    pin: '',
    search: async () => FAKE_RESULTS,
    fetchPage: async url => ({ text: `Job page for ${url}. We are looking for graduates with Python, SQL, machine learning and statistics. Experience with Google Cloud and Spark is a plus. ` + 'x '.repeat(200) }),
  });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
const servers = [];
const stop = s => { s.closeAllConnections(); s.close(); };
test.after(() => { stop(app.server); servers.forEach(stop); fs.rmSync(dataDir, { recursive: true, force: true }); });

const j = async (p, o = {}) => { const r = await fetch(base + p, { ...o, headers: { 'Content-Type': 'application/json' } }); return { status: r.status, body: await r.json() }; };

test('serves the app shell and PWA files', async () => {
  for (const p of ['/', '/app.js', '/styles.css', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await fetch(base + '/../server.js')).status, 404);
  assert.equal((await fetch(base + '/files/..%2F..%2Fprofile.json')).status, 404);
});

test('status and saved jobs (scored, sorted)', async () => {
  const s = await j('/api/status');
  assert.equal(s.status, 200);
  const seed = await j('/api/seed');
  assert.equal(seed.body.jobs.length, 50);
  assert.ok(seed.body.jobs[0].score >= seed.body.jobs[49].score);
});

test('search stream emits progress then scored careers-page jobs only', async () => {
  const r = await fetch(base + '/api/search/stream?q=graduate+data+scientist&location=UK&posted=7d');
  const text = await r.text();
  const events = text.trim().split('\n\n').map(b => ({ event: b.match(/^event: (.*)$/m)[1], data: JSON.parse(b.match(/^data: (.*)$/m)[1]) }));
  assert.ok(events.filter(e => e.event === 'progress').length >= 12);
  const done = events.find(e => e.event === 'done');
  assert.ok(done, 'done event');
  const urls = done.data.jobs.map(x => x.url);
  assert.ok(!urls.some(u => u.includes('linkedin')));
  assert.equal(done.data.jobs[0].company, 'Lloyds Banking Group');
  assert.equal(done.data.jobs[0].label, 'High');
  assert.equal(done.data.jobs.find(x => x.title === 'Senior Data Scientist').label, 'Low');
});

test('tailor creates CV + cover letter, saves to tracker, status can change', async () => {
  const job = { url: FAKE_RESULTS[0].url, title: 'Data Science & AI Graduate Scheme', company: 'Lloyds Banking Group', snippet: FAKE_RESULTS[0].snippet };
  const r = await j('/api/tailor', { method: 'POST', body: JSON.stringify({ job }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.confidence, 'full');
  assert.ok(r.body.gaps.includes('Google Cloud (GCP)'));
  const cv = await fetch(base + r.body.files.cvHtml);
  assert.equal(cv.status, 200);
  assert.ok((await cv.text()).includes('Lloyds Banking Group'));
  if (findBrowser()) {
    assert.ok(r.body.files.cvPdf, 'PDF generated');
    const pdf = await fetch(base + r.body.files.cvPdf);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  }
  const list = await j('/api/applications');
  assert.equal(list.body.applications.length, 1);
  const upd = await j('/api/applications/' + r.body.id, { method: 'PATCH', body: JSON.stringify({ status: 'Applied' }) });
  assert.equal(upd.body.status, 'Applied');
  assert.ok(upd.body.appliedAt);
  // Re-tailoring keeps the user's status
  const again = await j('/api/tailor', { method: 'POST', body: JSON.stringify({ job }) });
  assert.equal(again.body.status, 'Applied');
});

test('tailor rejects bad input', async () => {
  const r = await j('/api/tailor', { method: 'POST', body: JSON.stringify({ job: { url: 'javascript:alert(1)' } }) });
  assert.equal(r.status, 400);
});

test('settings validate and save', async () => {
  const bad = await j('/api/settings', { method: 'PUT', body: JSON.stringify({ queries: [] }) });
  assert.equal(bad.status, 400);
  const ok = await j('/api/settings', { method: 'PUT', body: JSON.stringify({ queries: ['graduate AI'], posted: '3d', dailyTarget: 2, minLabel: 'Low', location: 'Leeds' }) });
  assert.equal(ok.body.posted, '3d');
  assert.equal(ok.body.dailyTarget, 2);
});

test('daily run prepares new packs up to the target, skipping tracked jobs', async () => {
  const start = await j('/api/daily/run', { method: 'POST' });
  assert.equal(start.body.started, true);
  let s;
  for (let i = 0; i < 120; i++) {
    s = (await j('/api/daily/status')).body;
    if (!s.running) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(s.phase, 'done', JSON.stringify(s.log));
  assert.ok(s.summary.prepared >= 1 && s.summary.prepared <= 2);
  const list = (await j('/api/applications')).body.applications;
  assert.equal(new Set(list.map(a => a.id)).size, list.length, 'no duplicate applications');
});

test('profile validation', async () => {
  const bad = await j('/api/profile', { method: 'PUT', body: JSON.stringify({ name: 'x' }) });
  assert.equal(bad.status, 400);
});

test('hosted mode: PIN login cookie, lockout after 5 wrong PINs, cron secret', async () => {
  const locked = createApp({ dataDir, pin: '4321', cronSecret: 'cron-xyz', search: async () => FAKE_RESULTS, fetchPage: async () => ({ text: '' }) });
  await new Promise(r => locked.server.listen(0, '127.0.0.1', r));
  servers.push(locked.server);
  const b = `http://127.0.0.1:${locked.server.address().port}`;
  const login = (pin, ip) => fetch(b + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ pin }) });

  assert.equal((await fetch(b + '/')).status, 200, 'app shell loads so the login screen can show');
  assert.equal((await fetch(b + '/healthz')).status, 200, 'health check is public');
  assert.equal((await fetch(b + '/api/status')).status, 401);
  assert.equal((await fetch(b + '/api/status?pin=4321')).status, 401, 'PIN in the URL is not accepted');
  assert.equal((await fetch(b + '/files/2026-01-01/x-aaaaaaaaaaaa/a.pdf')).status, 401, 'documents need login too');

  const ok = await login('4321', '10.0.0.1');
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  const session = cookie.split(';')[0];
  assert.equal((await fetch(b + '/api/status', { headers: { cookie: session } })).status, 200);
  assert.equal((await fetch(b + '/api/status', { headers: { cookie: 'ja_s=9999999999999.forged' } })).status, 401, 'forged cookie rejected');

  for (let i = 0; i < 5; i++) await login('0000', '10.0.0.2');
  const blocked = await login('4321', '10.0.0.2');
  assert.equal(blocked.status, 429, 'locked out after 5 wrong PINs, even with the right one');
  assert.equal((await login('4321', '10.0.0.3')).status, 200, 'other addresses unaffected');

  // Cron hook: wrong secret refused; right secret respects the auto-run setting
  assert.equal((await fetch(b + '/api/cron/daily', { method: 'POST', headers: { authorization: 'Bearer nope' } })).status, 401);
  await fetch(b + '/api/settings', { method: 'PUT', headers: { cookie: session, 'Content-Type': 'application/json' }, body: JSON.stringify({ autoRun: false }) });
  const off = await (await fetch(b + '/api/cron/daily', { method: 'POST', headers: { authorization: 'Bearer cron-xyz' } })).json();
  assert.equal(off.started, false);
  assert.match(off.reason, /switched off/);
});

test('documents are rebuilt if the disk was wiped (hosted free plan)', async () => {
  const apps = (await j('/api/applications')).body.applications;
  const a = apps[0];
  assert.ok(!('description' in a), 'long descriptions are not sent to the browser');
  const cvPath = path.join(dataDir, 'applications', ...decodeURIComponent(a.files.cvHtml.slice(7)).split('/'));
  fs.rmSync(path.join(dataDir, 'applications'), { recursive: true, force: true });
  assert.equal(fs.existsSync(cvPath), false);
  const r = await fetch(base + a.files.cvHtml);
  assert.equal(r.status, 200);
  assert.ok((await r.text()).includes(a.company));
});

test('Apify key-value storage: data survives a restart with an empty disk', async () => {
  const { Store, createApifyKv } = require('../lib/store');
  const records = {};
  const http = require('http');
  const mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c).on('end', () => {
      assert.equal(req.headers.authorization, 'Bearer test-token');
      if (req.method === 'POST' && req.url.startsWith('/key-value-stores?name=')) { res.writeHead(201); return res.end(JSON.stringify({ data: { id: 'store1' } })); }
      const m = req.url.match(/^\/key-value-stores\/store1\/records\/(.+)$/);
      if (m && req.method === 'PUT') { records[m[1]] = body; res.writeHead(201); return res.end(); }
      if (m && req.method === 'GET') { if (!(m[1] in records)) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(records[m[1]]); }
      res.writeHead(404); res.end();
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  servers.push(mock);
  const kv = () => createApifyKv({ token: 'test-token', base: `http://127.0.0.1:${mock.address().port}` });
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-kv-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-kv-b-'));
  const s1 = new Store(dirA, { remote: kv() });
  s1.upsertApplication({ id: 'abcabcabcabc', title: 'T', company: 'C', status: 'Ready to apply' });
  s1.updateApplication('abcabcabcabc', { status: 'Interview' });
  await s1.flush();
  assert.ok(records.tracker, 'tracker saved to Apify');
  const s2 = new Store(dirB, { remote: kv() }); // fresh disk, like a Render restart
  await s2.init();
  assert.equal(s2.applications()[0].status, 'Interview');
  fs.rmSync(dirA, { recursive: true, force: true }); fs.rmSync(dirB, { recursive: true, force: true });
});
