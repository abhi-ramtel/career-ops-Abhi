#!/usr/bin/env node
// @ts-check
/**
 * Test suite for the freshness filter (scan.mjs).
 * Run: node test-freshness-filter.mjs
 *
 * Tests cover buildFreshnessFilter: window boundaries, undated handling
 * (conservative pass vs. strict drop_undated), clock-skew, and validation.
 *
 * A fixed `now` is injected so the window math is deterministic regardless of
 * when the suite runs.
 */

import { buildFreshnessFilter } from './scan.mjs';

// ── Test runner ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${testName}`);
  }
}

function section(name) {
  console.log(`\n━━━ ${name} ━━━`);
}

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-18T00:00:00Z'); // fixed clock for deterministic windows
const daysAgo = (n) => NOW - n * DAY;

// ══════════════════════════════════════════════════════════════════════
// PART 1: disabled / no-op cases
// ══════════════════════════════════════════════════════════════════════

section('buildFreshnessFilter — disabled / no-op cases');

{
  const filter = buildFreshnessFilter(null, { now: NOW });
  assert(filter(daysAgo(9999)) === true, 'null config → pass all (even very old)');
}

{
  const filter = buildFreshnessFilter(undefined, { now: NOW });
  assert(filter(daysAgo(9999)) === true, 'undefined config → pass all');
}

{
  // Silence the expected validation warning for these cases.
  const originalError = console.error;
  let warnings = [];
  console.error = (msg) => warnings.push(msg);

  const noMax = buildFreshnessFilter({}, { now: NOW });
  assert(noMax(daysAgo(9999)) === true, 'missing max_age_days → disabled, pass all');
  assert(warnings.length > 0, 'missing max_age_days → warning logged');

  warnings = [];
  const zero = buildFreshnessFilter({ max_age_days: 0 }, { now: NOW });
  assert(zero(daysAgo(9999)) === true, 'max_age_days=0 → disabled, pass all');
  assert(warnings.length > 0, 'max_age_days=0 → warning logged');

  warnings = [];
  const negative = buildFreshnessFilter({ max_age_days: -14 }, { now: NOW });
  assert(negative(daysAgo(9999)) === true, 'negative max_age_days → disabled, pass all');
  assert(warnings.length > 0, 'negative max_age_days → warning logged');

  warnings = [];
  const garbage = buildFreshnessFilter({ max_age_days: 'soon' }, { now: NOW });
  assert(garbage(daysAgo(9999)) === true, 'non-numeric max_age_days → disabled, pass all');
  assert(warnings.length > 0, 'non-numeric max_age_days → warning logged');

  console.error = originalError;
}

// ══════════════════════════════════════════════════════════════════════
// PART 2: window boundaries (14-day window)
// ══════════════════════════════════════════════════════════════════════

section('buildFreshnessFilter — 14-day window boundaries');

{
  const filter = buildFreshnessFilter({ max_age_days: 14 }, { now: NOW });

  assert(filter(NOW) === true, 'posted right now → pass');
  assert(filter(daysAgo(1)) === true, 'posted 1 day ago → pass');
  assert(filter(daysAgo(13)) === true, 'posted 13 days ago → pass');
  assert(filter(daysAgo(14)) === true, 'posted exactly 14 days ago → pass (inclusive)');
  assert(filter(daysAgo(15)) === false, 'posted 15 days ago → reject');
  assert(filter(daysAgo(30)) === false, 'posted 30 days ago → reject');
  assert(filter(daysAgo(365)) === false, 'posted a year ago → reject');
}

section('buildFreshnessFilter — string-numeric max_age_days (YAML coercion)');

{
  const filter = buildFreshnessFilter({ max_age_days: '14' }, { now: NOW });
  assert(filter(daysAgo(10)) === true, 'string "14": 10 days ago → pass');
  assert(filter(daysAgo(20)) === false, 'string "14": 20 days ago → reject');
}

// ══════════════════════════════════════════════════════════════════════
// PART 3: undated postings (conservative pass vs. strict drop)
// ══════════════════════════════════════════════════════════════════════

section('buildFreshnessFilter — undated postings (default: conservative pass)');

{
  const filter = buildFreshnessFilter({ max_age_days: 14 }, { now: NOW });

  assert(filter(undefined) === true, 'postedAt undefined → pass (conservative)');
  assert(filter(null) === true, 'postedAt null → pass (conservative)');
  assert(filter(NaN) === true, 'postedAt NaN → pass (conservative)');
  assert(filter('not-a-date') === true, 'postedAt unparseable string → pass (conservative)');
}

section('buildFreshnessFilter — undated postings (drop_undated: true)');

{
  const filter = buildFreshnessFilter({ max_age_days: 14, drop_undated: true }, { now: NOW });

  assert(filter(undefined) === false, 'drop_undated: postedAt undefined → reject');
  assert(filter(null) === false, 'drop_undated: postedAt null → reject');
  assert(filter(NaN) === false, 'drop_undated: postedAt NaN → reject');
  assert(filter('not-a-date') === false, 'drop_undated: unparseable → reject');

  // Dated postings still obey the window when drop_undated is on.
  assert(filter(daysAgo(5)) === true, 'drop_undated: fresh dated posting → still pass');
  assert(filter(daysAgo(20)) === false, 'drop_undated: stale dated posting → still reject');
}

section('buildFreshnessFilter — drop_undated only triggers on strict boolean true');

{
  // Any non-`true` value keeps the conservative default (mirrors `=== true` guard).
  const truthyString = buildFreshnessFilter({ max_age_days: 14, drop_undated: 'yes' }, { now: NOW });
  assert(truthyString(undefined) === true, 'drop_undated: "yes" (not boolean true) → conservative pass');

  const explicitFalse = buildFreshnessFilter({ max_age_days: 14, drop_undated: false }, { now: NOW });
  assert(explicitFalse(undefined) === true, 'drop_undated: false → conservative pass');
}

// ══════════════════════════════════════════════════════════════════════
// PART 4: clock skew (future-dated postings)
// ══════════════════════════════════════════════════════════════════════

section('buildFreshnessFilter — future-dated postings (clock skew)');

{
  const filter = buildFreshnessFilter({ max_age_days: 14 }, { now: NOW });

  assert(filter(NOW + DAY) === true, 'posted 1 day in the future → pass (skew tolerated)');
  assert(filter(NOW + 100 * DAY) === true, 'posted far in the future → pass');
}

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log(`\n✅ All ${passed} tests passed!`);
}
