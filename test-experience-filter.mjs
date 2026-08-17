#!/usr/bin/env node

/**
 * test-experience-filter.mjs — scan.mjs's experience_filter wiring
 *
 * experience-level.mjs has its own `--self-test` for the parsing and banding
 * rules. This suite covers the part that lives in scan.mjs: the config
 * contract, the ordering, and the pipeline-row annotation — specifically the
 * invariants that make the feature safe to leave switched off:
 *
 *   - absent/disabled config changes nothing at all
 *   - 'unknown' is never droppable (most providers ship no description, so
 *     dropping "no evidence" would discard the bulk of a scan)
 *   - an unbanded offer serializes byte-identically to before the feature
 *
 * Run: node test-experience-filter.mjs
 */

import { buildExperienceFilter, formatPipelineOffer } from './scan.mjs';
import { compareEarlyCareerFit } from './experience-level.mjs';

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
};

const job = (title, description = '') => ({ title, description });

console.log('\n━━━ buildExperienceFilter — off by default ━━━');
{
  ok('absent config → disabled', buildExperienceFilter(undefined).enabled === false);
  ok('null config → disabled', buildExperienceFilter(null).enabled === false);
  ok('enabled:false → disabled', buildExperienceFilter({ enabled: false }).enabled === false);
  ok('disabled filter drops nothing', buildExperienceFilter(undefined).shouldDrop({ band: 'senior' }) === false);
  ok('{enabled:true} → enabled', buildExperienceFilter({ enabled: true }).enabled === true);
  ok('default max_years is 2', buildExperienceFilter({ enabled: true }).maxYears === 2);
  ok('max_years honoured', buildExperienceFilter({ enabled: true, max_years: 5 }).maxYears === 5);
  ok('malformed max_years falls back to 2', buildExperienceFilter({ enabled: true, max_years: 'lots' }).maxYears === 2);
  ok('annotate defaults on', buildExperienceFilter({ enabled: true }).annotate === true);
  ok('annotate:false honoured', buildExperienceFilter({ enabled: true, annotate: false }).annotate === false);
}

console.log('\n━━━ drop_bands — opt-in, and never "unknown" ━━━');
{
  const f = buildExperienceFilter({ enabled: true, drop_bands: ['senior'] });
  ok('drops a listed band', f.shouldDrop({ band: 'senior' }) === true);
  ok('keeps an unlisted band', f.shouldDrop({ band: 'early' }) === false);
  ok('no drop_bands → drops nothing', buildExperienceFilter({ enabled: true }).shouldDrop({ band: 'senior' }) === false);

  const u = buildExperienceFilter({ enabled: true, drop_bands: ['unknown', 'senior'] });
  ok('"unknown" is ignored even when explicitly listed', u.shouldDrop({ band: 'unknown' }) === false);
  ok('...while the rest of the list still applies', u.shouldDrop({ band: 'senior' }) === true);

  const c = buildExperienceFilter({ enabled: true, drop_bands: ['SENIOR', ' Mid '] });
  ok('band names are case/whitespace-insensitive', c.shouldDrop({ band: 'senior' }) && c.shouldDrop({ band: 'mid' }));
  ok('null banding never drops', c.shouldDrop(null) === false);
}

console.log('\n━━━ classify — reads title AND description ━━━');
{
  const f = buildExperienceFilter({ enabled: true });
  ok('"New Grad SWE" → early', f.classify(job('New Grad Software Engineer')).band === 'early');
  ok('plain title + "0-2 years" → early', f.classify(job('Software Engineer', 'You have 0-2 years of experience')).band === 'early');
  ok('plain title + "8+ years" → senior', f.classify(job('Software Engineer', 'Requires 8+ years')).band === 'senior');
  ok('plain title, no description → unknown', f.classify(job('Software Engineer')).band === 'unknown');
  ok('missing description field is safe', f.classify({ title: 'Software Engineer' }).band === 'unknown');
  ok('non-string description is safe', f.classify({ title: 'Software Engineer I', description: 42 }).band === 'early');

  const wide = buildExperienceFilter({ enabled: true, max_years: 5 });
  ok('max_years:5 makes "4+ years" early', wide.classify(job('Software Engineer', 'Requires 4+ years')).band === 'early');
}

console.log('\n━━━ ordering — early first, stable within a band ━━━');
{
  const offers = [
    { title: 'Senior Software Engineer', experienceBand: 'senior' },
    { title: 'Software Engineer', experienceBand: 'unknown' },
    { title: 'New Grad Software Engineer', experienceBand: 'early' },
    { title: 'Software Engineer II', experienceBand: 'mid' },
    { title: 'Software Engineer I', experienceBand: 'early' },
  ];
  const sorted = [...offers].sort((a, b) =>
    compareEarlyCareerFit({ band: a.experienceBand }, { band: b.experienceBand }));
  ok('early band sorts to the front',
    sorted[0].experienceBand === 'early' && sorted[1].experienceBand === 'early');
  ok('within a band, discovery order is preserved (stable sort)',
    sorted[0].title === 'New Grad Software Engineer' && sorted[1].title === 'Software Engineer I');
  ok('unknown outranks mid and senior',
    sorted[2].experienceBand === 'unknown' && sorted[3].experienceBand === 'mid' && sorted[4].experienceBand === 'senior');
}

console.log('\n━━━ pipeline annotation — labeled, and absent when unbanded ━━━');
{
  const base = { url: 'https://example.com/jobs/1', company: 'Acme', title: 'Software Engineer I' };

  const plain = formatPipelineOffer({ ...base });
  ok('unbanded offer emits no level: segment', !plain.includes('level:'));
  ok('unbanded offer keeps the 3-column shape',
    plain === '- [ ] https://example.com/jobs/1 | Acme | Software Engineer I');

  const banded = formatPipelineOffer({ ...base, experienceBand: 'early' });
  ok('banded offer emits a labeled level: segment', banded.includes('| level: early'));

  const withYears = formatPipelineOffer({
    ...base, experienceBand: 'early', experienceYears: { min: 0, max: 2 },
  });
  ok('stated years ride along', withYears.includes('level: early 0-2y'));

  const openEnded = formatPipelineOffer({
    ...base, experienceBand: 'mid', experienceYears: { min: 4, max: null },
  });
  ok('open-ended floor renders as N-+y', openEnded.includes('level: mid 4-+y'));

  const noYears = formatPipelineOffer({
    ...base, experienceBand: 'unknown', experienceYears: { min: null, max: null },
  });
  ok('no stated years → band only', noYears.includes('| level: unknown') && !noYears.includes('unknown 0'));

  // The row is positional up to column 5; every later signal must be labeled.
  const full = formatPipelineOffer({
    ...base, location: 'Chicago, IL', postedAt: Date.UTC(2026, 7, 1),
    experienceBand: 'early', note: 'referral',
  });
  ok('level: coexists with location, posted: and note:',
    full.includes('| Chicago, IL') && full.includes('| posted: 2026-08-01')
    && full.includes('| level: early') && full.includes('| note: referral'));
  ok('level: is emitted before note:', full.indexOf('level:') < full.indexOf('note:'));

  const injected = formatPipelineOffer({ ...base, experienceBand: 'early\n- [ ] https://evil.test' });
  ok('band text is sanitized like every other field', !injected.includes('\n- [ ]'));
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(50));
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
}
console.log('\n✅ All tests passed!');
