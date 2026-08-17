#!/usr/bin/env node

/**
 * eligibility-filter.mjs — hard eligibility exclusions (sponsorship, citizenship, clearance)
 *
 * WHY THIS IS SEPARATE FROM scan.mjs's visa_filter
 *
 * Upstream's `buildVisaFilter` answers "does this posting sponsor a work
 * visa?" and reads `job.description` only. That covers sponsorship and
 * nothing else. Two other things disqualify a candidate on an F-1/OPT
 * footing just as absolutely, and neither has an upstream equivalent:
 *
 *   - US CITIZENSHIP requirements ("US citizens only")
 *   - SECURITY CLEARANCE requirements (TS/SCI, Secret, Public Trust)
 *
 * A non-citizen cannot hold a US clearance, so a clearance requirement is a
 * hard filter, not a preference. This module also reads the TITLE and
 * LOCATION, not just the description — "Software Engineer (TS/SCI required)"
 * is extremely common, and most ATS list APIs return no description at all,
 * so a description-only filter sees nothing to reject.
 *
 * Extracted out of scan.mjs (where it lived as GLOBAL_EXCLUSION_PATTERNS) so
 * it is independently testable, and so this fork's eligibility rules sit
 * outside the file upstream rewrites most heavily.
 *
 * THE FALSE-POSITIVE RULE
 *
 * Ordinary work-authorization boilerplate — "must be authorized to work in
 * the United States" — appears in a large share of perfectly applicable
 * postings. Rejecting it would empty the scan. Every pattern here therefore
 * requires an exclusionary context (required / only / must / active), and
 * spans carrying a negation ("no clearance required") are skipped outright.
 *
 * Usage:
 *   node eligibility-filter.mjs "some job text"
 *   node eligibility-filter.mjs --self-test
 */

import path from 'path';
import { fileURLToPath } from 'url';

/** Visa/sponsorship refusals. */
export const SPONSORSHIP_PATTERNS = [
  /we are unable to offer sponsorship for this role/i,
  /unable to (?:offer|provide) sponsorship/i,
  /no visa sponsorship/i,
  /\bno sponsorship\b/i,
  /will not sponsor/i,
  /won'?t sponsor/i,
  /cannot sponsor/i,
  /not able to sponsor/i,
  /do(?:es)? not (?:offer |provide )?sponsor/i,
  /sponsorship is not (?:available|offered|provided)/i,
  /without visa support or sponsorship/i,
  /not eligible for (?:visa )?sponsorship/i,
];

/**
 * US-citizenship requirements.
 *
 * Every pattern demands an exclusionary qualifier. A bare mention of the word
 * "citizen" is deliberately NOT enough: "US citizens, permanent residents and
 * visa holders are welcome" is an inclusive sentence and must pass.
 */
export const CITIZENSHIP_PATTERNS = [
  /\bmust\s+be\s+(?:a\s+|an\s+)?(?:u\.?\s?s\.?|us|american)\s+citizens?\b/i,
  /\bmust\s+(?:hold|have|possess)\s+(?:u\.?\s?s\.?|us|american)\s+citizenship\b/i,
  /\b(?:u\.?\s?s\.?|us|american)\s+citizens?(?:hip)?\s+(?:is\s+|are\s+)?(?:required|mandatory|requirement)\b/i,
  /\b(?:u\.?\s?s\.?|us|american)\s+citizens?\s+only\b/i,
  /\bonly\s+(?:u\.?\s?s\.?|us|american)\s+citizens?\b/i,
  /\brestricted\s+to\s+(?:u\.?\s?s\.?|us|american)\s+citizens?\b/i,
  /\bcitizenship\s+(?:is\s+)?(?:required|mandatory)\b/i,
  /\brequires?\s+(?:u\.?\s?s\.?|us|american)\s+citizenship\b/i,
  /\bmust\s+be\s+(?:a\s+|an\s+)?(?:u\.?\s?s\.?|us)\s+persons?\b/i,
  /\b(?:u\.?\s?s\.?|us)\s+persons?\s+only\b/i,
];

/**
 * Security-clearance requirements.
 *
 * "Secret" and "Public Trust" are only matched when adjacent to "clearance"
 * — the bare words are ordinary English. TS/SCI is matched alone because the
 * token has no non-clearance meaning; bare "SCI" is deliberately NOT matched
 * (it collides with sci-fi, SCI abbreviations, and company names).
 */
export const CLEARANCE_PATTERNS = [
  /\b(?:active|current|existing|valid)\s+(?:u\.?\s?s\.?\s+)?(?:security\s+|government\s+)?clearance\b/i,
  /\b(?:security|government)\s+clearance\s+(?:is\s+)?(?:required|mandatory|necessary|essential)\b/i,
  /\bclearance\s+(?:is\s+)?(?:required|mandatory)\b/i,
  /\brequires?\s+(?:an?\s+)?(?:active\s+|current\s+)?(?:u\.?\s?s\.?\s+)?(?:security\s+)?clearance\b/i,
  /\bmust\s+(?:have|possess|hold|obtain|maintain|currently\s+hold)\s+(?:an?\s+)?[\w\s/-]{0,24}?clearance\b/i,
  /\b(?:ability|able)\s+to\s+obtain\s+(?:and\s+maintain\s+)?(?:a\s+|an\s+)?[\w\s/-]{0,24}?clearance\b/i,
  /\beligible\s+(?:for|to\s+obtain)\s+(?:a\s+|an\s+)?[\w\s/-]{0,24}?clearance\b/i,
  /\bts\s*\/\s*sci\b/i,
  /\bts-sci\b/i,
  /\b(?:top[\s-]secret|secret|public\s+trust|q\s+clearance|l\s+clearance)\s+clearance\b/i,
  /\bclearance\s*:\s*(?:ts\/sci|top[\s-]secret|secret|public\s+trust)\b/i,
  /\bpoly(?:graph)?\s+(?:is\s+)?required\b/i,
];

/**
 * Spans containing these are skipped before any pattern runs.
 *
 * This is what separates "no clearance is required" (a posting actively
 * telling us it is open) from "clearance is required". Without it the
 * substring "clearance ... required" fires on both.
 */
export const NEGATION_PATTERNS = [
  /\bno\s+(?:security\s+|government\s+)?clearance\s+(?:is\s+)?(?:required|needed|necessary)\b/i,
  /\b(?:security\s+|government\s+)?clearance\s+(?:is\s+)?not\s+(?:required|needed|necessary)\b/i,
  /\bdoes\s+not\s+require\s+(?:a\s+|an\s+)?(?:u\.?\s?s\.?\s+)?(?:security\s+)?clearance\b/i,
  /\bno\s+(?:security\s+)?clearance\s+(?:needed|necessary)\b/i,
  /\bcitizenship\s+(?:is\s+)?not\s+(?:required|a\s+requirement)\b/i,
  /\bregardless\s+of\s+(?:citizenship|nationality|immigration\s+status)\b/i,
  /\bno\s+citizenship\s+requirement\b/i,
  /\bwe\s+(?:do\s+)?sponsor\b/i,
];

/** Every exclusion pattern, flat — order is irrelevant, any hit rejects. */
export const GLOBAL_EXCLUSION_PATTERNS = [
  ...SPONSORSHIP_PATTERNS,
  ...CITIZENSHIP_PATTERNS,
  ...CLEARANCE_PATTERNS,
];

const CATEGORIES = [
  ['sponsorship', SPONSORSHIP_PATTERNS],
  ['citizenship', CITIZENSHIP_PATTERNS],
  ['clearance', CLEARANCE_PATTERNS],
];

/**
 * Collect every text field a provider might carry the disqualifier in.
 *
 * Deliberately wider than `job.description`: most ATS list endpoints omit the
 * body entirely, and "Software Engineer (TS/SCI)" puts the disqualifier in the
 * title where a description-only filter would never look.
 */
export function gatherJobText(job) {
  return [
    job?.title, job?.company, job?.location, job?.description,
    job?.text, job?.snippet, job?.summary, job?.details,
    job?.body, job?.content, job?.descriptionPlain, job?.descriptionHtml,
  ]
    .filter(v => typeof v === 'string' && v.trim() !== '')
    .join('\n');
}

/**
 * Fold dotted country abbreviations to their bare form.
 *
 * MUST run before span splitting. "U.S." ends in a period, so the
 * sentence splitter below treated it as a sentence boundary and cut
 * "U.S. citizen required" into "U.S." + "citizen required" — after which no
 * citizenship pattern could ever match, because the country and the noun
 * ended up in different spans. That silently defeated the three most common
 * spellings of the single most important filter in this file.
 */
export function normalizeAbbreviations(text) {
  return String(text)
    .replace(/\bU\.\s?S\.\s?A\./gi, 'USA')
    .replace(/\bU\.\s?S\./gi, 'US')
    .replace(/\bU\.S\b/gi, 'US');
}

/** Sentence-ish spans, so a negation only shields its own clause. */
function spansOf(text) {
  return normalizeAbbreviations(String(text).replace(/\r/g, ''))
    .split(/(?<=[.;!?])\s+|\n+|•|\|/g)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Why a job is excluded, or null when it is eligible.
 * @returns {{category: string, pattern: string, evidence: string}|null}
 */
export function findExclusion(job) {
  const text = typeof job === 'string' ? job : gatherJobText(job);
  if (!text) return null;

  for (const span of spansOf(text)) {
    if (NEGATION_PATTERNS.some(re => re.test(span))) continue;
    for (const [category, patterns] of CATEGORIES) {
      for (const re of patterns) {
        if (re.test(span)) {
          return { category, pattern: String(re), evidence: span.slice(0, 160) };
        }
      }
    }
  }
  return null;
}

/** Whether a job must be excluded on eligibility grounds. */
export function matchesGlobalExclusion(job) {
  return findExclusion(job) !== null;
}

export default matchesGlobalExclusion;

// ── CLI / self-test ─────────────────────────────────────────────────
const isDirect = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
  } else if (args.length > 0) {
    const hit = findExclusion(args[0]);
    console.log(hit ? `EXCLUDE (${hit.category}) — ${hit.evidence}` : 'ELIGIBLE');
  } else {
    console.log('Usage:');
    console.log('  node eligibility-filter.mjs "<job text>"');
    console.log('  node eligibility-filter.mjs --self-test');
  }
}

function runSelfTest() {
  let passed = 0, failed = 0;
  const excl = (text, cat) => {
    const hit = findExclusion(text);
    const good = hit !== null && (!cat || hit.category === cat);
    good ? (passed++, console.log(`  ✓ EXCLUDE  ${text}`))
         : (failed++, console.error(`  ✗ MISSED   ${text}${hit ? ` (got ${hit.category}, want ${cat})` : ''}`));
  };
  const keep = (text) => {
    const hit = findExclusion(text);
    hit === null ? (passed++, console.log(`  ✓ keep     ${text}`))
                 : (failed++, console.error(`  ✗ WRONGLY EXCLUDED (${hit.category})  ${text}`));
  };

  console.log('\n━━━ Citizenship requirements must be excluded ━━━');
  ['U.S. citizen required', 'Must be a U.S. citizen', 'U.S. citizenship required',
   'U.S. citizens only', 'Citizenship required', 'US Citizens Only',
   'Only US citizens may apply', 'This role is restricted to US citizens',
   'Applicants must be US persons', 'US persons only',
   'Requires US citizenship'].forEach(t => excl(t, 'citizenship'));

  console.log('\n━━━ Clearance requirements must be excluded ━━━');
  ['Security clearance required', 'Active clearance required',
   'Must possess a Secret clearance', 'Top Secret clearance required',
   'TS/SCI required', 'Must obtain clearance', 'Ability to obtain clearance',
   'Active TS/SCI clearance', 'Requires an active security clearance',
   'Must currently hold a Top Secret clearance', 'Public Trust clearance required',
   'Clearance is required for this position',
   'Software Engineer (TS/SCI w/ Poly)',
   'Must be able to obtain and maintain a security clearance'].forEach(t => excl(t, 'clearance'));

  console.log('\n━━━ Sponsorship refusals must be excluded ━━━');
  ['We are unable to offer sponsorship for this role', 'No visa sponsorship',
   'We will not sponsor applicants for this position', 'No sponsorship available',
   'We cannot sponsor visas', 'Sponsorship is not available'].forEach(t => excl(t, 'sponsorship'));

  console.log('\n━━━ Ordinary work authorization must PASS ━━━');
  ['Must be authorized to work in the United States.',
   'You must be legally authorized to work in the US without restriction.',
   'Applicants must be authorized to work for any employer in the U.S.',
   'Must have work authorization in the United States',
   'No security clearance is required for this role.',
   'Security clearance is not required.',
   'This position does not require a security clearance.',
   'No clearance needed.',
   'We welcome US citizens, permanent residents, and visa holders.',
   'Open to all candidates regardless of citizenship.',
   'Citizenship is not required for this role.',
   'We sponsor H-1B and other work visas.',
   'Software Engineer, Backend',
   'Join our team building secret sauce for recommendations.',
   ''].forEach(keep);

  console.log('\n━━━ Structure ━━━');
  const t1 = gatherJobText({ title: 'SWE', location: 'Remote', description: 'Nice role' });
  passed += t1.includes('SWE') && t1.includes('Remote') ? 1 : (failed++, 0);
  console.log(`  ${t1.includes('SWE') ? '✓' : '✗'} gatherJobText spans title/location/description`);
  const t2 = findExclusion({ title: 'Software Engineer (TS/SCI required)' });
  passed += t2 ? 1 : (failed++, 0);
  console.log(`  ${t2 ? '✓' : '✗'} a title-only disqualifier is caught with no description present`);
  const t3 = findExclusion({ title: 'SWE', description: 'No clearance needed. Must be authorized to work in the US.' });
  passed += t3 === null ? 1 : (failed++, 0);
  console.log(`  ${t3 === null ? '✓' : '✗'} negation in one clause does not leak into the next`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
