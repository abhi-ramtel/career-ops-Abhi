#!/usr/bin/env node

/**
 * test-sponsorship-companies.mjs — Fortune 500 / sponsorship company metadata
 *
 * Covers the seam between the shipped dataset and the EXISTING company system:
 * the dataset is an input to discover-ats.mjs, which writes portals.yml
 * entries, which validate-portals.mjs then has to accept.
 *
 * The invariant that matters most is the honesty one: company-level history is
 * a ranking signal and must never be expressible as a promise about a posting.
 * That is why `status: guaranteed` is a hard schema error rather than a warning.
 *
 * Run: node test-sponsorship-companies.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { parseCompanyInput, renderPortalEntry, withCompanyMeta, yamlScalar } from './discover-ats.mjs';
import { validatePortalsConfig } from './validate-portals.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATASET = join(ROOT, 'templates', 'companies', 'fortune500-sponsors.yml');

let passed = 0;
let failed = 0;
const ok = (name, cond) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
};

const PROVIDERS = new Set(['greenhouse', 'ashby', 'lever', 'workday', 'bamboohr']);
// validatePortalsConfig is async — it loads the provider registry.
const validate = (cfg) => validatePortalsConfig(cfg, { providerIds: PROVIDERS });

console.log('\n━━━ Shipped dataset is well-formed ━━━');
const raw = readFileSync(DATASET, 'utf-8');
const doc = yaml.load(raw);
{
  ok('parses as YAML with a companies: list', Array.isArray(doc?.companies));
  ok('has a meaningful number of companies', doc.companies.length >= 20);
  ok('every entry has a name', doc.companies.every(c => typeof c.name === 'string' && c.name.trim()));
  ok('every entry records sponsorship evidence', doc.companies.every(c => c.sponsorship?.evidence));
  ok('no entry claims a guaranteed status',
    doc.companies.every(c => !/guarantee/i.test(String(c.sponsorship?.status ?? ''))));
  ok('every status is from the allowed set',
    doc.companies.every(c => ['likely', 'historical', 'unknown'].includes(String(c.sponsorship?.status))));
  ok('last_verified is quoted so it stays a string, not a Date',
    doc.companies.every(c => typeof c.sponsorship?.last_verified === 'string'));
  ok('company names are unique',
    new Set(doc.companies.map(c => c.name.toLowerCase())).size === doc.companies.length);
  // Clearance-gated defense primes would be filtered per-posting anyway; they
  // are excluded from the seed so scan budget is not spent rediscovering that.
  const defense = ['lockheed', 'northrop', 'raytheon', 'booz allen', 'leidos', 'general dynamics'];
  ok('clearance-gated defense primes are excluded from the seed list',
    !doc.companies.some(c => defense.some(d => c.name.toLowerCase().includes(d))));
}

console.log('\n━━━ discover-ats.mjs carries the metadata through ━━━');
{
  const { companies, warnings } = parseCompanyInput(raw);
  ok('parses with no warnings', warnings.length === 0);
  ok('parses every dataset row', companies.length === doc.companies.length);

  const ms = companies.find(c => c.name === 'Microsoft');
  ok('fortune500 flag survives parsing', ms?.fortune500 === true);
  ok('sponsorship object survives parsing', ms?.sponsorship?.status === 'likely');

  ok('a bare-name company gains no metadata',
    parseCompanyInput('companies:\n  - Acme\n').companies[0].fortune500 === undefined);

  const bad = parseCompanyInput('companies:\n  - name: Acme\n    sponsorship: "yes"\n');
  ok('a non-object sponsorship is warned about, not silently kept',
    bad.companies[0].sponsorship === undefined && bad.warnings.some(w => /sponsorship/.test(w)));

  ok('withCompanyMeta is a no-op without metadata',
    withCompanyMeta({ name: 'A' }, { name: 'A' }).fortune500 === undefined);
  ok('withCompanyMeta copies metadata onto the result',
    withCompanyMeta({ name: 'A' }, { name: 'A', fortune500: true }).fortune500 === true);
  ok('withCompanyMeta tolerates a missing company', withCompanyMeta({ name: 'A' }, null).name === 'A');
}

console.log('\n━━━ Rendered portals.yml entries are valid config ━━━');
{
  const entry = renderPortalEntry({
    name: 'Microsoft',
    careers_url: 'https://boards.greenhouse.io/microsoft',
    provider: 'greenhouse',
    fortune500: true,
    sponsorship: {
      status: 'likely',
      visa_types: ['H-1B', 'green card'],
      evidence: 'USCIS Employer Data Hub',
      last_verified: '2026-08-17',
    },
  });
  ok('emits fortune500', entry.includes('fortune500: true'));
  ok('emits sponsorship.status', entry.includes('status: likely'));
  ok('emits visa_types as a flow list', entry.includes('visa_types: [H-1B, green card]'));
  ok('emits last_verified', entry.includes('last_verified: "2026-08-17"'));

  const parsed = yaml.load(`tracked_companies:\n${entry}`);
  const c = parsed.tracked_companies[0];
  ok('round-trips through YAML', c.name === 'Microsoft' && c.fortune500 === true);
  ok('last_verified round-trips as a string, not a Date', typeof c.sponsorship.last_verified === 'string');

  const { errors } = await validate(parsed);
  ok('validate-portals accepts the rendered entry', errors.length === 0);

  // A Date leaking in (unquoted YAML date) must not corrupt the field.
  ok('yamlScalar normalizes a Date to an ISO calendar date',
    yamlScalar(new Date('2026-08-17T00:00:00Z')) === '"2026-08-17"');
}

console.log('\n━━━ Schema rejects dishonest or malformed sponsorship ━━━');
{
  const withSponsor = (sponsorship, extra = {}) => ({
    tracked_companies: [{ name: 'Acme', careers_url: 'https://jobs.lever.co/acme', sponsorship, ...extra }],
  });

  const errPaths = async (cfg) => (await validate(cfg)).errors.map(e => e.path).join(' ');
  const warnMsgs = async (cfg) => (await validate(cfg)).warnings.map(w => w.message).join(' ');
  const errCount = async (cfg) => (await validate(cfg)).errors.length;

  ok('"guaranteed" status is a hard error',
    /status/.test(await errPaths(withSponsor({ status: 'guaranteed' }))));
  ok('an unknown status is an error',
    /status/.test(await errPaths(withSponsor({ status: 'definitely' }))));
  ok('a string sponsorship is an error',
    /sponsorship/.test(await errPaths(withSponsor('yes'))));
  ok('a non-string evidence is an error',
    /evidence/.test(await errPaths(withSponsor({ status: 'likely', evidence: 42 }))));
  ok('a malformed last_verified is an error',
    /last_verified/.test(await errPaths(withSponsor({ status: 'likely', evidence: 'x', last_verified: 'last tuesday' }))));
  ok('last_verified without evidence warns',
    /evidence/.test(await warnMsgs(withSponsor({ status: 'likely', last_verified: '2026-08-17' }))));
  ok('a non-boolean fortune500 is an error',
    /fortune500/.test(await errPaths(withSponsor({ status: 'likely' }, { fortune500: 'yes' }))));

  ok('a valid sponsorship block passes clean',
    (await errCount(withSponsor({
      status: 'historical', visa_types: ['H-1B'], evidence: 'DOL LCA', last_verified: '2026-08-17',
    }))) === 0);
  ok('companies with no sponsorship block still pass',
    (await errCount({ tracked_companies: [{ name: 'Acme', careers_url: 'https://jobs.lever.co/acme' }] })) === 0);
}

console.log(`\n${'═'.repeat(50)}`);
console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
console.log('═'.repeat(50));
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
}
console.log('\n✅ All tests passed!');
