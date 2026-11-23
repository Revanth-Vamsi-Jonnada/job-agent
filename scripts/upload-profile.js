// Uploads your private CV profile (data/profile.json) to your own Apify storage,
// where the hosted app reads it. Your details never go into the public GitHub repo.
// Usage:  npm run upload-profile        (needs APIFY_TOKEN in .env)
const fs = require('fs');
const path = require('path');
const { createApifyKv } = require('../lib/store');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const token = process.env.APIFY_TOKEN;
const file = path.join(root, 'data', 'profile.json');
if (!token || token.startsWith('paste_')) { console.error('Add your APIFY_TOKEN to .env first.'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('data/profile.json not found. Copy data/profile.example.json to data/profile.json and fill it in.'); process.exit(1); }

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const kv = createApifyKv({ token, storeName: process.env.APIFY_STORE || 'job-agent-data' });
kv.put('profile', profile)
  .then(() => console.log(`Uploaded the CV profile for ${profile.name} to your Apify storage. Restart the hosted app (or wait for it to wake) to use it.`))
  .catch(e => { console.error('Upload failed:', e.message); process.exit(1); });
