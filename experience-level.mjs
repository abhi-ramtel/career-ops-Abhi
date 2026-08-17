#!/usr/bin/env node

/**
 * experience-level.mjs — years-of-experience parsing and early-career banding
 *
 * WHY THIS EXISTS (and why it is not classify-tier.mjs)
 *
 * `classify-tier.mjs` answers "what level does this TITLE claim?" — intern /
 * entry / mid / senior, from the title string alone. That is all it ever sees,
 * and it is deliberately kept that way: scan.mjs uses it as a hard skip filter,
 * and a title-only rule is cheap and predictable.
 *
 * It cannot answer the question this module exists for: "how many years does
 * this role actually want?" A posting titled plain "Software Engineer" is
 * `mid` by classifyTier's own documented fallback, whether its description
 * says "0-2 years" or "8+ years". For a candidate targeting 0-2 years that
 * difference is the whole decision, and nothing in the repo read it before —
 * there was no years-of-experience parsing anywhere.
 *
 * So this module reads the DESCRIPTION for a stated requirement, reads the
 * title for explicit early-career programme wording, and combines both with
 * classifyTier into one band. classifyTier stays the title authority and is
 * called, not reimplemented.
 *
 * Everything degrades to `unknown` rather than guessing: most ATS list
 * payloads ship no description at all, and an unknown band must never be
 * treated as a rejection.
 *
 * Usage:
 *   node experience-level.mjs "Software Engineer I" "0-2 years of experience"
 *   node experience-level.mjs --self-test
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { classifyTier } from './classify-tier.mjs';

/** Number words that realistically appear in a years requirement. */
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15,
};

/**
 * Titles that explicitly advertise an early-career/new-graduate role.
 *
 * These are the wordings that classifyTier maps to `mid` today because they
 * carry no I/II/junior/associate marker — "New Grad Software Engineer" is the
 * canonical example. Kept separate from classify-tier.mjs's own entry list so
 * the two stay independently testable.
 */
export const EARLY_CAREER_TITLE_PATTERNS = [
  /\bnew\s*grad(uate)?s?\b/i,
  /\brecent\s+grad(uate)?s?\b/i,
  /\buniversity\s+grad(uate)?s?\b/i,
  /\bcollege\s+grad(uate)?s?\b/i,
  /\bgrad(uate)?\s+(engineer|developer|programme?|program|scheme|role|position|opportunit)/i,
  /\bearly\s+career\b/i,
  /\bentry[\s-]?level\b/i,
  /\bcampus\b/i,
  /\bemerging\s+talent\b/i,
  /\brotational\s+(program|programme)\b/i,
  /\b(19|20)\d{2}\s+grad(uate)?s?\b/i,
];

/**
 * Early-career wording that only appears in DESCRIPTIONS.
 *
 * "within 2 years of graduation" is an eligibility window, not a requirement
 * of 2 years' work — parseYearsRequired must not read it as one, and it is a
 * positive early-career signal instead.
 */
export const EARLY_CAREER_TEXT_PATTERNS = [
  /\bnew\s*grad(uate)?s?\b/i,
  /\brecent(ly)?\s+grad(uat\w+)?\b/i,
  /\bgraduating\s+(in|by|student)/i,
  /\bwithin\s+\w+\s+years?\s+of\s+(graduation|graduating)\b/i,
  /\bno\s+(prior\s+)?(professional\s+)?experience\s+(is\s+)?(required|necessary)\b/i,
  /\bentry[\s-]?level\b/i,
  /\bearly[\s-]in[\s-]career\b/i,
  /\bearly\s+career\b/i,
  /\bstudents?\s+and\s+new\s+grad/i,
];

/**
 * Contexts where a "N years" phrase is NOT a work-experience requirement.
 *
 * Without these, "within 2 years of graduation" (an early-career window),
 * "4 year degree" (a credential) and "over the last 3 years" (company
 * narrative) all read as a 2/4/3-year requirement and push a new-grad role out
 * of the early band — the exact opposite of the intent.
 */
const YEARS_FALSE_POSITIVE_CONTEXT = [
  /within\s+[\w-]+\s+years?\s+of\s+/i,
  /\b(4|four|3|three|2|two)[\s-]year\s+(degree|program|programme|university|college|course)\b/i,
  /\b(bachelor|master|associate)('?s)?\s+degree[^.]{0,40}\byears?\b/i,
  /\b(last|past|previous|next|coming|recent)\s+[\w-]+\s+years?\b/i,
  /\byears?\s+(in\s+business|of\s+operation|since\s+)/i,
  /\bover\s+the\s+[\w-]+\s+years?\b/i,
  /\b\d+\s+years?\s+old\b/i,
];

/** Parse a numeric or word quantity into a number, or null. */
function toNumber(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === '') return null;
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, s)) return NUMBER_WORDS[s];
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : null;
}

const NUM = '(\\d{1,2}|zero|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen)';
// En/em dash and "to" all spell a range in real postings.
const RANGE_SEP = '\\s*(?:-|\u2013|\u2014|to|through)\\s*';

/**
 * Requirement patterns, most specific first. Each yields {min, max}.
 *
 * `plus` (e.g. "3+ years") states a floor with no ceiling. A bare "5 years of
 * experience" is also treated as a floor, not an exact figure — postings mean
 * "at least" even when they omit the word.
 */
const YEARS_PATTERNS = [
  // "0-2 years", "1 to 3 years"
  {
    re: new RegExp(`${NUM}${RANGE_SEP}${NUM}\\+?\\s*(?:\\+\\s*)?(?:years?|yrs?)\\b`, 'i'),
    take: (m) => ({ min: toNumber(m[1]), max: toNumber(m[2]) }),
  },
  // "at least 2 years", "minimum of 3 years", "no less than 4 years"
  {
    re: new RegExp(`(?:at\\s+least|minimum\\s+(?:of\\s+)?|min\\.?\\s*|no\\s+less\\s+than|not\\s+less\\s+than)\\s*${NUM}\\s*\\+?\\s*(?:years?|yrs?)\\b`, 'i'),
    take: (m) => ({ min: toNumber(m[1]), max: null }),
  },
  // "3+ years", "3 + yrs"
  {
    re: new RegExp(`${NUM}\\s*\\+\\s*(?:years?|yrs?)\\b`, 'i'),
    take: (m) => ({ min: toNumber(m[1]), max: null }),
  },
  // "up to 2 years"
  {
    re: new RegExp(`up\\s+to\\s+${NUM}\\s*(?:years?|yrs?)\\b`, 'i'),
    take: (m) => ({ min: 0, max: toNumber(m[1]) }),
  },
  // bare "2 years of experience"
  {
    re: new RegExp(`${NUM}\\s*(?:years?|yrs?)\\b(?:\\s+of)?\\s*(?:relevant\\s+|professional\\s+|industry\\s+|software\\s+|engineering\\s+|work\\s+)*(?:experience|exp\\b)`, 'i'),
    take: (m) => ({ min: toNumber(m[1]), max: null }),
  },
];

/** Split text into sentence-ish spans so false-positive context is local. */
function spansOf(text) {
  return String(text)
    .replace(/\r/g, '')
    .split(/(?<=[.;:!?])\s+|\n+|\u2022|\|/g)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Extract the experience requirement stated in free text.
 *
 * Returns the LOWEST stated minimum across the document, not the first or the
 * highest. Postings routinely pair a hard floor with an aspirational one
 * ("2+ years required, 5+ preferred"); the floor is what actually gates an
 * applicant, so taking the max would wrongly exclude a role the candidate
 * qualifies for.
 *
 * @param {string} text
 * @returns {{min: number|null, max: number|null, evidence: string|null}}
 */
export function parseYearsRequired(text) {
  const empty = { min: null, max: null, evidence: null };
  if (typeof text !== 'string' || text.trim() === '') return empty;

  let best = null;
  for (const span of spansOf(text)) {
    if (YEARS_FALSE_POSITIVE_CONTEXT.some(re => re.test(span))) continue;
    for (const { re, take } of YEARS_PATTERNS) {
      const m = span.match(re);
      if (!m) continue;
      const got = take(m);
      if (got.min == null && got.max == null) continue;
      const floor = got.min ?? got.max ?? null;
      if (floor == null) continue;
      if (best === null || floor < best.floor) {
        best = { floor, min: got.min, max: got.max, evidence: span.slice(0, 160) };
      }
      break; // first (most specific) pattern that matches this span wins
    }
  }

  return best ? { min: best.min, max: best.max, evidence: best.evidence } : empty;
}

/** Whether any early-career wording appears in the title. */
export function hasEarlyCareerTitle(title) {
  return typeof title === 'string' && EARLY_CAREER_TITLE_PATTERNS.some(re => re.test(title));
}

/** Whether any early-career wording appears in the description. */
export function hasEarlyCareerText(text) {
  return typeof text === 'string' && EARLY_CAREER_TEXT_PATTERNS.some(re => re.test(text));
}

/**
 * Band a posting for a candidate targeting 0-2 years.
 *
 * Bands: 'intern' | 'early' | 'mid' | 'senior' | 'unknown'
 *
 * Precedence, and why:
 *  1. An explicit years RANGE whose floor is above the target wins over any
 *     title wording. "Associate Engineer, 5+ years" is not an early role no
 *     matter what the title says, and the title is the part employers are
 *     loosest with.
 *  2. Explicit early-career wording (title or description) wins over
 *     classifyTier's `mid` FALLBACK, which is an "unknown", not a finding.
 *  3. Otherwise classifyTier decides, and its `mid` fallback on a bare title
 *     with no years evidence is reported as 'unknown' rather than 'mid' — so
 *     a preference filter can keep it instead of silently dropping it.
 *
 * @param {{title?: string, description?: string, maxYears?: number}} input
 */
export function classifyExperienceLevel({ title = '', description = '', maxYears = 2 } = {}) {
  const signals = [];
  const tier = classifyTier(title);
  const years = parseYearsRequired(description);
  const earlyTitle = hasEarlyCareerTitle(title);
  const earlyText = hasEarlyCareerText(description);

  if (earlyTitle) signals.push('early-career-title');
  if (earlyText) signals.push('early-career-text');
  if (years.min != null || years.max != null) {
    signals.push(`years:${years.min ?? '?'}-${years.max ?? '+'}`);
  }
  signals.push(`tier:${tier}`);

  const floor = years.min ?? null;

  // 1. A stated floor above the target is decisive.
  if (floor != null && floor > maxYears) {
    return { band: floor >= 6 ? 'senior' : 'mid', tier, years, signals, earlyCareer: false };
  }

  if (tier === 'intern') {
    return { band: 'intern', tier, years, signals, earlyCareer: false };
  }

  // 2. Explicit early wording, or a floor inside the target range.
  if (earlyTitle || earlyText || (floor != null && floor <= maxYears)) {
    // A genuinely senior TITLE still overrides description boilerplate:
    // "Senior Engineer" in a posting that mentions a new-grad programme
    // elsewhere is not an early-career role.
    if (tier === 'senior' && !earlyTitle) {
      return { band: 'senior', tier, years, signals, earlyCareer: false };
    }
    return { band: 'early', tier, years, signals, earlyCareer: true };
  }

  if (tier === 'entry') return { band: 'early', tier, years, signals, earlyCareer: true };
  if (tier === 'senior') return { band: 'senior', tier, years, signals, earlyCareer: false };

  // 3. classifyTier's documented fallback for an unmarked title. Reported as
  // unknown so callers can choose to keep it; calling it 'mid' would let a
  // deprioritize rule drop every plain "Software Engineer" posting.
  return { band: 'unknown', tier, years, signals, earlyCareer: false };
}

/**
 * Rank weight for a band, high = better for an early-career candidate.
 * Used to order the scan output; never to drop a posting on its own.
 */
export const BAND_WEIGHT = {
  early: 3,
  unknown: 1,
  intern: 0,
  mid: -1,
  senior: -3,
};

/** Sort comparator: best early-career fit first, stable on ties. */
export function compareEarlyCareerFit(a, b) {
  return (BAND_WEIGHT[b?.band] ?? 0) - (BAND_WEIGHT[a?.band] ?? 0);
}

export default classifyExperienceLevel;

// ── CLI / self-test ─────────────────────────────────────────────────
const isDirect = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
  } else if (args.length > 0) {
    console.log(JSON.stringify(classifyExperienceLevel({ title: args[0], description: args[1] || '' }), null, 2));
  } else {
    console.log('Usage:');
    console.log('  node experience-level.mjs "<title>" "[description]"');
    console.log('  node experience-level.mjs --self-test');
  }
}

function runSelfTest() {
  let passed = 0, failed = 0;
  const ok = (name, cond) => cond ? (passed++, console.log(`  ✓ ${name}`)) : (failed++, console.error(`  ✗ ${name}`));

  console.log('\nparseYearsRequired — ranges, floors, and non-requirements');
  ok('"0-2 years" → min 0 max 2', (() => { const y = parseYearsRequired('0-2 years of experience'); return y.min === 0 && y.max === 2; })());
  ok('en-dash "1–2 years" → min 1 max 2', (() => { const y = parseYearsRequired('1\u20132 years of experience'); return y.min === 1 && y.max === 2; })());
  ok('"1 to 3 years" → min 1 max 3', (() => { const y = parseYearsRequired('1 to 3 years'); return y.min === 1 && y.max === 3; })());
  ok('"5+ years" → min 5, no max', (() => { const y = parseYearsRequired('5+ years of software engineering experience'); return y.min === 5 && y.max === null; })());
  ok('"at least 3 years" → min 3', (() => { const y = parseYearsRequired('Candidates need at least 3 years experience'); return y.min === 3; })());
  ok('"minimum of two years" (word) → min 2', (() => { const y = parseYearsRequired('A minimum of two years of relevant experience.'); return y.min === 2; })());
  ok('"up to 2 years" → min 0 max 2', (() => { const y = parseYearsRequired('up to 2 years'); return y.min === 0 && y.max === 2; })());
  ok('lowest floor wins over aspirational figure', (() => { const y = parseYearsRequired('2+ years required. 8+ years preferred.'); return y.min === 2; })());
  ok('"within 2 years of graduation" is NOT a requirement', parseYearsRequired('Open to those within 2 years of graduation.').min === null);
  ok('"4 year degree" is NOT a requirement', parseYearsRequired('Requires a 4 year degree in CS.').min === null);
  ok('"over the last 3 years" is NOT a requirement', parseYearsRequired('We tripled revenue over the last 3 years.').min === null);
  ok('empty text → nulls', parseYearsRequired('').min === null);

  console.log('\nclassifyExperienceLevel — banding');
  const band = (t, d) => classifyExperienceLevel({ title: t, description: d }).band;
  ok('"New Grad Software Engineer" → early (classifyTier alone says mid)', band('New Grad Software Engineer') === 'early');
  ok('"Software Engineer I" → early', band('Software Engineer I') === 'early');
  ok('"Junior Software Engineer" → early', band('Junior Software Engineer') === 'early');
  ok('"Associate Software Engineer" → early', band('Associate Software Engineer') === 'early');
  ok('"University Graduate, Software" → early', band('University Graduate, Software') === 'early');
  ok('plain "Software Engineer" + "0-2 years" → early', band('Software Engineer', 'You have 0-2 years of experience.') === 'early');
  ok('plain "Software Engineer", no description → unknown (never silently mid)', band('Software Engineer') === 'unknown');
  ok('plain "Software Engineer" + "8+ years" → senior', band('Software Engineer', 'Requires 8+ years of experience.') === 'senior');
  ok('plain "Software Engineer" + "4+ years" → mid', band('Software Engineer', 'Requires 4+ years of experience.') === 'mid');
  ok('"Senior Software Engineer" → senior', band('Senior Software Engineer') === 'senior');
  ok('"Staff Engineer" → senior', band('Staff Engineer') === 'senior');
  ok('"Engineering Manager" → senior via lead/manager tiering', ['senior', 'unknown'].includes(band('Engineering Manager')));
  ok('"Software Engineer Intern" → intern', band('Software Engineer Intern') === 'intern');
  ok('"Associate Director" stays senior (classifyTier guard respected)', band('Associate Director') === 'senior');
  ok('"Senior Engineer" in a JD mentioning a grad programme stays senior', band('Senior Engineer', 'We also run a new grad programme.') === 'senior');
  ok('title floor beats title wording: "Associate Engineer" + "5+ years" → mid', band('Associate Engineer', 'Requires 5+ years.') === 'mid');

  console.log('\ncompareEarlyCareerFit — ordering');
  const sorted = [
    { band: 'senior' }, { band: 'unknown' }, { band: 'early' }, { band: 'mid' },
  ].sort(compareEarlyCareerFit).map(x => x.band);
  ok('early > unknown > mid > senior', JSON.stringify(sorted) === JSON.stringify(['early', 'unknown', 'mid', 'senior']));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
