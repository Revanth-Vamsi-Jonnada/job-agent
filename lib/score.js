// Estimates how well a job matches the profile and turns it into a
// High / Medium / Low "selection chance". It is a fit estimate from keywords
// and seniority signals, not a real probability of getting hired.

const LEVEL_POS = /\b(graduate|grad|entry[- ]level|junior|new grad|early careers?|trainee|graduate scheme|graduate programme|graduate program|class of 2027|2027 start|recent graduate)\b/i;
const SENIOR = /\b(senior|sr\.?|lead|principal|staff|head of|manager|director|vp|vice president|chief)\b/i;
const YEARS = /(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?(?:years?|yrs?)(?:'|’)?\s+(?:of\s+)?(?:professional\s+|relevant\s+|industry\s+|commercial\s+|hands-on\s+|work\s+|proven\s+)?experience/i;
const INTERN = /\b(intern|internship|placement|apprentice|apprenticeship|summer analyst|work experience|insight week|spring week)\b/i;
const PHD = /\bph\.?d\b/i;
const VISA = /(cannot|can't|can not|unable to|do not|don't|will not|won't|not able to)\s+(?:offer\s+|provide\s+|support\s+)?(?:visa\s+)?sponsor|no (?:visa )?sponsorship|without (?:the need for )?(?:visa )?sponsorship|not eligible for sponsorship/i;
const CLOSED = /((?:vacancy|listing|job|posting|advert)(?: \([^)]*\))? has (?:now )?expired|^closed\b|closed\s*-\s*reopens|no longer accepting|applications? (?:are|is) (?:now )?closed|position has been filled|job is no longer available|this job has expired|programmes? (?:are|is) currently closed)/i;

const cache = new WeakMap();
function compile(list) {
  if (!Array.isArray(list)) return [];
  if (cache.has(list)) return cache.get(list);
  const out = list.map(k => {
    try { return { ...k, re: new RegExp(`(?<![a-z0-9])(?:${k.pattern})(?![a-z0-9])`, 'i') }; }
    catch { return null; }
  }).filter(Boolean);
  cache.set(list, out);
  return out;
}

function labelFor(score) {
  return score >= 70 ? 'High' : score >= 45 ? 'Medium' : 'Low';
}

function scoreJob(job, profile, opts = {}) {
  const title = String(job.title || '');
  const text = [title, job.snippet, job.note, job.description].filter(Boolean).join(' \n ');
  const keywords = compile(profile.keywords);
  const gapKw = compile(profile.gapKeywords);

  const matched = keywords.filter(k => k.re.test(text));
  const gaps = gapKw.filter(k => k.re.test(text));
  const skillPts = matched.reduce((s, k) => s + (k.weight || 1), 0);
  const gapPts = gaps.reduce((s, k) => s + (k.weight || 1), 0);
  const coverage = skillPts + gapPts ? skillPts / (skillPts + gapPts) : 0.5;

  const reasons = [];
  const warnings = [];
  let score = 30 + (Math.min(skillPts, 14) / 14) * 30 + coverage * 15;

  if (SENIOR.test(title)) { score -= 35; warnings.push('Senior-level title: likely needs years of experience'); }
  else if (LEVEL_POS.test(title) || LEVEL_POS.test(text)) { score += 15; reasons.push('Graduate / entry-level role'); }

  const y = YEARS.exec(text);
  if (y && Number(y[1]) >= 2) {
    const yrs = Number(y[1]);
    score -= yrs >= 4 ? 30 : 15;
    warnings.push(`Asks for ${yrs}+ years' experience`);
  }
  if (INTERN.test(title)) { score -= 20; warnings.push('Internship / placement: often only for students returning to study'); }
  if (PHD.test(title)) { score -= 15; warnings.push('PhD-level role'); }

  if (VISA.test(text)) {
    if (profile.needsVisaSponsorship === true) { score -= 25; warnings.push('Employer says it cannot sponsor visas'); }
    else warnings.push('Employer says it cannot sponsor visas: check your right to work');
  }
  if (CLOSED.test(text) || CLOSED.test(String(job.status || ''))) { score -= 40; warnings.push('Listing looks closed or expired'); }

  const loc = String(opts.location || '').trim();
  if (loc && !/^(uk|united kingdom|gb|great britain)$/i.test(loc) && new RegExp(loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) {
    score += 5; reasons.push(`Mentions ${loc}`);
  }

  if (matched.length) reasons.unshift(`Matches ${matched.length} of your skills`);
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    label: labelFor(score),
    matched: matched.map(k => k.label),
    gaps: gaps.map(k => k.label),
    reasons,
    warnings,
    confidence: job.description && job.description.length > 300 ? 'full' : 'snippet',
  };
}

module.exports = { scoreJob, labelFor };
