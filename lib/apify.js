// Thin client for two Apify Actors that run as HTTP APIs (Standby mode):
//   apify/web-search  -> Google results
//   apify/web-fetch   -> page content as markdown (renders JavaScript when asked)
// Endpoints can be overridden with APIFY_SEARCH_URL / APIFY_FETCH_URL (used by the tests).

const searchUrl = () => process.env.APIFY_SEARCH_URL || 'https://apify--web-search.apify.actor/';
const fetchUrl = () => process.env.APIFY_FETCH_URL || 'https://apify--web-fetch.apify.actor/';

function token() {
  const t = process.env.APIFY_TOKEN;
  if (!t) {
    const e = new Error('No Apify token. Copy .env.example to .env, paste your token from console.apify.com > Settings > API & Integrations, then restart the app.');
    e.code = 'NO_TOKEN';
    throw e;
  }
  return t;
}

async function call(base, params, timeoutMs) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, Array.isArray(v) ? v.join(',') : String(v));
  const res = await fetch(base + '?' + qs.toString(), {
    headers: { Authorization: 'Bearer ' + token() },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify ${res.status}: ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return { markdown: text }; }
}

async function webSearch(query, { countryCode = 'GB', dateFrom, blockedDomains } = {}) {
  const body = await call(searchUrl(), {
    query, provider: 'google', countryCode, languageCode: 'en', dateFrom,
    blockedDomains: blockedDomains && blockedDomains.slice(0, 10),
  }, 150000);
  return Array.isArray(body.results) ? body.results : [];
}

async function webFetch(url, { wait } = {}) {
  const body = await call(fetchUrl(), { url, formats: 'markdown', wait }, 90000);
  const markdown = body.markdown || body.text || (typeof body.body === 'string' ? body.body : '') || '';
  return { markdown: String(markdown), title: body.title || (body.metadata && body.metadata.title) || '' };
}

// Fetch a job page; if the result is tiny (JavaScript-rendered page), retry with browser rendering.
async function fetchJobPage(url) {
  let page = await webFetch(url);
  if (cleanMarkdown(page.markdown).length < 400) {
    try { page = await webFetch(url, { wait: 4000 }); } catch { /* keep the first result */ }
  }
  return { ...page, text: cleanMarkdown(page.markdown).slice(0, 15000) };
}

function cleanMarkdown(md) {
  return String(md || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#*_`>|]+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

module.exports = { webSearch, webFetch, fetchJobPage, cleanMarkdown };
