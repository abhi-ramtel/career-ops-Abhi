#!/usr/bin/env node
/**
 * auto-apply.mjs — Greenhouse / Ashby application prep.
 *
 * Reads a posting's REAL application form (not a guess, not a DOM scrape),
 * fills every field it can answer deterministically from config/profile.yml,
 * and hands back the short list of questions that actually need the
 * candidate's words.
 *
 * Both supported ATSs publish their form schema, so this is zero-token and
 * needs no browser:
 *   Greenhouse  boards-api.greenhouse.io/.../jobs/{id}?questions=true
 *   Ashby       jobs.ashbyhq.com/api/non-user-graphql (ApiJobPosting)
 *
 * IT NEVER SUBMITS. It has no submit path at all — no POST to any ATS, no
 * browser automation, nothing to click. That is deliberate and matches the
 * project rule in AGENTS.md: the candidate reviews and sends every
 * application themselves. What this removes is the transcription work, not
 * the judgment.
 *
 * Two categories are surfaced rather than answered:
 *   - Knock-out questions whose honest answer conflicts with the profile
 *     (sponsorship, clearance, minimum YOE). Flagged loudly; never softened.
 *   - Anti-bot challenges. Detected and reported as blocking. Solving one is
 *     out of scope on purpose — a form asking a human to prove they are human
 *     is asking the candidate, not their tooling.
 *
 * Usage:
 *   node auto-apply.mjs --url <posting_url>
 *   node auto-apply.mjs --url <posting_url> --json
 *   node auto-apply.mjs --url <posting_url> --out data/applications/<slug>.json
 *   node auto-apply.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 career-ops';
const TIMEOUT_MS = 15_000;

// ── ATS detection ───────────────────────────────────────────────────

/**
 * Parse a posting URL into { ats, org, jobId }.
 * Returns null for anything that is not a Greenhouse or Ashby posting.
 */
export function detectAts(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // Greenhouse: job-boards.greenhouse.io/{org}/jobs/{id}
  //             boards.greenhouse.io/{org}/jobs/{id}
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const m = path.match(/^\/(?:embed\/job_app\?for=)?([A-Za-z0-9_-]+)\/jobs\/(\d+)/);
    if (m) return { ats: 'greenhouse', org: m[1], jobId: m[2] };
    // ?gh_jid= form used by embedded boards
    const jid = u.searchParams.get('gh_jid');
    const org = path.match(/^\/([A-Za-z0-9_-]+)/)?.[1];
    if (jid && org && /^\d+$/.test(jid)) return { ats: 'greenhouse', org, jobId: jid };
    return null;
  }

  // Ashby: jobs.ashbyhq.com/{org}/{uuid}
  if (/(^|\.)ashbyhq\.com$/.test(host)) {
    const m = path.match(/^\/([A-Za-z0-9_.-]+)\/([0-9a-f-]{36})/i);
    if (m) return { ats: 'ashby', org: m[1], jobId: m[2] };
    return null;
  }

  return null;
}

async function getJson(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers || {}) },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Form fetch: Greenhouse ──────────────────────────────────────────

/** Normalize Greenhouse's question list into the shared field shape. */
export function normalizeGreenhouse(job) {
  const fields = [];
  for (const q of Array.isArray(job?.questions) ? job.questions : []) {
    // A Greenhouse "question" can carry several inputs (e.g. a compound
    // address). Each becomes its own field, sharing the question's label.
    for (const f of Array.isArray(q.fields) ? q.fields : []) {
      fields.push({
        name: f.name,
        label: q.label ?? f.name,
        description: q.description || '',
        type: mapGreenhouseType(f.type),
        required: Boolean(q.required),
        options: (Array.isArray(f.values) ? f.values : []).map(v => ({
          label: String(v.label ?? ''),
          value: String(v.value ?? ''),
        })),
      });
    }
  }
  return { title: job?.title ?? '', absoluteUrl: job?.absolute_url ?? '', fields };
}

function mapGreenhouseType(t) {
  switch (t) {
    case 'input_text': return 'text';
    case 'textarea': return 'longtext';
    case 'input_file': return 'file';
    case 'multi_value_single_select': return 'select';
    case 'multi_value_multi_select': return 'multiselect';
    default: return String(t || 'text');
  }
}

async function fetchGreenhouseForm({ org, jobId }) {
  const job = await getJson(
    `https://boards-api.greenhouse.io/v1/boards/${org}/jobs/${jobId}?questions=true`,
  );
  return normalizeGreenhouse(job);
}

// ── Form fetch: Ashby ───────────────────────────────────────────────

const ASHBY_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id
    title
    applicationForm { sections { title fieldEntries { isRequired field } } }
  }
}`;

/** Normalize Ashby's form sections into the shared field shape. */
export function normalizeAshby(posting) {
  const fields = [];
  const sections = posting?.applicationForm?.sections ?? [];
  for (const section of Array.isArray(sections) ? sections : []) {
    for (const entry of Array.isArray(section.fieldEntries) ? section.fieldEntries : []) {
      const f = entry?.field ?? {};
      fields.push({
        name: f.path ?? f.id ?? f.title ?? '',
        label: f.title ?? '',
        description: section.title && section.title !== 'null' ? String(section.title) : '',
        type: mapAshbyType(f.type),
        required: Boolean(entry.isRequired),
        options: (Array.isArray(f.selectableValues) ? f.selectableValues : []).map(v => ({
          label: String(v.label ?? ''),
          value: String(v.value ?? ''),
        })),
      });
    }
  }
  return { title: posting?.title ?? '', fields };
}

function mapAshbyType(t) {
  switch (String(t)) {
    case 'String': return 'text';
    case 'LongText': return 'longtext';
    case 'File': return 'file';
    case 'Boolean': return 'boolean';
    case 'Email': return 'email';
    case 'Phone': return 'phone';
    case 'Location': return 'location';
    case 'ValueSelect': return 'select';
    case 'MultiValueSelect': return 'multiselect';
    case 'Number': return 'number';
    case 'Date': return 'date';
    default: return String(t || 'text').toLowerCase();
  }
}

async function fetchAshbyForm({ org, jobId }) {
  const body = JSON.stringify({
    operationName: 'ApiJobPosting',
    variables: { organizationHostedJobsPageName: org, jobPostingId: jobId },
    query: ASHBY_QUERY,
  });
  const res = await getJson('https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  if (res.errors?.length) throw new Error(`Ashby GraphQL: ${res.errors[0].message}`);
  const posting = res?.data?.jobPosting;
  if (!posting) throw new Error('Ashby returned no posting (removed or unlisted?)');
  return normalizeAshby(posting);
}

// ── Classification ──────────────────────────────────────────────────

// Order matters: the first match wins, so the full-name forms are listed
// before the first/last ones. "Legal Name" is a single full-name field on
// Ashby — matching it as a first name silently submitted "Abhi" with no
// surname, which is the kind of error nobody catches until an interview.
const IDENTITY_PATTERNS = [
  [/^full[\s_]?name$|^name$|^legal\s*name$|^preferred\s*name$/i, 'full_name'],
  [/^first[\s_]?name$|\bfirst name\b|^given name$/i, 'first_name'],
  [/^last[\s_]?name$|\blast name\b|^surname$|^family name$/i, 'last_name'],
  [/e-?mail/i, 'email'],
  [/phone|mobile|telephone/i, 'phone'],
  [/linkedin/i, 'linkedin'],
  [/github/i, 'github'],
  [/portfolio|personal (web)?site|website/i, 'portfolio'],
  [/^location$|where.*(based|located|working from)|current (city|location)/i, 'location'],
  [/resume|^cv$/i, 'resume'],
  [/cover letter/i, 'cover_letter'],
];

/** Questions whose honest answer is fixed by the profile and can gate an application. */
const KNOCKOUT_PATTERNS = [
  // ORDER IS LOAD-BEARING. Forms ask about work authorization and about visa
  // sponsorship as two separate questions with two DIFFERENT correct answers,
  // and the sponsorship pattern below is broad enough to swallow both. An
  // authorization question answered with a sponsorship answer is the single
  // most damaging mistake this tool could make for an F-1 candidate: "are you
  // authorized to work?" is a YES (OPT is an EAD), and answering it with
  // "yes, I need sponsorship" reads as a no to the filter that screens it.
  //
  // The ambiguous "unrestricted / without restriction" phrasing is matched
  // FIRST and routed to its own key so it is never silently auto-answered —
  // OPT is authorized but time-limited and field-tied, so the honest answer
  // depends on what the employer means.
  [/without restriction|unrestricted|no restrictions?\b/i, 'work_rights_ambiguous'],
  [/(legally )?authoriz(ed|ation) to work|eligible to work|right to work|permitted to work|work authoriz/i, 'work_authorization'],
  [/sponsor|h-?1b|require.*(sponsorship|visa)|visa/i, 'sponsorship'],
  [/security clearance|clearance|ts\/sci|\bsecret\b|public trust|us person|u\.s\. citizen|citizenship/i, 'clearance'],
  [/minimum of\s*\d+\s*years|at least\s*\d+\+?\s*years|\b\d+\+\s*years\b/i, 'experience_years'],
  [/salary|compensation expectation|desired (pay|comp)/i, 'compensation'],
  [/willing to relocate|relocation/i, 'relocation'],
  [/start date|when (can|could) you start|available to start/i, 'start_date'],
];

/**
 * A form asking the applicant to prove they are not a bot. Detected so it can
 * be reported, never solved: bypassing bot detection is off-limits, and these
 * are addressed to the candidate rather than to their tooling.
 */
const ANTIBOT_PATTERNS = [
  /not a bot/i,
  /auto-?apply/i,
  /prove (that )?you are (a )?human/i,
  /captcha/i,
  /figure out the (correct )?secret/i,
  /decode the following/i,
  /\bsecret\b.*\bsubmit\b|\bsubmit\b.*\bsecret\b/i,
];

export function classifyField(field) {
  const hay = `${field.label} ${field.description}`.trim();

  for (const re of ANTIBOT_PATTERNS) {
    if (re.test(hay)) return { kind: 'antibot', key: null };
  }
  for (const [re, key] of IDENTITY_PATTERNS) {
    if (re.test(field.label)) return { kind: 'identity', key };
  }
  for (const [re, key] of KNOCKOUT_PATTERNS) {
    if (re.test(hay)) return { kind: 'knockout', key };
  }
  if (field.type === 'longtext') return { kind: 'freetext', key: null };
  if (/gender|race|ethnic|veteran|disability|hispanic|pronoun/i.test(hay)) {
    return { kind: 'demographic', key: null };
  }
  return { kind: 'other', key: null };
}

// ── Profile → answers ───────────────────────────────────────────────

export function loadProfile(path = resolve(ROOT, 'config', 'profile.yml')) {
  if (!existsSync(path)) throw new Error(`profile not found: ${path}`);
  return yaml.load(readFileSync(path, 'utf-8')) || {};
}

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return { first: parts[0] || '', last: parts.slice(1).join(' ') || '' };
}

/** Deterministic value for an identity field, or null when the profile lacks it. */
export function identityValue(key, profile) {
  const c = profile?.candidate ?? {};
  const { first, last } = splitName(c.full_name);
  switch (key) {
    case 'first_name': return first || null;
    case 'last_name': return last || null;
    case 'full_name': return c.full_name || null;
    case 'email': return c.email || null;
    case 'phone': return c.phone || null;
    case 'linkedin': return c.linkedin || null;
    case 'github': return c.github || null;
    case 'portfolio': return c.portfolio_url || null;
    case 'location': return c.location || null;
    case 'resume': return '<attach the tailored PDF from output/>';
    case 'cover_letter': return '<attach the tailored letter, if generated>';
    default: return null;
  }
}

/**
 * The honest answer to a knock-out question, plus whether it is likely to
 * disqualify. `blocking` never suppresses the answer — it decides how loudly
 * the summary reports it.
 */
export function knockoutAnswer(key, profile, field) {
  const e = profile?.eligibility ?? {};
  const comp = profile?.compensation ?? {};
  const c = profile?.candidate ?? {};
  // Canonical strings live in profile.yml (user layer) so a system update can
  // never rewrite the candidate's own answers. The fallbacks below only apply
  // to a profile written before `standard_answers` existed.
  const std = e.standard_answers ?? {};
  switch (key) {
    case 'work_authorization':
      return {
        answer: std.work_authorized_detail
          || (e.requires_sponsorship
            ? 'Yes — authorized to work in the US on F-1 STEM OPT (EAD).'
            : 'Yes — authorized to work without restriction.'),
        // NOT blocking. Being authorized is the good answer; flagging it as a
        // knock-out risk would bury the actual risks in noise.
        blocking: false,
        note: '',
      };
    case 'work_rights_ambiguous':
      return {
        answer: std.unrestricted_work_rights || '',
        blocking: false,
        note: '"Without restriction / unrestricted" is ambiguous on OPT — you '
          + 'are authorized, but the authorization is time-limited and tied to '
          + 'your field of study. Answer this one yourself based on what the '
          + 'employer means; auto-apply will not guess.',
      };
    case 'sponsorship':
      return {
        answer: e.requires_sponsorship
          ? (std.requires_sponsorship_detail
            || 'Yes — will require sponsorship (currently F-1 OPT/STEM OPT)')
          : 'No sponsorship required',
        blocking: Boolean(e.requires_sponsorship),
        note: e.requires_sponsorship
          ? 'Answer honestly. If the posting states no sponsorship, this is a real disqualifier — do not soften it.'
          : '',
      };
    case 'clearance':
      return {
        answer: e.cannot_obtain_security_clearance
          ? 'No — not eligible for a US security clearance'
          : 'See profile',
        blocking: Boolean(e.cannot_obtain_security_clearance),
        note: e.cannot_obtain_security_clearance
          ? 'Clearance/citizenship requirement is a hard disqualifier for this profile.'
          : '',
      };
    case 'experience_years': {
      const asked = Number(String(field?.label || '').match(/(\d+)\s*\+?\s*years/i)?.[1] ?? NaN);
      const have = Number(profile?.experience?.years ?? 0) || 0;
      const short = Number.isFinite(asked) && asked > Math.max(have, 2);
      return {
        answer: short ? `No — the posting asks for ${asked}+ years` : 'Answer from cv.md',
        blocking: short,
        note: short
          ? `Posting requires ${asked}+ years. This is an early-career profile — the scan filter should have caught this; treat as a signal the role is mis-targeted.`
          : '',
      };
    }
    case 'compensation':
      return { answer: comp.target_range || '', blocking: false, note: '' };
    case 'relocation':
      return { answer: comp.location_flexibility || e.geography || '', blocking: false, note: '' };
    case 'start_date':
      return { answer: c.start_date || '', blocking: false, note: '' };
    default:
      return { answer: '', blocking: false, note: '' };
  }
}

// ── Plan ────────────────────────────────────────────────────────────

/**
 * Build the fill plan: what is answered, what needs writing, what blocks.
 * Pure — takes an already-fetched form so it is testable offline.
 */
export function buildPlan(form, profile, meta = {}) {
  const filled = [];
  const needsWriting = [];
  const demographic = [];
  const blockers = [];
  const antibot = [];

  for (const field of form.fields) {
    const { kind, key } = classifyField(field);
    const base = { name: field.name, label: field.label, type: field.type, required: field.required };

    if (kind === 'antibot') {
      antibot.push({ ...base, reason: 'Form contains an explicit anti-bot / human-verification challenge' });
      continue;
    }
    if (kind === 'identity') {
      const value = identityValue(key, profile);
      if (value) filled.push({ ...base, value, source: `profile.candidate.${key}` });
      else needsWriting.push({ ...base, prompt: `No profile value for ${key}` });
      continue;
    }
    if (kind === 'knockout') {
      const { answer, blocking, note } = knockoutAnswer(key, profile, field);
      const row = { ...base, key, answer, note };
      if (blocking) blockers.push(row);
      // An empty answer means the profile deliberately declined to auto-answer
      // (work_rights_ambiguous) or has no value. Either way it goes to the
      // needs-your-words list carrying the explanation, never filled blank.
      if (answer) filled.push({ ...row, value: answer, source: `profile.eligibility.${key}` });
      else needsWriting.push({ ...base, key, prompt: note || 'Answer from cv.md' });
      continue;
    }
    if (kind === 'demographic') {
      demographic.push({ ...base, value: 'Decline to self-identify (candidate’s choice — leave blank or select the decline option)' });
      continue;
    }
    if (kind === 'freetext') {
      needsWriting.push({
        ...base,
        prompt: 'Draft from cv.md + the JD, then run the humanizing pass (see modes/apply.md).',
      });
      continue;
    }
    // Everything else: options are enumerable, so show them rather than guess.
    if (field.options.length > 0) {
      needsWriting.push({ ...base, prompt: 'Pick one', options: field.options.map(o => o.label) });
    } else if (field.required) {
      needsWriting.push({ ...base, prompt: 'Required — answer from cv.md' });
    }
  }

  return {
    ...meta,
    role: form.title,
    totals: {
      fields: form.fields.length,
      autofilled: filled.length,
      needsWriting: needsWriting.length,
      demographic: demographic.length,
      blockers: blockers.length,
      antibot: antibot.length,
    },
    blockers,
    antibot,
    filled,
    needsWriting,
    demographic,
    submitted: false,
    reviewRequired: true,
  };
}

// ── Rendering ───────────────────────────────────────────────────────

function renderPlan(plan) {
  const L = [];
  L.push(`\n${'═'.repeat(66)}`);
  L.push(`  ${plan.company ?? plan.org ?? ''} — ${plan.role}`);
  L.push(`  ${plan.ats.toUpperCase()} · ${plan.url}`);
  L.push('═'.repeat(66));

  const t = plan.totals;
  L.push(`\n${t.fields} fields · ${t.autofilled} auto-filled · ${t.needsWriting} need your words`);

  if (plan.antibot.length > 0) {
    L.push(`\n🛑 BLOCKED — anti-bot challenge on this form:`);
    for (const f of plan.antibot) L.push(`   • ${f.label.slice(0, 100)}`);
    L.push(`   This one is addressed to you, not to tooling. Solve it yourself in the browser.`);
  }

  if (plan.blockers.length > 0) {
    L.push(`\n⚠️  KNOCK-OUT RISK — answer honestly, then decide whether to apply:`);
    for (const f of plan.blockers) {
      L.push(`   • ${f.label}`);
      L.push(`     → ${f.answer}`);
      if (f.note) L.push(`     ${f.note}`);
    }
  }

  L.push(`\n✅ Auto-filled from config/profile.yml:`);
  for (const f of plan.filled) {
    L.push(`   ${String(f.label).slice(0, 44).padEnd(46)} ${String(f.value).slice(0, 52)}`);
  }

  if (plan.needsWriting.length > 0) {
    L.push(`\n✍️  Needs your words (draft these, then humanize):`);
    for (const f of plan.needsWriting) {
      L.push(`   • ${f.label}${f.required ? '  [required]' : ''}`);
      if (f.options) L.push(`     options: ${f.options.slice(0, 8).join(' | ')}`);
      else if (f.prompt) L.push(`     ${f.prompt}`);
    }
  }

  if (plan.demographic.length > 0) {
    L.push(`\n🔵 Voluntary self-identification (${plan.demographic.length}) — your call, defaults to declining.`);
  }

  L.push(`\n${'─'.repeat(66)}`);
  L.push(`NOT SUBMITTED. This tool has no submit path. Review everything above,`);
  L.push(`then apply in the browser yourself.`);
  L.push('─'.repeat(66));
  return L.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { url: '', json: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--url') args.url = argv[++i] ?? '';
    else if (a.startsWith('--url=')) args.url = a.slice(6);
    else if (a === '--out') args.out = argv[++i] ?? '';
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (!a.startsWith('--') && !args.url) args.url = a;
  }
  return args;
}

export async function fetchForm(target) {
  if (target.ats === 'greenhouse') return fetchGreenhouseForm(target);
  if (target.ats === 'ashby') return fetchAshbyForm(target);
  throw new Error(`Unsupported ATS: ${target.ats}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('Usage: node auto-apply.mjs --url <greenhouse-or-ashby-posting-url> [--json] [--out FILE]');
    process.exit(2);
  }
  const target = detectAts(args.url);
  if (!target) {
    console.error(`Not a recognized Greenhouse or Ashby posting URL:\n  ${args.url}`);
    console.error('Supported: job-boards.greenhouse.io/{org}/jobs/{id} · jobs.ashbyhq.com/{org}/{uuid}');
    process.exit(2);
  }

  const profile = loadProfile();
  const form = await fetchForm(target);
  const plan = buildPlan(form, profile, {
    url: args.url,
    ats: target.ats,
    org: target.org,
    company: target.org,
    jobId: target.jobId,
    generatedAt: new Date().toISOString(),
  });

  if (args.out) {
    mkdirSync(dirname(resolve(args.out)), { recursive: true });
    writeFileSync(resolve(args.out), JSON.stringify(plan, null, 2));
  }
  if (args.json) console.log(JSON.stringify(plan, null, 2));
  else console.log(renderPlan(plan));

  // Exit 3 signals "prepared, but something needs a decision before applying".
  process.exit(plan.blockers.length > 0 || plan.antibot.length > 0 ? 3 : 0);
}

// ── Self-test ───────────────────────────────────────────────────────

function runSelfTest() {
  let failures = 0;
  const ok = (label, cond) => {
    console.log(`${cond ? '✓' : '✗'} ${label}`);
    if (!cond) failures += 1;
  };

  // detectAts
  ok('greenhouse job-boards url parses',
    JSON.stringify(detectAts('https://job-boards.greenhouse.io/acme/jobs/4567')) ===
    JSON.stringify({ ats: 'greenhouse', org: 'acme', jobId: '4567' }));
  ok('greenhouse boards url parses',
    detectAts('https://boards.greenhouse.io/acme/jobs/99')?.jobId === '99');
  ok('ashby url parses',
    JSON.stringify(detectAts('https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245')) ===
    JSON.stringify({ ats: 'ashby', org: 'ramp', jobId: '34413f8d-26bf-4bbc-8ade-eb309a0e2245' }));
  ok('lever is not supported here', detectAts('https://jobs.lever.co/acme/abc') === null);
  ok('http is rejected', detectAts('http://job-boards.greenhouse.io/acme/jobs/1') === null);
  ok('garbage is rejected', detectAts('not a url') === null);
  ok('a lookalike host is rejected',
    detectAts('https://greenhouse.io.evil.com/acme/jobs/1') === null);

  // normalizeGreenhouse
  const gh = normalizeGreenhouse({
    title: 'SWE',
    questions: [
      { label: 'First Name', required: true, fields: [{ name: 'first_name', type: 'input_text', values: [] }] },
      { label: 'Why us?', required: false, fields: [{ name: 'q1', type: 'textarea', values: [] }] },
      {
        label: 'Sponsorship?', required: true,
        fields: [{ name: 'q2', type: 'multi_value_single_select', values: [{ label: 'Yes', value: 1 }, { label: 'No', value: 0 }] }],
      },
    ],
  });
  ok('greenhouse normalizes 3 fields', gh.fields.length === 3);
  ok('textarea maps to longtext', gh.fields[1].type === 'longtext');
  ok('select options are carried', gh.fields[2].options.length === 2);

  // normalizeAshby
  const ash = normalizeAshby({
    title: 'Security Engineer',
    applicationForm: {
      sections: [{
        title: null,
        fieldEntries: [
          { isRequired: true, field: { path: 'name', type: 'String', title: 'Legal Name' } },
          { isRequired: true, field: { path: 'q', type: 'LongText', title: 'Figure out the correct secret and submit it' } },
        ],
      }],
    },
  });
  ok('ashby normalizes 2 fields', ash.fields.length === 2);
  ok('ashby String maps to text', ash.fields[0].type === 'text');

  // classifyField
  ok('first name is identity', classifyField({ label: 'First Name', description: '', type: 'text' }).key === 'first_name');
  ok('last name is identity', classifyField({ label: 'Last Name', description: '', type: 'text' }).key === 'last_name');
  ok('"Legal Name" is a FULL name, not a first name',
    classifyField({ label: 'Legal Name', description: '', type: 'text' }).key === 'full_name');
  ok('email is identity', classifyField({ label: 'Email', description: '', type: 'text' }).key === 'email');
  ok('sponsorship is a knockout',
    classifyField({ label: 'Will you require visa sponsorship?', description: '', type: 'select' }).key === 'sponsorship');

  // ── Authorization vs sponsorship: two questions, two different answers ──
  // These are separated because answering an authorization question with a
  // sponsorship answer reads as "not authorized" to an automated screen.
  ok('"legally authorized to work" is AUTHORIZATION, not sponsorship',
    classifyField({ label: 'Are you legally authorized to work in the United States?', description: '', type: 'select' }).key === 'work_authorization');
  ok('"eligible to work" is authorization',
    classifyField({ label: 'Are you eligible to work in the US?', description: '', type: 'select' }).key === 'work_authorization');
  ok('"right to work" is authorization',
    classifyField({ label: 'Do you have the right to work in the US?', description: '', type: 'select' }).key === 'work_authorization');
  ok('"without restriction" routes to the ambiguous bucket, not authorization',
    classifyField({ label: 'Do you have the right to work in the US without restriction?', description: '', type: 'select' }).key === 'work_rights_ambiguous');
  ok('the combined now-or-in-future question is still sponsorship',
    classifyField({ label: 'Will you now or in the future require employment visa sponsorship?', description: '', type: 'select' }).key === 'sponsorship');
  ok('clearance is a knockout',
    classifyField({ label: 'Do you hold an active TS/SCI clearance?', description: '', type: 'select' }).key === 'clearance');
  ok('a years floor is a knockout',
    classifyField({ label: 'Do you have a minimum of 7 years of experience?', description: '', type: 'boolean' }).key === 'experience_years');
  ok('an anti-bot challenge is detected',
    classifyField({ label: 'Figure out the correct secret and submit it below', description: '', type: 'longtext' }).kind === 'antibot');
  ok('the not-a-bot phrasing is detected',
    classifyField({ label: 'prove you are not a bot auto-applying', description: '', type: 'longtext' }).kind === 'antibot');
  ok('anti-bot beats freetext',
    classifyField({ label: 'decode the following and submit the secret', description: '', type: 'longtext' }).kind === 'antibot');
  ok('a plain essay is freetext',
    classifyField({ label: 'Why do you want to work here?', description: '', type: 'longtext' }).kind === 'freetext');
  ok('demographics are their own bucket',
    classifyField({ label: 'Veteran status', description: '', type: 'select' }).kind === 'demographic');

  // identityValue
  const profile = {
    candidate: {
      full_name: 'Abhi Ramtel', email: 'a@b.com', phone: '+1 555',
      linkedin: 'https://li/x', github: 'https://gh/x', portfolio_url: 'https://p', location: 'Buffalo, NY',
      start_date: '2026-07-21',
    },
    eligibility: { requires_sponsorship: true, cannot_obtain_security_clearance: true },
    compensation: { target_range: '$100K-160K' },
  };
  ok('first name splits', identityValue('first_name', profile) === 'Abhi');
  ok('last name splits', identityValue('last_name', profile) === 'Ramtel');
  ok('a missing field is null', identityValue('twitter', profile) === null);

  // knockoutAnswer
  const spon = knockoutAnswer('sponsorship', profile, {});
  ok('sponsorship answers honestly and blocks', spon.blocking === true && /require sponsorship/i.test(spon.answer));
  const auth = knockoutAnswer('work_authorization', profile, {});
  ok('work authorization answers YES', /^yes/i.test(auth.answer));
  ok('work authorization does NOT mention needing sponsorship',
    !/require.*sponsorship/i.test(auth.answer));
  ok('work authorization is not treated as a blocker', auth.blocking === false);
  const amb = knockoutAnswer('work_rights_ambiguous', profile, {});
  ok('the ambiguous phrasing is not auto-answered', amb.answer === '');
  ok('the ambiguous phrasing explains itself', /ambiguous/i.test(amb.note));

  // profile.yml overrides win over the built-in fallbacks
  const custom = {
    ...profile,
    eligibility: {
      ...profile.eligibility,
      standard_answers: { work_authorized_detail: 'CUSTOM AUTH', requires_sponsorship_detail: 'CUSTOM SPON' },
    },
  };
  ok('profile.yml standard_answers override the auth fallback',
    knockoutAnswer('work_authorization', custom, {}).answer === 'CUSTOM AUTH');
  ok('profile.yml standard_answers override the sponsorship fallback',
    knockoutAnswer('sponsorship', custom, {}).answer === 'CUSTOM SPON');
  const clr = knockoutAnswer('clearance', profile, {});
  ok('clearance answers honestly and blocks', clr.blocking === true && /not eligible/i.test(clr.answer));
  const yrs = knockoutAnswer('experience_years', profile, { label: 'minimum of 7 years' });
  ok('a 7-year floor blocks an early-career profile', yrs.blocking === true);
  const yrs2 = knockoutAnswer('experience_years', profile, { label: 'minimum of 1 years' });
  ok('a 1-year floor does not block', yrs2.blocking === false);

  // buildPlan
  const plan = buildPlan(
    {
      title: 'SWE',
      fields: [
        { name: 'first_name', label: 'First Name', description: '', type: 'text', required: true, options: [] },
        { name: 'email', label: 'Email', description: '', type: 'text', required: true, options: [] },
        { name: 'spon', label: 'Will you require visa sponsorship?', description: '', type: 'select', required: true, options: [] },
        { name: 'why', label: 'Why this company?', description: '', type: 'longtext', required: true, options: [] },
        { name: 'bot', label: 'Figure out the secret and submit it', description: '', type: 'longtext', required: true, options: [] },
        { name: 'vet', label: 'Veteran status', description: '', type: 'select', required: false, options: [] },
      ],
    },
    profile,
    { url: 'https://x', ats: 'greenhouse', org: 'acme' },
  );
  ok('identity fields are auto-filled', plan.filled.some(f => f.value === 'Abhi'));
  ok('the essay needs writing', plan.needsWriting.some(f => f.name === 'why'));
  ok('sponsorship is flagged as a blocker', plan.blockers.length === 1);
  ok('the anti-bot field is quarantined', plan.antibot.length === 1);
  ok('the anti-bot field is NOT auto-filled', !plan.filled.some(f => f.name === 'bot'));
  ok('demographics are separated', plan.demographic.length === 1);
  ok('the plan records that nothing was submitted', plan.submitted === false && plan.reviewRequired === true);

  console.log(failures === 0 ? '\nAll auto-apply tests passed.' : `\n${failures} test(s) failed.`);
  return failures === 0 ? 0 : 1;
}

const isDirect = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirect) {
  if (process.argv.includes('--self-test')) {
    process.exit(runSelfTest());
  } else {
    main().catch((err) => {
      console.error(`auto-apply: ${err.message}`);
      process.exit(1);
    });
  }
}
