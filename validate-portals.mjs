#!/usr/bin/env node

/**
 * validate-portals.mjs — schema/shape validator for portals.yml.
 *
 * Usage:
 *   node validate-portals.mjs
 *   node validate-portals.mjs --file templates/portals.example.yml
 *   node validate-portals.mjs --self-test
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROVIDERS_DIR = join(ROOT, 'providers');
const DEFAULT_PORTALS_PATH = process.env.CAREER_OPS_PORTALS || 'portals.yml';

function add(list, path, message) {
  list.push({ path, message });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function validateUrl(value, path, errors) {
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string') {
    add(errors, path, 'must be a string URL');
    return;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    add(errors, path, `invalid URL: ${value}`);
    return;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    add(errors, path, `unsupported URL protocol: ${parsed.protocol}`);
  }
}

function validateKeywordList(value, path, errors) {
  if (value === undefined || value === null) return;
  const arr = Array.isArray(value) ? value : [value];
  for (const [idx, item] of arr.entries()) {
    if (typeof item !== 'string') {
      add(errors, `${path}[${idx}]`, 'keyword must be a string');
      continue;
    }
    if (item.trim() === '') {
      add(errors, `${path}[${idx}]`, 'keyword must not be empty');
    }
  }
}

function validateParser(parser, path, errors) {
  if (parser === undefined || parser === null) return;
  if (!isObject(parser)) {
    add(errors, path, 'parser must be an object');
    return;
  }
  if (typeof parser.command !== 'string' || parser.command.trim() === '') {
    add(errors, `${path}.command`, 'parser.command must be a non-empty string');
  }
  if (parser.script !== undefined && (typeof parser.script !== 'string' || parser.script.trim() === '')) {
    add(errors, `${path}.script`, 'parser.script must be a non-empty string when set');
  }
  if (parser.args !== undefined && !Array.isArray(parser.args)) {
    add(errors, `${path}.args`, 'parser.args must be an array when set');
  }
  if (parser.timeout_ms !== undefined && (!Number.isFinite(Number(parser.timeout_ms)) || Number(parser.timeout_ms) <= 0)) {
    add(errors, `${path}.timeout_ms`, 'parser.timeout_ms must be a positive number when set');
  }
  if (parser.max_buffer_bytes !== undefined && (!Number.isFinite(Number(parser.max_buffer_bytes)) || Number(parser.max_buffer_bytes) <= 0)) {
    add(errors, `${path}.max_buffer_bytes`, 'parser.max_buffer_bytes must be a positive number when set');
  }
}

async function loadProviderIds() {
  const ids = new Set();
  if (existsSync(PROVIDERS_DIR)) {
    const files = readdirSync(PROVIDERS_DIR)
      .filter(f => f.endsWith('.mjs') && !f.startsWith('_'))
      .sort();
    for (const file of files) {
      const mod = await import(pathToFileURL(join(PROVIDERS_DIR, file)).href);
      if (mod.default?.id) ids.add(mod.default.id);
    }
  }

  // scan.mjs accepts explicit provider-plugin ids even when a plugin is
  // disabled or missing credentials (the runtime installs an actionable
  // inactive-provider stub). Keep validation aligned with that contract.
  try {
    const { discoverPlugins, pluginRoots, resolveSuccessorIds } = await import('./plugins/_engine.mjs');
    const manifests = discoverPlugins(pluginRoots(ROOT), resolveSuccessorIds(ROOT));
    for (const manifest of manifests) {
      if (manifest.hooks.includes('provider')) ids.add(manifest.id);
    }
  } catch (err) {
    // A stripped-down checkout may not include plugin infrastructure. Core
    // provider validation should continue to work in that environment.
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  return ids;
}

export async function validatePortalsConfig(config, { providerIds = new Set() } = {}) {
  const errors = [];
  const warnings = [];

  if (!isObject(config)) {
    add(errors, '<root>', 'portals config must be a YAML object');
    return { errors, warnings };
  }

  if (config.title_filter !== undefined) {
    if (!isObject(config.title_filter)) {
      add(errors, 'title_filter', 'title_filter must be an object');
    } else {
      validateKeywordList(config.title_filter.positive, 'title_filter.positive', errors);
      validateKeywordList(config.title_filter.negative, 'title_filter.negative', errors);
      validateKeywordList(config.title_filter.seniority_boost, 'title_filter.seniority_boost', errors);
    }
  }

  if (config.location_filter !== undefined) {
    if (!isObject(config.location_filter)) {
      add(errors, 'location_filter', 'location_filter must be an object');
    } else {
      validateKeywordList(config.location_filter.always_allow, 'location_filter.always_allow', errors);
      validateKeywordList(config.location_filter.allow, 'location_filter.allow', errors);
      validateKeywordList(config.location_filter.block, 'location_filter.block', errors);
    }
  }

  if (config.freshness_filter !== undefined) {
    if (!isObject(config.freshness_filter)) {
      add(errors, 'freshness_filter', 'freshness_filter must be an object');
    } else {
      const maxAge = config.freshness_filter.max_age_days;
      if (maxAge !== undefined && (!Number.isFinite(Number(maxAge)) || Number(maxAge) <= 0)) {
        add(errors, 'freshness_filter.max_age_days', 'max_age_days must be a positive number when set');
      }
      if (config.freshness_filter.drop_undated !== undefined && typeof config.freshness_filter.drop_undated !== 'boolean') {
        add(errors, 'freshness_filter.drop_undated', 'drop_undated must be a boolean when set');
      }
    }
  }

  if (config.content_filter !== undefined) {
    if (!isObject(config.content_filter)) {
      add(errors, 'content_filter', 'content_filter must be an object');
    } else {
      validateKeywordList(config.content_filter.positive, 'content_filter.positive', errors);
      validateKeywordList(config.content_filter.negative, 'content_filter.negative', errors);
      if (config.content_filter.by_title_keyword !== undefined) {
        if (!isObject(config.content_filter.by_title_keyword)) {
          add(errors, 'content_filter.by_title_keyword', 'by_title_keyword must be an object keyed by title_filter.positive keyword');
        } else {
          const titlePositive = new Set(
            (Array.isArray(config.title_filter?.positive) ? config.title_filter.positive : [])
              .filter(k => typeof k === 'string')
              .map(k => k.trim().toLowerCase())
          );
          for (const [kw, rule] of Object.entries(config.content_filter.by_title_keyword)) {
            const path = `content_filter.by_title_keyword.${kw}`;
            if (!titlePositive.has(kw.trim().toLowerCase())) {
              add(warnings, path, `"${kw}" does not match any title_filter.positive keyword and will never apply`);
            }
            if (!isObject(rule)) {
              add(errors, path, 'must be an object with positive/negative keyword lists');
              continue;
            }
            validateKeywordList(rule.positive, `${path}.positive`, errors);
            validateKeywordList(rule.negative, `${path}.negative`, errors);
          }
        }
      }
    }
  }

  if (config.experience_filter !== undefined) {
    if (!isObject(config.experience_filter)) {
      add(errors, 'experience_filter', 'experience_filter must be an object');
    } else {
      const ef = config.experience_filter;
      if (ef.enabled !== undefined && typeof ef.enabled !== 'boolean') {
        add(errors, 'experience_filter.enabled', 'must be a boolean when set');
      }
      if (ef.annotate !== undefined && typeof ef.annotate !== 'boolean') {
        add(errors, 'experience_filter.annotate', 'must be a boolean when set');
      }
      if (ef.max_years !== undefined
        && (!Number.isFinite(Number(ef.max_years)) || Number(ef.max_years) < 0)) {
        add(errors, 'experience_filter.max_years', 'max_years must be a non-negative number when set');
      }
      if (ef.drop_bands !== undefined) {
        if (!Array.isArray(ef.drop_bands)) {
          add(errors, 'experience_filter.drop_bands', 'drop_bands must be an array when set');
        } else {
          const known = new Set(['intern', 'early', 'mid', 'senior', 'unknown']);
          for (const band of ef.drop_bands) {
            if (typeof band !== 'string' || !known.has(band.trim().toLowerCase())) {
              add(errors, 'experience_filter.drop_bands', `unknown band ${JSON.stringify(band)} — use intern/early/mid/senior`);
            } else if (band.trim().toLowerCase() === 'unknown') {
              // Accepted by the schema but ignored at runtime, so warn rather
              // than fail: most providers ship no description, so 'unknown' is
              // "no evidence", and dropping it would discard most of a scan.
              add(warnings, 'experience_filter.drop_bands', "'unknown' is ignored — it means 'no description evidence', not 'wrong level'");
            }
          }
        }
      }
    }
  }

  if (config.visa_filter !== undefined) {
    if (!isObject(config.visa_filter)) {
      add(errors, 'visa_filter', 'visa_filter must be an object');
    } else {
      if (config.visa_filter.enabled !== undefined && typeof config.visa_filter.enabled !== 'boolean') {
        add(errors, 'visa_filter.enabled', 'must be a boolean when set');
      }
      if (config.visa_filter.require_mention !== undefined && typeof config.visa_filter.require_mention !== 'boolean') {
        add(errors, 'visa_filter.require_mention', 'must be a boolean when set');
      }
      validateKeywordList(config.visa_filter.positive, 'visa_filter.positive', errors);
      validateKeywordList(config.visa_filter.negative, 'visa_filter.negative', errors);
    }
  }

  if (config.search_queries !== undefined && !Array.isArray(config.search_queries)) {
    add(errors, 'search_queries', 'search_queries must be an array when set');
  }

  const companies = config.tracked_companies;
  if (companies !== undefined && !Array.isArray(companies)) {
    add(errors, 'tracked_companies', 'tracked_companies must be an array when set');
  }

  const seenEnabledNames = new Map();
  if (Array.isArray(companies)) {
    for (const [idx, company] of companies.entries()) {
      const base = `tracked_companies[${idx}]`;
      if (!isObject(company)) {
        add(errors, base, 'company entry must be an object');
        continue;
      }
      if (company.enabled === false) continue;

      if (typeof company.name !== 'string' || company.name.trim() === '') {
        add(errors, `${base}.name`, 'enabled company must have a non-empty string name');
      } else {
        const normalized = normalizeName(company.name);
        if (seenEnabledNames.has(normalized)) {
          add(warnings, `${base}.name`, `duplicate enabled company name also seen at ${seenEnabledNames.get(normalized)}`);
        } else {
          seenEnabledNames.set(normalized, `${base}.name`);
        }
      }

      validateUrl(company.careers_url, `${base}.careers_url`, errors);
      validateUrl(company.api, `${base}.api`, errors);

      if (company.provider !== undefined) {
        if (typeof company.provider !== 'string' || company.provider.trim() === '') {
          add(errors, `${base}.provider`, 'provider must be a non-empty string when set');
        } else if (!providerIds.has(company.provider)) {
          add(errors, `${base}.provider`, `unknown provider "${company.provider}"`);
        }
      }

      validateParser(company.parser, `${base}.parser`, errors);

      if (company.fortune500 !== undefined && typeof company.fortune500 !== 'boolean') {
        add(errors, `${base}.fortune500`, 'fortune500 must be a boolean when set');
      }

      // Company-level visa HISTORY. Ranking input only — never a claim that a
      // given posting sponsors, which the per-job filters decide. "guaranteed"
      // is rejected outright rather than warned about: the whole contract of
      // this field is that it cannot promise anything about an individual req.
      if (company.sponsorship !== undefined) {
        if (!isObject(company.sponsorship)) {
          add(errors, `${base}.sponsorship`, 'sponsorship must be an object with status/visa_types/evidence');
        } else {
          const s = company.sponsorship;
          const allowed = new Set(['likely', 'historical', 'unknown']);
          if (s.status !== undefined) {
            if (typeof s.status !== 'string' || !allowed.has(s.status.trim().toLowerCase())) {
              add(errors, `${base}.sponsorship.status`, `status must be one of likely/historical/unknown (got ${JSON.stringify(s.status)})`);
            }
          }
          if (s.visa_types !== undefined) {
            validateKeywordList(s.visa_types, `${base}.sponsorship.visa_types`, errors);
          }
          if (s.evidence !== undefined && typeof s.evidence !== 'string') {
            add(errors, `${base}.sponsorship.evidence`, 'evidence must be a string when set');
          }
          if (s.last_verified !== undefined) {
            const raw = s.last_verified instanceof Date
              ? s.last_verified.toISOString().slice(0, 10)
              : String(s.last_verified);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
              add(errors, `${base}.sponsorship.last_verified`, 'last_verified must be a YYYY-MM-DD date when set');
            } else if (!s.evidence) {
              add(warnings, `${base}.sponsorship`, 'last_verified is set but evidence is empty — an unsourced date is not verification');
            }
          }
        }
      }
    }
  }

  return { errors, warnings };
}

function formatIssue(issue) {
  return `${issue.path}: ${issue.message}`;
}

async function validateFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`file not found: ${filePath}`);
  }
  const providerIds = await loadProviderIds();
  const parsed = yaml.load(readFileSync(filePath, 'utf-8'));
  return validatePortalsConfig(parsed, { providerIds });
}

async function runSelfTest() {
  const tmp = mkdtempSync(join(tmpdir(), 'career-ops-validate-portals-self-test-'));
  try {
    const file = join(tmp, 'bad.yml');
    writeFileSync(file, `
title_filter:
  positive: ["AI", ""]
tracked_companies:
  - name: "Acme"
    provider: "not-real"
    careers_url: "https://jobs.lever.co/acme"
`, 'utf-8');
    const result = await validateFile(file);
    if (result.errors.length !== 2) {
      throw new Error(`expected 2 errors, got ${result.errors.length}`);
    }
    console.log('validate-portals self-test OK');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    await runSelfTest();
    return;
  }

  // An explicit but empty `--file=` must reach the usage error below. Passing
  // '' to resolve() would return the CURRENT DIRECTORY, and the script would
  // then try to validate a directory and report a filesystem error instead.
  const fileFlag = hasFlag(args, '--file') ? (flagValue(args, '--file') ?? '') : undefined;
  const filePath = fileFlag === undefined ? resolve(DEFAULT_PORTALS_PATH) : (fileFlag ? resolve(fileFlag) : '');
  if (!filePath) {
    console.error('Usage: node validate-portals.mjs [--file portals.yml] [--self-test]');
    process.exit(1);
  }

  let result;
  try {
    result = await validateFile(filePath);
  } catch (err) {
    console.error(`validate-portals failed: ${err.message}`);
    process.exit(1);
  }

  console.log(`validate-portals: ${filePath}`);
  for (const warning of result.warnings) console.log(`warning: ${formatIssue(warning)}`);
  for (const error of result.errors) console.log(`error: ${formatIssue(error)}`);
  console.log(`${result.errors.length} errors, ${result.warnings.length} warnings`);

  if (result.errors.length > 0) process.exit(1);
}

// Run the CLI only when invoked directly. Without this guard, `import
// { validatePortalsConfig } from './validate-portals.mjs'` also RAN main(),
// which resolves portals.yml and calls process.exit(1) when it is missing —
// killing the importing process. Locally that went unnoticed because
// portals.yml exists (main() just printed a stray summary line); in CI, where
// portals.yml is a gitignored user-layer file, any test importing this module
// died instantly. Every other executable module here already guards this way.
const isDirect = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  main().catch((err) => {
    console.error(`validate-portals failed: ${err.message}`);
    process.exit(1);
  });
}
