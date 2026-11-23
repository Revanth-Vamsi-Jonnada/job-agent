const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const profile = require(path.join(__dirname, '..', 'data', 'profile.example.json'));
const { scoreJob } = require('../lib/score');
const S = require('../lib/search');
const { buildDocs, rankProjects } = require('../lib/tailor');

test('graduate data science job with matching skills scores High', () => {
  const r = scoreJob({ title: 'Graduate Data Scientist 2027', snippet: 'Python, SQL, machine learning and statistics. Build fraud models.' }, profile);
  assert.equal(r.label, 'High');
  assert.ok(r.matched.includes('Python') && r.matched.includes('SQL'));
});

test('senior role with years of experience scores Low', () => {
  const r = scoreJob({ title: 'Senior Data Scientist', snippet: 'You will have 5+ years of experience with Python and Spark.' }, profile);
  assert.equal(r.label, 'Low');
  assert.ok(r.warnings.some(w => /Senior/.test(w)));
  assert.ok(r.warnings.some(w => /5\+ years/.test(w)));
  assert.ok(r.gaps.includes('Spark'));
});

test('visa and closed warnings are detected', () => {
  const r = scoreJob({ title: 'Graduate Analyst', snippet: 'Please note we cannot sponsor visas. This vacancy has now expired.' }, profile);
  assert.ok(r.warnings.some(w => /sponsor/.test(w)));
  assert.ok(r.warnings.some(w => /closed|expired/i.test(w)));
});

test('expired / closed listings are pushed down (regression: Wise expired listing ranked #1)', () => {
  const a = scoreJob({ title: 'Graduate Data Scientist', note: 'Python, SQL and ML. The 2027 listing (jid-4351) has expired.' }, profile);
  const b = scoreJob({ title: 'Data Science Graduate', status: 'Closed - reopens autumn 2027', note: 'Python, SQL' }, profile);
  assert.ok(a.warnings.some(w => /closed or expired/.test(w)));
  assert.ok(b.warnings.some(w => /closed or expired/.test(w)));
  assert.notEqual(a.label, 'High');
});

test('short keywords do not match inside other words (AI vs "paid", R vs "role")', () => {
  const r = scoreJob({ title: 'Paid role in retail', snippet: 'Great training provided' }, profile);
  assert.ok(!r.matched.includes('AI'));
  assert.ok(!r.matched.includes('R'));
});

test('job boards are blocked, ATS and company sites are allowed', () => {
  assert.equal(S.isBlocked('uk.linkedin.com'), true);
  assert.equal(S.isBlocked('www.glassdoor.co.uk'), true);
  assert.equal(S.isBlocked('www.brightnetwork.co.uk'), true);
  assert.equal(S.isBlocked('www.fedex.com'), false, 'x.com must not block fedex.com');
  assert.equal(S.isATS('lbg.wd3.myworkdayjobs.com'), true);
  assert.equal(S.isATS('job-boards.greenhouse.io'), true);
  assert.equal(S.isATS('notmyworkdayjobs.com'), false);
});

test('filterResults dedupes, drops boards and non-career pages, applies date filter', () => {
  const list = [
    { url: 'https://uk.linkedin.com/jobs/view/1', title: 'Grad DS at Wise' },
    { url: 'https://jobs.smartrecruiters.com/PAConsulting/744-x?oga=true', title: '2027 Graduate Data Analyst' },
    { url: 'https://jobs.smartrecruiters.com/PAConsulting/744-x', title: '2027 Graduate Data Analyst' },
    { url: 'https://careers.sky.com/earlycareers/graduates/data', title: 'Data Graduate' },
    { url: 'https://www.example-news.com/article', title: 'News' },
    { url: 'https://lbg.wd3.myworkdayjobs.com/en-US/x/job/Old_1', title: 'Old job - Myworkdayjobs.com', date: '2026-01-01' },
  ];
  const jobs = S.filterResults([list], { dateFrom: '2026-11-20' });
  assert.deepEqual(jobs.map(j => j.company), ['PA Consulting', 'Sky']);
  assert.equal(jobs[0].url, 'https://jobs.smartrecruiters.com/PAConsulting/744-x');
});

test('cleanTitle and companyFrom', () => {
  assert.equal(S.cleanTitle('Data Science Graduate - Myworkdayjobs.com'), 'Data Science Graduate');
  assert.equal(S.cleanTitle('Graduate Applied AI Engineer @ Resonance'), 'Graduate Applied AI Engineer');
  assert.equal(S.companyFrom('https://jobs.ashbyhq.com/Resonance/123', 'Graduate Applied AI Engineer @ Resonance'), 'Resonance');
  assert.equal(S.companyFrom('https://lbg.wd3.myworkdayjobs.com/x', ''), 'Lloyds Banking Group');
  assert.equal(S.companyFrom('https://rbs.wd3.myworkdayjobs.com/x', ''), 'RBS');
  assert.equal(S.companyFrom('https://careers.aviva.co.uk/early', ''), 'Aviva');
});

test('dateFromFor maps posted filters', () => {
  const now = new Date('2026-11-23T12:00:00Z');
  assert.equal(S.dateFromFor('24h', now), '2026-11-22');
  assert.equal(S.dateFromFor('3d', now), '2026-11-20');
  assert.equal(S.dateFromFor('7d', now), '2026-11-16');
  assert.equal(S.dateFromFor('any', now), undefined);
});

test('tailoring reorders projects by job relevance', () => {
  assert.equal(rankProjects(profile, 'LLM generative AI agent engineer, prompt evaluation')[0].id, 'genai');
  assert.equal(rankProjects(profile, 'fraud risk analyst using machine learning')[0].id, 'fraud');
  assert.equal(rankProjects(profile, 'Tableau Power BI dashboard reporting analyst')[0].id, 'tableau');
  // regression: an ML / quant role that mentions "pricing" should still lead with the ML project
  assert.equal(rankProjects(profile, 'Graduate Quantitative Researcher. ML for pricing and forecasting. statistics')[0].id, 'fraud');
});

test('tailored CV and letter only use real profile content and escape job text', () => {
  const job = { title: 'Graduate <script>alert(1)</script> Analyst', company: 'Acme & Co', snippet: 'Tableau dashboards and SQL' };
  const description = 'Tableau dashboards, SQL, Spark';
  const score = scoreJob({ ...job, description }, profile);
  const { cvHtml, coverHtml } = buildDocs(job, profile, score, description);
  assert.ok(!cvHtml.includes('<script>alert'), 'job title must be escaped');
  assert.ok(cvHtml.includes('Acme &amp; Co'));
  for (const p of profile.projects) for (const b of p.bullets) {
    if (cvHtml.includes(p.title)) assert.ok(cvHtml.includes(b.replace(/&/g, '&amp;').replace(/'/g, '&#39;')), 'project bullets are copied verbatim');
  }
  assert.ok(coverHtml.includes('Spark'), 'gaps are acknowledged honestly in the cover letter');
  assert.ok(/not used/.test(coverHtml));
});
