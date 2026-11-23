// Builds a tailored CV and cover letter for one job.
// It only re-orders and selects content that is already in profile.json,
// so nothing is invented: the job text decides what goes first.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function projectRelevance(project, text) {
  const t = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
  return (project.keywords || []).reduce((n, k) => n + (t.includes(String(k).toLowerCase()) ? 1 : 0), 0);
}

function rankProjects(profile, text) {
  const ranked = (profile.projects || [])
    .map((p, i) => ({ p, rel: projectRelevance(p, text), i }))
    .sort((a, b) => b.rel - a.rel || a.i - b.i);
  const keep = ranked.filter((r, idx) => idx < 3 || r.rel > 0).slice(0, 5);
  return keep.map(r => ({ ...r.p, relevance: r.rel }));
}

function rankSkills(profile, text) {
  const t = text.toLowerCase();
  const hit = item => {
    const words = String(item).toLowerCase().replace(/\(.*?\)/g, ' ').split(/[^a-z0-9+#.-]+/).filter(w => w.length > 2 || ['r', 'sql', 'bi', 'ai', 'ml'].includes(w));
    return words.some(w => w.length <= 3 ? new RegExp(`(?<![a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(t) : t.includes(w));
  };
  return (profile.skills || [])
    .map((g, i) => {
      const items = g.items.map((it, j) => ({ it, h: hit(it), j })).sort((a, b) => Number(b.h) - Number(a.h) || a.j - b.j);
      return { group: g.group, items: items.map(x => x.it), hits: items.filter(x => x.h).length, i };
    })
    .sort((a, b) => b.hits - a.hits || a.i - b.i);
}

function listJoin(arr) {
  if (arr.length <= 1) return arr.join('');
  return arr.slice(0, -1).join(', ') + ' and ' + arr[arr.length - 1];
}

const BASE_CSS = `
  @page { size: A4; margin: 13mm 15mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; line-height: 1.36; color: #111; margin: 0; }
  a { color: #0b4f8a; text-decoration: none; }
  p { margin: 0 0 4px; }
  ul { margin: 2px 0 5px; padding-left: 16px; }
  li { margin: 0 0 2px; }
  @media screen { body { max-width: 210mm; margin: 24px auto; padding: 0 16px; } .print { position: fixed; top: 12px; right: 12px; padding: 8px 14px; } }
  @media print { .print { display: none; } }
`;

function buildCv(job, profile, score, text) {
  const projects = rankProjects(profile, text);
  const skills = rankSkills(profile, text);
  const lines = projects.slice(0, 2).map(p => p.summaryLine).filter(Boolean);
  const c = profile.contact || {};
  const linkTxt = u => String(u || '').replace(/^https?:\/\//, '');
  const summary = [
    profile.summaryIntro,
    lines.length ? `I have ${listJoin(lines)}.` : '',
    profile.summaryClose,
    job.title && job.company ? `I am applying for the ${job.title} role at ${job.company}.` : '',
  ].filter(Boolean).join(' ');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(profile.name)} - CV - ${esc(job.company)}</title>
<style>${BASE_CSS}
  h1 { font-size: 20pt; text-align: center; margin: 0 0 2px; letter-spacing: .5px; }
  .contact { text-align: center; font-size: 9.3pt; margin-bottom: 8px; }
  h2 { font-size: 10.8pt; text-transform: uppercase; letter-spacing: .4px; border-bottom: 1.2px solid #111; margin: 10px 0 5px; padding-bottom: 1px; }
  .row { display: flex; justify-content: space-between; gap: 12px; font-weight: bold; }
  .row .when { white-space: nowrap; }
  .proj { font-weight: bold; margin-top: 6px; }
  .proj .tag { font-weight: normal; color: #333; }
  .proj a { font-weight: normal; }
  .skills p { margin: 0 0 2px; }
</style></head><body>
<button class="print" onclick="print()">Save as PDF</button>
<h1>${esc(String(profile.name || '').toUpperCase())}</h1>
<div class="contact">${esc(c.location)} &nbsp;|&nbsp; ${esc(c.phone)} &nbsp;|&nbsp; ${esc(c.email)}<br>
${c.linkedin ? `<a href="${esc(c.linkedin)}">${esc(linkTxt(c.linkedin))}</a>` : ''}${c.github ? ` &nbsp;|&nbsp; <a href="${esc(c.github)}">${esc(linkTxt(c.github))}</a>` : ''}</div>
<h2>Profile</h2>
<p>${esc(summary)}</p>
<h2>Technical Skills</h2>
<div class="skills">${skills.map(g => `<p><strong>${esc(g.group)}:</strong> ${esc(g.items.join(', '))}</p>`).join('')}</div>
<h2>Education</h2>
${(profile.education || []).map(e => `<div class="row"><span>${esc(e.title)}</span><span class="when">${esc(e.when)}</span></div><p>${esc(e.detail)}</p>`).join('')}
<h2>Projects</h2>
${projects.map(p => `<div class="proj">${esc(p.title)} <span class="tag">${p.tag ? '| ' + esc(p.tag) : ''}</span>${(p.links || []).length ? ' <span class="tag">|</span> ' + p.links.map(l => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(' · ') : ''}</div>
<ul>${(p.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>`).join('')}
<h2>Employment</h2>
${(profile.employment || []).map(e => `<div class="row"><span>${esc(e.title)}</span><span class="when">${esc(e.when)}</span></div><ul>${(e.bullets || []).map(b => `<li>${esc(b)}</li>`).join('')}</ul>`).join('')}
${profile.previousRoles ? `<p><strong>Previous roles:</strong> ${esc(profile.previousRoles)}</p>` : ''}
${profile.strengths ? `<h2>Professional Strengths</h2><p>${esc(profile.strengths)}</p>` : ''}
</body></html>`;
}

function buildCoverLetter(job, profile, score, text, today = new Date()) {
  const projects = rankProjects(profile, text);
  const c = profile.contact || {};
  const date = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const role = job.title || 'this role';
  const company = job.company || 'your organisation';
  const strong = (score.matched || []).filter(m => !/^(AI|Communication|Stakeholders)$/.test(m)).slice(0, 3);
  const gaps = (score.gaps || []).slice(0, 3);

  const paras = [
    `I am applying for the ${role} role at ${company}.${profile.coverIntro ? ' ' + profile.coverIntro : ''}` +
      (strong.length ? ` The role's focus on ${listJoin(strong.map(s => s.toLowerCase().replace(/^sql$/, 'SQL').replace(/^python$/, 'Python').replace(/^llms$/, 'LLMs').replace(/^r$/, 'R').replace(/^tableau$/, 'Tableau').replace(/^power bi$/, 'Power BI')))} matches what I have been building.` : ''),
    ...projects.slice(0, 2).map(p => p.coverPara).filter(Boolean),
  ];
  const third = projects.slice(2).find(p => p.id === 'tableau');
  if (third && !projects.slice(0, 2).some(p => p.id === 'tableau')) paras.push(third.coverPara);
  else if (profile.coverWorkPara) paras.push(profile.coverWorkPara);
  if (gaps.length) paras.push(`I can see the role also involves ${listJoin(gaps)}. I have not used ${gaps.length > 1 ? 'these' : 'this'} in a project yet, and I am keen to learn quickly on the job, as I have done with every new tool so far.`);
  paras.push(`Thank you for considering my application. I would welcome the chance to discuss how I could contribute at ${company}.`);

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(profile.name)} - Cover Letter - ${esc(company)}</title>
<style>${BASE_CSS}
  @page { size: A4; margin: 18mm 20mm; }
  body { font-size: 10.5pt; line-height: 1.5; }
  .name { font-size: 15pt; font-weight: bold; }
  .contact { font-size: 9.5pt; color: #222; margin-bottom: 14px; }
  p { margin: 0 0 9px; }
</style></head><body>
<button class="print" onclick="print()">Save as PDF</button>
<div class="name">${esc(profile.name)}</div>
<div class="contact">${esc(c.location)} · ${esc(c.phone)} · ${esc(c.email)}${c.linkedin ? `<br><a href="${esc(c.linkedin)}">${esc(String(c.linkedin).replace(/^https?:\/\//, ''))}</a>` : ''}</div>
<p>${esc(date)}</p>
<p>Hiring Team<br>${esc(company)}</p>
<p>Dear Hiring Team,</p>
<p><strong>${esc(role)}</strong></p>
${paras.map(p => `<p>${esc(p)}</p>`).join('\n')}
<p>Yours sincerely,<br><br>${esc(profile.name)}</p>
</body></html>`;
}

function buildDocs(job, profile, score, description = '') {
  const text = [job.title, job.snippet, description].filter(Boolean).join('\n');
  return {
    cvHtml: buildCv(job, profile, score, text),
    coverHtml: buildCoverLetter(job, profile, score, text),
    projectOrder: rankProjects(profile, text).map(p => p.id),
  };
}

module.exports = { buildDocs, rankProjects, rankSkills, esc };
