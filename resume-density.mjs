#!/usr/bin/env node

/**
 * resume-density.mjs — one-page fill measurement for tailored CVs
 *
 * PORTED FROM: mcp-overleaf-server (src/core/pipeline.ts `measureDensity`).
 * Adapted to career-ops' pipeline rather than copied: the source measures a
 * TailoredContent JSON object against a parsed MasterCv, and this measures the
 * rendered CV HTML that `modes/pdf.md` produces against `cv.md`. The rules and
 * the thresholds are the source's; the parsing is career-ops'.
 *
 * WHY IT EXISTS
 *
 * generate-pdf.mjs already enforces a page CEILING (`--max-pages`, and
 * `--fit-pages` to shrink into it). Nothing measured the FLOOR. That asymmetry
 * is what produces the classic bad one-pager: technically one page, but with a
 * blank lower third, because the tailoring dropped roles and bullets to be
 * safe. A résumé that fits by being half-empty has thrown away the evidence it
 * was supposed to present.
 *
 * The rule this encodes, from the source project:
 *
 *   FILL THE PAGE NATURALLY — target four experience entries and three
 *   projects with up to three sourced bullets each (~21 bullets), and only
 *   trim once an actual render reports overflow. Never shrink the type or
 *   margins to buy room, and never drop a role merely because it is not the
 *   single best match.
 *
 * Targets are always capped by what cv.md can actually support: a candidate
 * with two roles is not "thin" for having two. Everything is measured against
 * the master, never against a fixed ideal.
 *
 * Usage:
 *   node resume-density.mjs <rendered-cv.html> [cv.md]
 *   node resume-density.mjs --self-test
 */

import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/** Target counts — a one-page CV should be full, not half empty. */
export const TARGET_BULLETS_PER_ROLE = 3;
export const TARGET_BULLETS_PER_PROJECT = 3;
export const TARGET_EXPERIENCE_ENTRIES = 4;
export const TARGET_PROJECT_ENTRIES = 3;

/**
 * Parse cv.md into the master entries a tailored CV can draw from.
 *
 * Recognizes the shape cv.md actually uses:
 *   ## Experience
 *   **Role** - Company, Location
 *   Mon YYYY - Mon YYYY
 *   - bullet
 *
 * Only `## Experience` and `## Projects` are read; Education/Skills carry no
 * bullets to measure.
 */
export function parseMasterCv(markdown) {
  const out = { experience: [], projects: [] };
  if (typeof markdown !== 'string' || markdown.trim() === '') return out;

  const lines = markdown.split(/\r?\n/);
  let section = null;
  let current = null;

  const flush = () => {
    if (current && section) out[section].push(current);
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      const name = heading[1].toLowerCase();
      if (/experience/.test(name)) section = 'experience';
      else if (/project/.test(name)) section = 'projects';
      else section = null;
      continue;
    }
    if (!section) continue;

    // An entry header is a line that STARTS with bold text. Markdown links
    // inside the bold (project names are links in cv.md) are kept as the name.
    const entry = line.match(/^\*\*(.+?)\*\*/);
    if (entry) {
      flush();
      current = { name: entry[1].replace(/^\[(.+?)\]\(.*\)$/, '$1').trim(), bullets: [] };
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.*\S)/);
    if (bullet && current) current.bullets.push(bullet[1].trim());
  }
  flush();
  return out;
}

/**
 * Count what the rendered CV HTML actually contains.
 *
 * Structure comes from templates/sections/{experience,projects}.html:
 * `div.job` per role with `<li>` bullets, `div.project` per project. Counts
 * are derived from the markup rather than from any intermediate JSON so the
 * measurement reflects what will really be printed.
 */
export function measureRenderedHtml(html) {
  const empty = { experienceEntries: 0, projectEntries: 0, totalBullets: 0, entries: [] };
  if (typeof html !== 'string' || html.trim() === '') return empty;

  const entries = [];
  let totalBullets = 0;

  // Slice each block at its opening tag and count <li> until the next block
  // of either kind starts. Regex rather than a DOM parse keeps this dependency
  // -free and is sufficient for markup this project itself generates.
  const blockRe = /<div class="(job|project)"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = blockRe.exec(html)) !== null) starts.push({ kind: m[1], at: m.index });

  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].at : html.length;
    const chunk = html.slice(start.at, end);
    const bullets = (chunk.match(/<li\b/g) || []).length;
    const nameMatch = chunk.match(/class="(?:job-company|project-title)"[^>]*>([\s\S]*?)</);
    const name = nameMatch ? nameMatch[1].replace(/<[^>]*>/g, '').trim() : `${start.kind} ${i + 1}`;
    totalBullets += bullets;
    entries.push({ kind: start.kind, name, bullets });
  });

  return {
    experienceEntries: entries.filter(e => e.kind === 'job').length,
    projectEntries: entries.filter(e => e.kind === 'project').length,
    totalBullets,
    entries,
  };
}

/** Sum of the top `entries` bullet counts, each capped at `perEntry`. */
function targetBulletTotal(counts, entries, perEntry) {
  return counts
    .map(c => Math.min(perEntry, c))
    .sort((a, b) => b - a)
    .slice(0, entries)
    .reduce((t, c) => t + c, 0);
}

/**
 * Measure a rendered CV against what cv.md can support.
 *
 * `underFilled` is true when the render carries fewer bullets than the master
 * could have supplied, or when any selected entry is thinner than its source
 * allows. Both halves matter: a CV can hit the bullet total while still
 * leaving one role with a single lonely bullet.
 */
export function measureDensity(rendered, master) {
  const thinEntries = [];
  const masterExp = Array.isArray(master?.experience) ? master.experience : [];
  const masterProj = Array.isArray(master?.projects) ? master.projects : [];

  const targetExperienceEntries = Math.min(TARGET_EXPERIENCE_ENTRIES, masterExp.length);
  const targetProjectEntries = Math.min(TARGET_PROJECT_ENTRIES, masterProj.length);

  const targetTotalBullets =
    targetBulletTotal(masterExp.map(e => e.bullets.length), targetExperienceEntries, TARGET_BULLETS_PER_ROLE) +
    targetBulletTotal(masterProj.map(e => e.bullets.length), targetProjectEntries, TARGET_BULLETS_PER_PROJECT);

  if (rendered.experienceEntries < targetExperienceEntries) {
    thinEntries.push(`Experience section (${rendered.experienceEntries}/${targetExperienceEntries} role entries)`);
  }
  if (rendered.projectEntries < targetProjectEntries) {
    thinEntries.push(`Projects section (${rendered.projectEntries}/${targetProjectEntries} project entries)`);
  }

  const byName = new Map([...masterExp, ...masterProj].map(e => [e.name.toLowerCase(), e]));
  for (const entry of rendered.entries) {
    const perEntryCap = entry.kind === 'job' ? TARGET_BULLETS_PER_ROLE : TARGET_BULLETS_PER_PROJECT;
    const source = byName.get(entry.name.toLowerCase());
    // With no matching source entry, fall back to the cap rather than
    // assuming the worst — a tailored rename should not read as thin.
    const target = Math.min(perEntryCap, source?.bullets.length ?? perEntryCap);
    if (entry.bullets < target) {
      thinEntries.push(`${entry.name} (${entry.bullets}/${target} bullets)`);
    }
  }

  return {
    experienceEntries: rendered.experienceEntries,
    projectEntries: rendered.projectEntries,
    totalBullets: rendered.totalBullets,
    targetExperienceEntries,
    targetProjectEntries,
    targetTotalBullets,
    targetBulletsPerRole: TARGET_BULLETS_PER_ROLE,
    targetBulletsPerProject: TARGET_BULLETS_PER_PROJECT,
    thinEntries,
    underFilled: rendered.totalBullets < targetTotalBullets || thinEntries.length > 0,
  };
}

/** Human-readable warning, or '' when the page is adequately filled. */
export function formatDensityWarning(density) {
  if (!density?.underFilled) return '';
  const head = `⚠️  PAGE IS UNDER-FILLED — ${density.totalBullets} bullets across `
    + `${density.experienceEntries} roles and ${density.projectEntries} projects `
    + `(target ~${density.targetTotalBullets} across ${density.targetExperienceEntries} roles `
    + `and ${density.targetProjectEntries} projects).`;
  const thin = density.thinEntries.length
    ? `\n   Thin: ${density.thinEntries.slice(0, 8).join('; ')}`
    : '';
  return `${head}${thin}\n   Add sourced detail from cv.md — do NOT shrink type or margins to fill the page.`;
}

export default measureDensity;

// ── CLI / self-test ─────────────────────────────────────────────────
const isDirect = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirect) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    runSelfTest();
  } else if (args.length > 0) {
    const htmlPath = args[0];
    const cvPath = args[1] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'cv.md');
    if (!existsSync(htmlPath)) { console.error(`not found: ${htmlPath}`); process.exit(1); }
    const master = parseMasterCv(existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '');
    const density = measureDensity(measureRenderedHtml(readFileSync(htmlPath, 'utf-8')), master);
    console.log(JSON.stringify(density, null, 2));
    const warn = formatDensityWarning(density);
    if (warn) { console.error(`\n${warn}`); process.exit(1); }
    console.log('\n✅ Page is adequately filled.');
  } else {
    console.log('Usage:');
    console.log('  node resume-density.mjs <rendered-cv.html> [cv.md]');
    console.log('  node resume-density.mjs --self-test');
  }
}

function runSelfTest() {
  let passed = 0, failed = 0;
  const ok = (n, c) => c ? (passed++, console.log(`  ✓ ${n}`)) : (failed++, console.error(`  ✗ ${n}`));

  const MASTER_MD = `
# Someone

## Experience

**Engineer A** - Acme, Chicago, IL
Jan 2025 - Present
- a1
- a2
- a3
- a4

**Engineer B** - Beta, NY
2024
- b1
- b2
- b3

**Engineer C** - Gamma
2023
- c1
- c2
- c3

**Engineer D** - Delta
2022
- d1
- d2

## Projects

**[Proj One](https://x.test)** - Go
2026
- p1
- p2
- p3

**Proj Two** - Rust
2025
- q1
- q2
- q3

**Proj Three** - C
2024
- r1
- r2
- r3

## Skills
- not a bullet entry
`;

  console.log('\n━━━ parseMasterCv ━━━');
  const master = parseMasterCv(MASTER_MD);
  ok('reads 4 experience entries', master.experience.length === 4);
  ok('reads 3 project entries', master.projects.length === 3);
  ok('strips the markdown link from a project name', master.projects[0].name === 'Proj One');
  ok('collects bullets per entry', master.experience[0].bullets.length === 4 && master.experience[3].bullets.length === 2);
  ok('ignores non Experience/Projects sections', !master.experience.some(e => e.name === 'Skills'));
  ok('empty input is safe', parseMasterCv('').experience.length === 0);
  ok('non-string input is safe', parseMasterCv(undefined).projects.length === 0);

  const job = (name, n) =>
    `<div class="job"><div class="job-header"><span class="job-company">${name}</span></div><ul>${'<li>x</li>'.repeat(n)}</ul></div>`;
  const proj = (name, n) =>
    `<div class="project"><div class="project-title">${name}</div><ul>${'<li>x</li>'.repeat(n)}</ul></div>`;

  console.log('\n━━━ measureRenderedHtml ━━━');
  const full = job('Engineer A', 3) + job('Engineer B', 3) + job('Engineer C', 3) + job('Engineer D', 2)
    + proj('Proj One', 3) + proj('Proj Two', 3) + proj('Proj Three', 3);
  const r = measureRenderedHtml(full);
  ok('counts job blocks', r.experienceEntries === 4);
  ok('counts project blocks', r.projectEntries === 3);
  ok('counts bullets across both kinds', r.totalBullets === 20);
  ok('extracts entry names', r.entries[0].name === 'Engineer A' && r.entries[4].name === 'Proj One');
  ok('bullets are attributed to the right block', r.entries[3].bullets === 2);
  ok('empty html is safe', measureRenderedHtml('').totalBullets === 0);

  console.log('\n━━━ measureDensity ━━━');
  const dFull = measureDensity(r, master);
  ok('a fully-populated CV is not under-filled', dFull.underFilled === false);
  ok('target total is capped by what the master supports', dFull.targetTotalBullets === 20);

  const thin = job('Engineer A', 3) + job('Engineer B', 3) + proj('Proj One', 3);
  const dThin = measureDensity(measureRenderedHtml(thin), master);
  ok('dropping roles/projects flags under-filled', dThin.underFilled === true);
  ok('names the thin Experience section', dThin.thinEntries.some(t => /Experience section \(2\/4/.test(t)));
  ok('names the thin Projects section', dThin.thinEntries.some(t => /Projects section \(1\/3/.test(t)));

  const lonely = job('Engineer A', 1) + job('Engineer B', 3) + job('Engineer C', 3) + job('Engineer D', 2)
    + proj('Proj One', 3) + proj('Proj Two', 3) + proj('Proj Three', 3);
  const dLonely = measureDensity(measureRenderedHtml(lonely), master);
  ok('a single under-filled entry is caught even when counts look close', dLonely.underFilled === true);
  ok('the specific thin entry is named', dLonely.thinEntries.some(t => /Engineer A \(1\/3 bullets\)/.test(t)));

  // A 2-role master must not be scolded for having 2 roles.
  const small = parseMasterCv(`
## Experience

**Only Role** - X
2025
- x1
- x2

## Projects

**Only Proj** - Y
2025
- y1
`);
  const dSmall = measureDensity(measureRenderedHtml(job('Only Role', 2) + proj('Only Proj', 1)), small);
  ok('targets are capped by the master, so a short CV is not "thin"', dSmall.underFilled === false);
  ok('target entries reflect the master, not the ideal',
    dSmall.targetExperienceEntries === 1 && dSmall.targetProjectEntries === 1);

  console.log('\n━━━ formatDensityWarning ━━━');
  ok('filled CV produces no warning', formatDensityWarning(dFull) === '');
  ok('under-filled CV warns with the PAGE IS UNDER-FILLED marker',
    formatDensityWarning(dThin).includes('PAGE IS UNDER-FILLED'));
  ok('the warning forbids shrinking type/margins',
    /do NOT shrink type or margins/.test(formatDensityWarning(dThin)));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
