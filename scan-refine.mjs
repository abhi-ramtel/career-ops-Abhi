/**
 * scan-refine.mjs — post-filter refinement for scan.mjs.
 *
 * The filter chain in scan.mjs decides on the data a provider's LIST endpoint
 * happens to ship. That is enough for title/location, and not enough for the
 * two things that actually matter to an early-career candidate:
 *
 *   1. Most list APIs ship no job description, so `classifyExperienceLevel`
 *      sees a bare title and returns band `unknown`. Since `unknown` is never
 *      dropped (correctly — it means "no evidence", not "wrong level"), a
 *      plain "Software Engineer" whose JD asks for 8+ years sails through.
 *   2. A posting can be dead by the time it is written to pipeline.md.
 *
 * Both are fixable only by touching the per-posting endpoint, which is far too
 * expensive to do for every hit off the list API. So it happens HERE instead:
 * after every cheap filter has run, on the small surviving set.
 *
 * Order matters and is deliberate:
 *
 *   enrich → reband → cap → liveness
 *
 * Enrichment first, because banding is what the JD text is for. Cap next, so
 * the (expensive) liveness pass only pays for postings that will actually be
 * written. Liveness last for the same reason.
 *
 * Zero LLM tokens throughout — plain HTTP against the same ATS APIs the
 * scanner already talks to.
 */

import { classifyExperienceLevel } from './experience-level.mjs';
import { resolveAtsApi, checkLivenessViaApi } from './liveness-api.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 8;
const USER_AGENT = 'career-ops-scan-refine/1.0 (+https://github.com/santifer/career-ops)';

/** A description shorter than this carries no usable years signal. */
const MIN_USEFUL_DESCRIPTION = 200;

// ── Concurrency ─────────────────────────────────────────────────────
// A worker pool rather than Promise.all over chunks: one slow endpoint stalls
// only its own worker instead of a whole batch. Results are written back by
// index so the caller's order survives regardless of completion order.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  return out;
}

// ── Description extraction ──────────────────────────────────────────

/** Strip HTML to plain text — JD bodies arrive as escaped HTML on most ATSs. */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return '';
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Pull the description body out of an ATS API payload.
 *
 * Each ATS names the field differently and Ashby's endpoint is org-level (it
 * returns every posting on the board), so the posting has to be found by id
 * before its body can be read.
 *
 * @param {string} ats  provider id from resolveAtsApi
 * @param {any} json    parsed API response
 * @param {Record<string,string>} parts  url segments from resolveAtsApi
 * @returns {string} plain text, '' when the shape is unrecognized
 */
export function extractDescription(ats, json, parts = {}) {
  if (!json || typeof json !== 'object') return '';
  switch (ats) {
    case 'greenhouse':
      return htmlToText(json.content ?? '');
    case 'lever': {
      // Lever ships a pre-rendered plain-text body; prefer it over the HTML.
      if (typeof json.descriptionPlain === 'string' && json.descriptionPlain) {
        const lists = Array.isArray(json.lists)
          ? json.lists.map(l => `${l?.text ?? ''}\n${htmlToText(l?.content ?? '')}`).join('\n')
          : '';
        return `${json.descriptionPlain}\n${lists}`.trim();
      }
      return htmlToText(json.description ?? '');
    }
    case 'ashby': {
      const jobs = Array.isArray(json.jobs) ? json.jobs : [];
      const target = String(parts.id ?? '').toLowerCase();
      const job = target
        ? jobs.find(j => typeof j?.id === 'string' && j.id.toLowerCase() === target)
        : null;
      if (!job) return '';
      return typeof job.descriptionPlain === 'string' && job.descriptionPlain
        ? job.descriptionPlain
        : htmlToText(job.descriptionHtml ?? '');
    }
    case 'workday': {
      const info = json.jobPostingInfo ?? json;
      return htmlToText(info?.jobDescription ?? '');
    }
    default:
      return '';
  }
}

/** Fetch one posting's description. Returns '' on any failure — never throws. */
async function fetchDescription(url, timeoutMs) {
  const resolved = resolveAtsApi(url);
  if (!resolved) return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(resolved.apiUrl, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      redirect: 'error', // SSRF guard, same posture as liveness-api.mjs
      signal: controller.signal,
    });
    if (res.status !== 200) return '';
    const json = await res.json();
    return extractDescription(resolved.ats, json, resolved.parts);
  } catch {
    return ''; // network / timeout / bad JSON → no evidence, caller keeps `unknown`
  } finally {
    clearTimeout(timer);
  }
}

/** True when this offer needs a JD fetch to be banded honestly. */
export function needsEnrichment(offer) {
  if (!offer || typeof offer.url !== 'string') return false;
  const band = offer.experienceBand;
  // Only `unknown` is worth paying for. A posting already banded from its title
  // or an existing description has its answer; re-fetching cannot improve it.
  if (band !== 'unknown' && band !== undefined) return false;
  const desc = typeof offer.description === 'string' ? offer.description : '';
  if (desc.length >= MIN_USEFUL_DESCRIPTION) return false;
  return resolveAtsApi(offer.url) !== null;
}

/**
 * Fetch descriptions for the offers that need one, re-band them, and drop the
 * ones the JD reveals as out of range.
 *
 * @returns {Promise<{ kept: any[], dropped: any[], fetched: number, reclassified: number }>}
 */
export async function enrichAndReband(offers, {
  maxYears = 2,
  dropBands = ['mid', 'senior'],
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onProgress = null,
} = {}) {
  const drop = new Set(
    (Array.isArray(dropBands) ? dropBands : [])
      .filter(b => typeof b === 'string')
      .map(b => b.trim().toLowerCase())
      // `unknown` stays undroppable here for the same reason as in scan.mjs: a
      // fetch that failed must not be read as evidence against the posting.
      .filter(b => b !== 'unknown'),
  );

  const targets = offers.filter(needsEnrichment);
  let done = 0;
  const descriptions = await mapPool(targets, concurrency, async (offer) => {
    const text = await fetchDescription(offer.url, timeoutMs);
    done += 1;
    if (onProgress && (done % 25 === 0 || done === targets.length)) {
      onProgress(done, targets.length);
    }
    return text;
  });

  const enriched = new Map();
  targets.forEach((offer, i) => {
    if (descriptions[i]) enriched.set(offer, descriptions[i]);
  });

  const kept = [];
  const dropped = [];
  let reclassified = 0;

  for (const offer of offers) {
    const fresh = enriched.get(offer);
    if (!fresh) {
      kept.push(offer);
      continue;
    }
    offer.description = fresh;
    const banded = classifyExperienceLevel({
      title: offer.title ?? '',
      description: fresh,
      maxYears,
    });
    if (banded.band !== offer.experienceBand) reclassified += 1;
    offer.experienceBand = banded.band;
    offer.experienceYears = banded.years;
    offer.experienceSignals = banded.signals;
    if (drop.has(banded.band)) {
      offer.dropReason = `experience:${banded.band}`;
      dropped.push(offer);
    } else {
      kept.push(offer);
    }
  }

  return { kept, dropped, fetched: enriched.size, reclassified };
}

// ── Per-company cap ─────────────────────────────────────────────────

/**
 * Cap how many postings any one company contributes to a single scan.
 *
 * Without this, a company with a large public board (Amazon ships thousands of
 * SDE reqs) crowds out every other employer in the run — the pipeline ends up
 * technically full and practically useless. Input order decides which ones
 * survive, so callers should sort by fit BEFORE calling this.
 *
 * @returns {{ kept: any[], dropped: any[], cappedCompanies: string[] }}
 */
export function capPerCompany(offers, cap, keyOf = (o) => String(o?.company ?? '').trim().toLowerCase()) {
  const limit = Number(cap);
  if (!Number.isInteger(limit) || limit <= 0) {
    return { kept: offers, dropped: [], cappedCompanies: [] };
  }
  const counts = new Map();
  const kept = [];
  const dropped = [];
  const capped = new Set();
  for (const offer of offers) {
    const key = keyOf(offer) || '(unknown)';
    const n = counts.get(key) ?? 0;
    if (n >= limit) {
      offer.dropReason = 'company-cap';
      dropped.push(offer);
      capped.add(String(offer?.company ?? '').trim() || '(unknown)');
      continue;
    }
    counts.set(key, n + 1);
    kept.push(offer);
  }
  return { kept, dropped, cappedCompanies: [...capped] };
}

// ── Liveness ────────────────────────────────────────────────────────

/**
 * Drop postings whose ATS API says they are gone.
 *
 * `checkLivenessViaApi` returns null for anything it cannot settle (unknown
 * ATS, 429, timeout). Null is treated as ALIVE: a scanner that dropped every
 * inconclusive posting would quietly delete most of its own results the first
 * time an ATS rate-limited it. Only an explicit `expired` verdict removes a row.
 *
 * @returns {Promise<{ kept: any[], dropped: any[], checked: number }>}
 */
export async function verifyLiveness(offers, {
  concurrency = DEFAULT_CONCURRENCY,
  onProgress = null,
} = {}) {
  const checkable = offers.filter(o => typeof o?.url === 'string' && resolveAtsApi(o.url));
  let done = 0;
  const verdicts = await mapPool(checkable, concurrency, async (offer) => {
    const verdict = await checkLivenessViaApi(offer.url);
    done += 1;
    if (onProgress && (done % 25 === 0 || done === checkable.length)) {
      onProgress(done, checkable.length);
    }
    return verdict;
  });

  const dead = new Set();
  checkable.forEach((offer, i) => {
    const v = verdicts[i];
    if (v && v.result === 'expired') {
      offer.dropReason = `liveness:${v.code}`;
      offer.livenessReason = v.reason;
      dead.add(offer);
    } else if (v && v.result === 'active') {
      offer.livenessVerified = true;
    }
  });

  const kept = offers.filter(o => !dead.has(o));
  return { kept, dropped: [...dead], checked: checkable.length };
}

// ── Orchestration ───────────────────────────────────────────────────

/**
 * Run the whole refinement chain. Every stage is individually opt-out so a
 * scan with `refine:` absent from portals.yml behaves exactly as before.
 *
 * `resort` is applied between rebanding and capping. Enrichment changes bands,
 * and the cap keeps whatever comes first — so without re-sorting, the cap would
 * be spending a company's slots on the ordering that existed before the JDs
 * were read. The caller owns the comparator so scan.mjs's sponsor and
 * seniority-boost tiebreakers are not silently replaced by a band-only sort.
 *
 * @param {any[]} offers
 * @param {object} config  the `refine` block from portals.yml
 * @param {{ log?: Function, resort?: (offers: any[]) => any[] }} hooks
 * @returns {Promise<{ offers: any[], stats: object, dropped: object }>}
 */
export async function refineOffers(offers, config = {}, { log = () => {}, resort = null } = {}) {
  const stats = {
    input: offers.length,
    enrichFetched: 0,
    enrichReclassified: 0,
    droppedExperience: 0,
    droppedCap: 0,
    droppedDead: 0,
    livenessChecked: 0,
    cappedCompanies: [],
  };
  const dropped = { experience: [], cap: [], dead: [] };
  let current = offers;

  if (config.enrich_descriptions !== false && current.length > 0) {
    log(`🔎 Fetching job descriptions to confirm experience level…`);
    const r = await enrichAndReband(current, {
      maxYears: config.max_years ?? 2,
      dropBands: config.drop_bands ?? ['mid', 'senior'],
      concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
      onProgress: (d, t) => log(`   …${d}/${t} descriptions fetched`),
    });
    current = r.kept;
    dropped.experience = r.dropped;
    stats.enrichFetched = r.fetched;
    stats.enrichReclassified = r.reclassified;
    stats.droppedExperience = r.dropped.length;
  }

  if (resort && current.length > 1) current = resort(current);

  if (config.max_per_company && current.length > 0) {
    const r = capPerCompany(current, config.max_per_company);
    current = r.kept;
    dropped.cap = r.dropped;
    stats.droppedCap = r.dropped.length;
    stats.cappedCompanies = r.cappedCompanies;
  }

  if (config.verify_liveness !== false && current.length > 0) {
    log(`🩺 Verifying postings are still live…`);
    const r = await verifyLiveness(current, {
      concurrency: config.concurrency ?? DEFAULT_CONCURRENCY,
      onProgress: (d, t) => log(`   …${d}/${t} postings checked`),
    });
    current = r.kept;
    dropped.dead = r.dropped;
    stats.droppedDead = r.dropped.length;
    stats.livenessChecked = r.checked;
  }

  stats.output = current.length;
  return { offers: current, stats, dropped };
}

export default refineOffers;

// ── Self-test ───────────────────────────────────────────────────────
const isDirect = process.argv[1]
  && import.meta.url === `file://${process.argv[1]}`;

if (isDirect && process.argv.includes('--self-test')) {
  let failures = 0;
  const ok = (label, cond) => {
    console.log(`${cond ? '✓' : '✗'} ${label}`);
    if (!cond) failures += 1;
  };

  // htmlToText
  ok('htmlToText strips tags and decodes entities',
    htmlToText('<p>5+ years&nbsp;of <b>Go</b></p>') === '5+ years of Go');
  ok('htmlToText drops script bodies',
    !htmlToText('<script>evil()</script><p>hi</p>').includes('evil'));
  ok('htmlToText on a non-string is empty', htmlToText(null) === '');

  // extractDescription
  ok('greenhouse content is read',
    extractDescription('greenhouse', { content: '<p>8+ years</p>' }).includes('8+ years'));
  ok('lever prefers descriptionPlain',
    extractDescription('lever', { descriptionPlain: 'plain body', description: '<p>html</p>' })
      .startsWith('plain body'));
  ok('ashby finds the posting by id',
    extractDescription('ashby',
      { jobs: [{ id: 'ABC', descriptionPlain: 'the body' }] },
      { id: 'abc' }) === 'the body');
  ok('ashby returns empty when the id is absent',
    extractDescription('ashby', { jobs: [{ id: 'ZZZ' }] }, { id: 'abc' }) === '');
  ok('an unknown ats yields empty', extractDescription('bamboo', { content: 'x' }) === '');

  // needsEnrichment
  ok('an unknown band with no description needs enrichment',
    needsEnrichment({ url: 'https://job-boards.greenhouse.io/acme/jobs/123', experienceBand: 'unknown' }));
  ok('an early band does not need enrichment',
    !needsEnrichment({ url: 'https://job-boards.greenhouse.io/acme/jobs/123', experienceBand: 'early' }));
  ok('a long description does not need enrichment',
    !needsEnrichment({
      url: 'https://job-boards.greenhouse.io/acme/jobs/123',
      experienceBand: 'unknown',
      description: 'x'.repeat(500),
    }));
  ok('a non-ATS url cannot be enriched',
    !needsEnrichment({ url: 'https://example.com/careers/1', experienceBand: 'unknown' }));

  // capPerCompany
  const many = [
    { company: 'Amazon', title: 'a' }, { company: 'Amazon', title: 'b' },
    { company: 'Amazon', title: 'c' }, { company: 'Stripe', title: 'd' },
  ];
  const capped = capPerCompany(many, 2);
  ok('the cap keeps at most N per company', capped.kept.length === 3);
  ok('the cap drops the overflow', capped.dropped.length === 1);
  ok('the cap keeps input order (best-first survives)',
    capped.kept[0].title === 'a' && capped.kept[1].title === 'b');
  ok('the cap names the capped company', capped.cappedCompanies.includes('Amazon'));
  ok('the cap is case-insensitive',
    capPerCompany([{ company: 'Amazon' }, { company: 'AMAZON' }], 1).kept.length === 1);
  ok('a cap of 0 is a no-op', capPerCompany(many, 0).kept.length === 4);
  ok('an absent cap is a no-op', capPerCompany(many, undefined).kept.length === 4);

  // enrichAndReband — offline path (no ATS urls, so nothing is fetched)
  (async () => {
    const offline = [
      { url: 'https://example.com/1', title: 'Software Engineer', experienceBand: 'unknown' },
    ];
    const r = await enrichAndReband(offline, {});
    ok('nothing fetchable means nothing dropped', r.kept.length === 1 && r.fetched === 0);

    const refined = await refineOffers(
      [{ url: 'https://example.com/1', title: 'SWE', company: 'X', experienceBand: 'unknown' }],
      { max_per_company: 5 },
    );
    ok('refineOffers passes through un-fetchable offers', refined.offers.length === 1);
    ok('refineOffers reports its input and output', refined.stats.input === 1 && refined.stats.output === 1);

    console.log(failures === 0 ? '\nAll scan-refine tests passed.' : `\n${failures} test(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })();
}
