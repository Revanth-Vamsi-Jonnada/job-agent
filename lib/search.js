// Google job search (through Apify) restricted to company careers pages.
const crypto = require('crypto');
const { webSearch } = require('./apify');

// Company careers systems: results from these hosts are always company career pages.
const ATS_SITES = [
  'myworkdayjobs.com', 'greenhouse.io', 'jobs.lever.co', 'smartrecruiters.com', 'jobs.ashbyhq.com',
  'apply.workable.com', 'oraclecloud.com', 'taleo.net', 'avature.net', 'successfactors.com',
  'successfactors.eu', 'icims.com', 'eightfold.ai', 'tal.net', 'teamtailor.com', 'pinpointhq.com',
  'recruitee.com', 'bamboohr.com', 'personio.de', 'civilservicejobs.service.gov.uk',
];

// Job boards / aggregators / content sites: never company career pages.
// Entries ending in "." or without a dot match anywhere in the host name.
const BLOCKED = [
  'linkedin.com', 'lnkd.in', 'indeed.com', 'glassdoor.', 'reed.co.uk', 'totaljobs.com',
  'cv-library.co.uk', 'gradcracker.com', 'prospects.ac.uk', 'brightnetwork.co.uk',
  'targetjobs.co.uk', 'ziprecruiter.', 'jobleads.com', 'jobijoba.', 'jobrapido.',
  'careerjet.', 'adzuna.', 'simplyhired.', 'monster.', 'prosple.com', 'higherin.com',
  'studysmarter.', 'bebee.com', 'builtin', 'vercida.com', 'facebook.com', 'reddit.com',
  'youtube.com', 'debut.careers', 'ep-advisory.com', 'womenindata.', 'milkround.com',
  'ratemyplacement.', 'the-trackr.com', 'trackr', 'talent.com', 'jooble.', 'efinancialcareers.',
  'otta.com', 'welcometothejungle.', 'wellfound.com', 'jobted.', 'jobsite.co.uk',
  'guardianjobs.', 'technojobs.', 'workinstartups.', 'instagram.com', 'x.com', 'twitter.com',
  'medium.com', 'quora.com', 'wikipedia.org', 'youth-employment', 'graduateland.',
  'joblift.', 'whatjobs.', 'neuvoo.', 'jobs.ac.uk', 'thegraduatelist.', 'student-circus.',
  'interviewquery.', 'tiktok.com', 'apify.com', 'jobserve.', 'cwjobs.', 'hays.', 'michaelpage.',
];

const CAREER_HINT = /(career|careers|jobs?|vacanc|recruit|graduate|early-?careers|talent|apply|opportunit|join-?us|work-?with-?us)/i;
const LISTING_HINT = /(\/jobs\/?$|\/search|search for jobs|current openings|^careers$|open roles|jobs at |\/early-careers\/?$|view jobs|find jobs|search jobs)/i;

function hostOf(u) { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }
function isBlocked(host) {
  return BLOCKED.some(b => (b.endsWith('.') || !b.includes('.')) ? host.includes(b) : (host === b || host.endsWith('.' + b)));
}
function isATS(host) { return ATS_SITES.some(s => host === s || host.endsWith('.' + s)); }

function normaliseUrl(u) {
  try {
    const url = new URL(u);
    [...url.searchParams.keys()].forEach(k => {
      if (/^(utm_|iis$|stype$|source$|oga$|ref$|gh_src$|lever-source)/i.test(k)) url.searchParams.delete(k);
    });
    url.hash = '';
    return url.toString().replace(/\/apply\/?$/, '').replace(/\/$/, '');
  } catch { return String(u || ''); }
}
function idFor(url) { return crypto.createHash('sha1').update(normaliseUrl(url)).digest('hex').slice(0, 12); }

// Careers-site subdomains that are abbreviations of the company name.
const KNOWN = {
  lbg: 'Lloyds Banking Group', bny: 'BNY', wtw: 'WTW', lseg: 'LSEG', fca: 'FCA', gsk: 'GSK', hsbc: 'HSBC',
  awepeople: 'AWE', cgg: 'Viridien', 'osv-cci': 'Castleton Commodities', gresearch: 'G-Research',
  leonardocompany: 'Leonardo', archgroup: 'Arch Insurance', 'tas-daimler': 'Mercedes-Benz', worleyparsons: 'Worley',
  'g-mass': 'MASS', ttp1: 'TTP', aecom2: 'AECOM', optiverus: 'Optiver', wehrtyou: 'Hudson River Trading',
  quberesearchandtechnologies: 'Qube Research & Technologies', paconsulting: 'PA Consulting', legalandgeneral: 'Legal & General',
};
function prettyName(s) {
  const raw = String(s).trim();
  if (KNOWN[raw.toLowerCase()]) return KNOWN[raw.toLowerCase()];
  const words = raw.replace(/[-_]+/g, ' ');
  if (/^[b-df-hj-np-tv-xz]{2,4}$/i.test(words)) return words.toUpperCase(); // no vowels: an acronym (e.g. "rbs")
  return words.replace(/\b\w/g, c => c.toUpperCase());
}

function cleanTitle(title) {
  let t = String(title || '');
  t = t.replace(/^job description\s*-\s*/i, '');
  t = t.replace(/\s*[-|–]\s*(myworkdayjobs\.com|workable jobs?|smartrecruiters|lever|greenhouse|ashby|careers?( at .*)?|sign in|oracle)\s*$/i, '');
  t = t.replace(/\s*@\s*[^@]+$/, '');
  t = t.replace(/\s*\([A-Z0-9]{5,}\)\s*$/, '');
  return t.trim() || String(title || '').trim();
}

function companyFrom(url, title) {
  const host = hostOf(url);
  let p = [];
  try { p = new URL(url).pathname.split('/').filter(Boolean); } catch {}
  const at = String(title || '').match(/@\s*([^@]+)$/);
  if (host.endsWith('ashbyhq.com') && at) return at[1].trim();
  if (host.endsWith('myworkdayjobs.com') || host.endsWith('taleo.net') || host.endsWith('avature.net'))
    return prettyName(host.split('.')[0]);
  if (/greenhouse\.io|jobs\.lever\.co|smartrecruiters\.com|ashbyhq\.com|apply\.workable\.com/.test(host))
    return prettyName(p[0] || host.split('.')[0]);
  if (host.endsWith('oraclecloud.com')) {
    const m = String(title || '').match(/-\s*(.+?)\s*(Careers|Career|External)/i);
    return m ? m[1] : 'Company (Oracle careers site)';
  }
  if (host.includes('civilservicejobs')) return 'UK Civil Service';
  const parts = host.replace(/^(www|careers|jobs|apply|join|work)\./, '').split('.');
  return prettyName(parts[0]);
}

const POSTED_DAYS = { '24h': 1, '3d': 3, '7d': 7, any: null };
function dateFromFor(posted, now = new Date()) {
  const d = POSTED_DAYS[posted];
  if (!d) return undefined;
  return new Date(now.getTime() - d * 864e5).toISOString().slice(0, 10);
}

function buildQueries(q, location) {
  const loc = location ? ` ${location}` : '';
  const site = (label, s) => ({ label, query: `${q}${loc} site:${s}` });
  return [
    site('Workday', 'myworkdayjobs.com'),
    site('Greenhouse', 'greenhouse.io'),
    site('Lever', 'jobs.lever.co'),
    site('SmartRecruiters', 'smartrecruiters.com'),
    site('Ashby', 'jobs.ashbyhq.com'),
    site('Workable', 'apply.workable.com'),
    site('Oracle careers', 'oraclecloud.com'),
    { label: 'Taleo / Avature / SuccessFactors / iCIMS', query: `${q}${loc} site:taleo.net OR site:avature.net OR site:successfactors.com OR site:icims.com OR site:tal.net` },
    { label: 'Teamtailor / Pinpoint / Recruitee', query: `${q}${loc} site:teamtailor.com OR site:pinpointhq.com OR site:recruitee.com OR site:eightfold.ai` },
    { label: 'Company careers sites', query: `${q}${loc} careers apply -linkedin -indeed -glassdoor -reed -totaljobs`, open: true },
    { label: 'Careers / jobs URLs', query: `${q}${loc} inurl:careers OR inurl:jobs -linkedin -indeed -glassdoor`, open: true },
    { label: 'Early-careers pages', query: `${q}${loc} graduate OR "early careers" company careers page -linkedin -indeed`, open: true },
  ];
}

const OPEN_BLOCK = ['linkedin.com', 'indeed.com', 'glassdoor.co.uk', 'reed.co.uk', 'totaljobs.com',
  'gradcracker.com', 'prospects.ac.uk', 'brightnetwork.co.uk', 'ziprecruiter.co.uk', 'uk.prosple.com'];

// Turns raw search results (one list per query) into clean, de-duplicated job records.
function filterResults(lists, { dateFrom } = {}) {
  const seen = new Set();
  const jobs = [];
  const maxLen = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const r = list[i];
      if (!r || !r.url) continue;
      const host = hostOf(r.url);
      if (!host || isBlocked(host)) continue;
      const ats = isATS(host);
      if (!ats && !CAREER_HINT.test(r.url) && !CAREER_HINT.test(r.title || '')) continue;
      if (dateFrom && r.date && r.date < dateFrom) continue;
      const url = normaliseUrl(r.url);
      if (seen.has(url)) continue;
      seen.add(url);
      jobs.push({
        id: idFor(url),
        company: companyFrom(r.url, r.title),
        title: cleanTitle(r.title),
        url,
        snippet: r.snippet || '',
        date: r.date || '',
        source: ats ? (ATS_SITES.find(s => host === s || host.endsWith('.' + s)) || host) : host,
        listing: LISTING_HINT.test(url) || LISTING_HINT.test(r.title || ''),
      });
    }
  }
  return jobs;
}

async function runSearch({ q, location = '', posted = 'any', search = webSearch, onProgress = () => {} }) {
  const queries = buildQueries(q, location);
  const dateFrom = dateFromFor(posted);
  let done = 0;
  const settled = await Promise.allSettled(queries.map(item =>
    search(item.query, { dateFrom, blockedDomains: item.open ? OPEN_BLOCK : undefined })
      .then(res => { done++; onProgress({ done, total: queries.length, label: item.label, found: res.length }); return res; })
      .catch(err => { done++; onProgress({ done, total: queries.length, label: item.label, found: 0, error: String(err.message || err) }); throw err; })
  ));
  const errors = settled.filter(s => s.status === 'rejected').map(s => s.reason);
  if (errors.length === settled.length) throw errors[0];
  const lists = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
  const jobs = filterResults(lists, { dateFrom });
  jobs.sort((a, b) => Number(a.listing) - Number(b.listing));
  return { jobs, queriesRun: queries.length, queryErrors: errors.length };
}

module.exports = {
  ATS_SITES, BLOCKED, hostOf, isBlocked, isATS, normaliseUrl, idFor, cleanTitle, companyFrom,
  dateFromFor, buildQueries, filterResults, runSearch,
};
