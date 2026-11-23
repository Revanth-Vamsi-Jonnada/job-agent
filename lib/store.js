// JSON-file storage with atomic writes. When hosted (Render free wipes the disk on
// every restart), tracker/settings/profile are also mirrored to an Apify key-value
// store so nothing is lost: loaded once at start-up, saved (debounced) on every write.
const fs = require('fs');
const path = require('path');

const SYNC_KEYS = ['tracker.json', 'settings.json', 'profile.json'];

// Minimal Apify key-value store client. `base` is overridable for tests.
function createApifyKv({ token, storeName = 'job-agent-data', base = 'https://api.apify.com/v2' }) {
  let storeId = null;
  const headers = { Authorization: 'Bearer ' + token };
  async function id() {
    if (storeId) return storeId;
    const r = await fetch(`${base}/key-value-stores?name=${encodeURIComponent(storeName)}`, { method: 'POST', headers, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`Apify storage ${r.status}: ${(await r.text()).slice(0, 160)}`);
    storeId = (await r.json()).data.id;
    return storeId;
  }
  return {
    async get(key) {
      const r = await fetch(`${base}/key-value-stores/${await id()}/records/${encodeURIComponent(key)}`, { headers, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Apify storage ${r.status}`);
      return r.json();
    },
    async put(key, value) {
      const r = await fetch(`${base}/key-value-stores/${await id()}/records/${encodeURIComponent(key)}`, {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) throw new Error(`Apify storage ${r.status}`);
    },
  };
}

class Store {
  constructor(dir, { remote = null } = {}) {
    this.dir = dir;
    this.remote = remote;
    this.pending = new Map();
    this.timers = new Map();
    fs.mkdirSync(dir, { recursive: true });
  }
  file(name) { return path.join(this.dir, name); }
  remoteKey(name) { return name.replace(/\.json$/, ''); }

  // Pull saved data from Apify before the server starts answering requests.
  async init() {
    if (!this.remote) return;
    for (const name of SYNC_KEYS) {
      try {
        const data = await this.remote.get(this.remoteKey(name));
        if (data !== null) this.writeLocal(name, data);
      } catch (e) { console.warn(`[store] could not load ${name} from Apify: ${e.message}`); }
    }
  }

  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')); }
    catch { return typeof fallback === 'function' ? fallback() : structuredClone(fallback); }
  }
  writeLocal(name, data) {
    const f = this.file(name);
    const tmp = f + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, f);
  }
  write(name, data) {
    this.writeLocal(name, data);
    if (this.remote && SYNC_KEYS.includes(name)) {
      // Debounce: a daily run writes the tracker many times a minute.
      this.pending.set(name, data);
      clearTimeout(this.timers.get(name));
      this.timers.set(name, setTimeout(() => this.push(name), 1500));
    }
    return data;
  }
  async push(name) {
    const data = this.pending.get(name);
    if (data === undefined) return;
    this.pending.delete(name);
    try { await this.remote.put(this.remoteKey(name), data); }
    catch (e) { console.warn(`[store] could not save ${name} to Apify: ${e.message}`); this.pending.set(name, data); }
  }
  async flush() {
    for (const [name, t] of this.timers) { clearTimeout(t); await this.push(name); }
  }

  applications() { return this.read('tracker.json', { applications: [] }).applications; }
  saveApplications(list) { this.write('tracker.json', { applications: list }); }
  upsertApplication(app) {
    const list = this.applications();
    const i = list.findIndex(a => a.id === app.id);
    // Re-tailoring refreshes the documents but keeps the user's status and notes.
    if (i >= 0) list[i] = { ...list[i], ...app, status: list[i].status, notes: list[i].notes, foundAt: list[i].foundAt };
    else list.unshift(app);
    this.saveApplications(list);
    return i >= 0 ? list[i] : app;
  }
  updateApplication(id, patch) {
    const list = this.applications();
    const a = list.find(x => x.id === id);
    if (!a) return null;
    for (const k of ['status', 'notes', 'company', 'title']) if (k in patch) a[k] = String(patch[k]).slice(0, 2000);
    if (patch.status === 'Applied' && !a.appliedAt) a.appliedAt = new Date().toISOString();
    this.saveApplications(list);
    return a;
  }
  deleteApplication(id) {
    const list = this.applications();
    const next = list.filter(a => a.id !== id);
    this.saveApplications(next);
    return next.length !== list.length;
  }
}

const DEFAULT_SETTINGS = {
  queries: ['graduate data scientist', 'graduate AI engineer', 'graduate data analyst'],
  location: 'UK',
  posted: '7d',
  dailyTarget: 50,
  minLabel: 'Medium',
  autoRun: false,
  runHour: 8,
  lastRunDate: null,
};

module.exports = { Store, DEFAULT_SETTINGS, createApifyKv, SYNC_KEYS };
