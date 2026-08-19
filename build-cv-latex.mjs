#!/usr/bin/env node

/**
 * build-cv-latex.mjs — render a tailored CV JSON payload into the career-ops
 * LaTeX template (templates/cv-template.tex, main.tex design).
 *
 * The script owns every macro call, the section-body rendering, and the
 * escaping — the agent emits compact JSON, never raw LaTeX. Output uses the
 * \roleheading / \projheading / \bul macro family of the template (see
 * templates/README.md for the contract custom templates must keep).
 *
 * Usage:
 *   node build-cv-latex.mjs <input.json> <output.tex> [--template=<name>] [--master=<cv.md>]
 *   node build-cv-latex.mjs --test
 */

import { readFile, writeFile, stat } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname, basename, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { escapeLatex, sanitizeUrl, normalizeForLatex } from './lib/latex-escape.mjs';
import { resolveTemplate } from './cv-templates.mjs';
import { stripEmptySections } from './cv-sections-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = resolve(__dirname, 'templates', 'cv-template.tex');
const PLACEHOLDER_RE = /\{\{[A-Z_]+\}\}/g;

/** ATS-normalize then LaTeX-escape a piece of user text. */
// No string-only guard here: normalizeForLatex/escapeLatex blank out
// null/undefined/objects and COERCE scalars (#2641) — a pre-filter of
// `typeof text === 'string' ? text : ''` would drop JSON numbers like
// dates: 2024 before they ever reach the normalizer.
const esc = (text) => escapeLatex(normalizeForLatex(text));

/**
 * Dates: "Apr 2026 - Present" -> "Apr 2026 -- Present" (LaTeX en dash).
 * Unicode en/em dashes are already normalized to "--" by normalizeForLatex;
 * this only upgrades the spaced ASCII hyphen the markdown CVs use.
 */
const styleDates = (dates) => esc(dates).replace(/\s-\s/g, ' -- ');

/** "a | b | c" (unescaped pipes) -> main.tex's `a\ $|$\ b\ $|$\ c` separators. */
const pipeLine = (text) =>
  String(text ?? '').split('|').map((s) => s.trim()).filter(Boolean).map(esc).join('\\ $|$\\ ');

function bulletBlock(bullets) {
  const items = (Array.isArray(bullets) ? bullets : [])
    .filter((b) => typeof b === 'string' && b.trim())
    .map((b) => `  \\bul{${esc(b)}}`).join('\n');
  return `\\bullist\n${items}\n\\stopbulls`;
}

function buildSummary(payload) {
  return esc(payload.summary);
}

function buildExperience(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const e of entries) {
    if (!e) continue;
    const head = `\\roleheading{${esc(e.role)}}{${styleDates(e.dates)}}{${esc(e.company)}}{${esc(e.location || '')}}`;
    blocks.push(`${head}\n${bulletBlock(e.bullets)}`);
  }
  return blocks.join('\n\\vspace{3pt}\n\n');
}

function buildProjects(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const e of entries) {
    if (!e) continue;
    // Project names stay hyperlinked when the payload carries the source URL.
    const name = e.url?.trim()
      ? `\\href{${sanitizeUrl(e.url)}}{${esc(e.name)}}`
      : esc(e.name);
    const heading = e.context?.trim()
      ? `{\\textbf{${name}} $|$ \\emph{${esc(e.context)}}}`
      : `{\\textbf{${name}}}`;
    blocks.push(`\\projheading${heading}{${styleDates(e.dates)}}\n${bulletBlock(e.bullets)}`);
  }
  return blocks.join('\n\\vspace{3pt}\n\n');
}

// Awards are one line each — no bullet list — so they reuse \projheading
// (bold left column, year right) in the main.tex style. The issuing body
// follows the title in the same $|$ style buildProjects() uses for context.
function buildAwards(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const e of entries) {
    if (!e) continue;
    const org = e.org ? ` $|$ \\emph{${esc(e.org)}}` : '';
    blocks.push(`\\projheading{\\textbf{${esc(e.title)}}${org}}{${esc(e.year || '')}}`);
  }
  return blocks.join('\n\\vspace{3pt}\n\n');
}

function buildSkills(categories) {
  if (!Array.isArray(categories) || categories.length === 0) return '';
  return categories.filter(Boolean).map((c) => {
    const items = Array.isArray(c.items) ? c.items.join(', ') : (c.items || '');
    return `    \\textbf{${esc(c.category)}:} ${esc(items)} \\\\`;
  }).join('\n');
}

function buildEducation(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const blocks = [];
  for (const ed of entries) {
    if (!ed) continue;
    // main.tex education shape: bold institution + dates on one tabular* line,
    // the degree (with $|$-separated distinctions) as a small-italic line,
    // then optional Coursework / Honors & Activities lines.
    const head = [
      `\\begin{tabular*}{\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}`,
      `  \\textbf{${esc(ed.institution)}} & \\textbf{${styleDates(ed.dates)}} \\\\`,
    ];
    if (ed.degree) head.push(`  \\textit{\\small ${pipeLine(ed.degree)}} & \\\\`);
    head.push(`\\end{tabular*}`);
    const extras = [];
    if (Array.isArray(ed.coursework) && ed.coursework.length > 0) {
      extras.push(`\\small\\textbf{Coursework:} \\textit{${ed.coursework.map(esc).join(', ')}}\\\\`);
    }
    if (ed.honors?.trim()) {
      extras.push(`\\textbf{Honors \\& Activities:} \\textit{${esc(ed.honors)}}\\\\`);
    }
    // Blank lines between the tabular and the Coursework/Honors lines mirror
    // main.tex's source layout (paragraph breaks, not extra vspace).
    blocks.push([head.join('\n'), ...extras].join('\n\n'));
  }
  return blocks.join('\n\n');
}

/**
 * Compose the small contact line under the name: free text (phone / city /
 * visa) first, then the mailto/linkedin/github/portfolio links, separated
 * by the template's $|$ divider. Links are \href'd with sanitized URLs and
 * scheme-stripped display text (mirrors main.tex's plain-text contact row).
 */
function urlDisplay(url) {
  return url.replace(/^mailto:/i, '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function buildContactLine(payload) {
  const parts = [];
  // Free text (phone / city / visa) is split on "|" so every separator in the
  // row is the template's $|$ divider, not a raw vertical bar.
  for (const piece of String(payload.contact_line || '').split('|')) {
    if (piece.trim()) parts.push(esc(piece.trim()));
  }
  for (const key of ['email', 'linkedin', 'github', 'portfolio']) {
    const url = sanitizeUrl(payload[key]?.url || '');
    if (!url) continue;
    const display = esc(payload[key]?.display?.trim() || urlDisplay(url));
    parts.push(`\\href{${url}}{${display}}`);
  }
  return parts.join(' $|$ ');
}

// ── Entity provenance (soft anti-fabrication check) ─────────────────────────
//
// Hard claim/metric fabrication is gated by verify-cv-facts.mjs (run on the
// generated .tex by modes/latex.md). This complements it with the part a text
// gate cannot see: whether the ENTITIES the payload asserts — employers,
// titles, project names, institutions, dates, skill items — actually appear
// in the master CV. It is a warning, not an error: a legitimate rewording
// ("Software Engineer Intern" vs cv.md's "Software Engineer") still fires,
// and the agent reviews the warning instead of being blocked. The same
// discipline mcp-overleaf-server enforces with sourceId citations, adapted
// to career-ops' flat JSON payload.

const normEntity = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function checkProvenance(payload, masterText) {
  const hay = normEntity(masterText);
  const masterLower = String(masterText).toLowerCase();
  const has = (s) => {
    const n = normEntity(s);
    return n.length >= 3 && hay.includes(n);
  };
  // Literal word-boundary test for items too short for the normalized
  // substring check ("Go", "C/C++", "R", "JS"): case-insensitive, with a
  // non-word edge on both sides. Without this, every genuine short skill in
  // the master CV warned on every build, and warnings the mode tells the
  // agent to review lose their meaning. A fabricated short skill ("Kafka")
  // still fails — it has no literal occurrence and no strong tokens.
  const literalInMaster = (s) => {
    const n = String(s ?? '').trim().toLowerCase();
    if (!n) return false;
    const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9+#./-])${escaped}($|[^a-z0-9+#./-])`, 'i').test(masterLower);
  };
  // Multi-word skill items: pass when the item is found verbatim, or when at
  // least two of its 3+-char tokens are (a fabricated single term like
  // "Kafka" still fails; "CI/CD (GitHub Actions, Jenkins)" passes via
  // github + jenkins).
  const skillItemOk = (item) => {
    if (has(item)) return true;
    if (literalInMaster(item)) return true;
    const tokens = normEntity(item).match(/[a-z0-9]+/g) || [];
    const strong = tokens.filter((t) => t.length >= 3);
    if (strong.length === 0) return false;
    const hits = strong.filter((t) => hay.includes(t)).length;
    return hits >= Math.min(2, strong.length);
  };

  const warnings = [];
  for (const e of Array.isArray(payload.experience) ? payload.experience : []) {
    if (!e) continue;
    if (e.company && !has(e.company)) warnings.push(`experience: company "${e.company}" not found in cv.md — confirm it is a real employer before sending`);
    if (e.role && !has(e.role)) warnings.push(`experience: title "${e.role}" not found in cv.md — confirm it is the candidate's real title`);
    if (e.dates && !has(e.dates)) warnings.push(`experience: dates "${e.dates}" not found in cv.md — copy dates verbatim from cv.md`);
  }
  for (const p of Array.isArray(payload.projects) ? payload.projects : []) {
    if (!p) continue;
    if (p.name && !has(p.name)) warnings.push(`projects: "${p.name}" not found in cv.md — confirm it is the candidate's own project`);
    if (p.dates && !has(p.dates)) warnings.push(`projects: dates "${p.dates}" not found in cv.md — copy dates verbatim from cv.md`);
  }
  for (const ed of Array.isArray(payload.education) ? payload.education : []) {
    if (!ed) continue;
    if (ed.institution && !has(ed.institution)) warnings.push(`education: institution "${ed.institution}" not found in cv.md — confirm it is the candidate's real institution`);
    if (ed.dates && !has(ed.dates)) warnings.push(`education: dates "${ed.dates}" not found in cv.md — copy dates verbatim from cv.md`);
  }
  for (const c of Array.isArray(payload.skills) ? payload.skills : []) {
    if (!c) continue;
    const items = Array.isArray(c.items) ? c.items : String(c.items || '').split(',');
    for (const item of items) {
      const it = String(item).trim();
      if (it && !skillItemOk(it)) warnings.push(`skills: "${it}" not found in cv.md — confirm the candidate actually has this skill`);
    }
  }
  return warnings;
}

/**
 * Fill every {{PLACEHOLDER}} in the template from the payload. Returns
 * { tex, unresolved } — unresolved is the leftover {{...}} list (empty when
 * the template is fully covered).
 */
function fillTemplate(templateText, payload) {
  // Drop optional sections (projects, education, awards, skills) that carry
  // no entries, so an absent one leaves no bare header behind.
  let template = stripEmptySections(templateText, payload, 'tex');

  const emailUrl = sanitizeUrl(payload.email?.url || '');
  const linkedinUrl = sanitizeUrl(payload.linkedin?.url || '');
  const githubUrl = sanitizeUrl(payload.github?.url || '');
  const portfolioUrl = sanitizeUrl(payload.portfolio?.url || '');

  // Legacy link placeholders stay in the map so older custom .tex templates
  // that print the links inline still render; the base template composes them
  // into {{CONTACT_LINE}} instead.
  const substitutions = {
    NAME: esc(payload.name),
    CONTACT_LINE: buildContactLine(payload),
    EMAIL_URL: emailUrl,
    EMAIL_DISPLAY: esc(payload.email?.display?.trim() || urlDisplay(emailUrl)),
    LINKEDIN_URL: linkedinUrl,
    LINKEDIN_DISPLAY: esc(payload.linkedin?.display?.trim() || urlDisplay(linkedinUrl)),
    GITHUB_URL: githubUrl,
    GITHUB_DISPLAY: esc(payload.github?.display?.trim() || urlDisplay(githubUrl)),
    PORTFOLIO_URL: portfolioUrl,
    SUMMARY: buildSummary(payload),
    EDUCATION: buildEducation(payload.education),
    EXPERIENCE: buildExperience(payload.experience),
    PROJECTS: buildProjects(payload.projects),
    AWARDS: buildAwards(payload.awards),
    SKILLS: buildSkills(payload.skills),
  };

  // Replacer FUNCTION, not a string: esc() turns `$` into `\$` but leaves the
  // next character alone, so a bullet containing `$'` would survive as the JS
  // replacement pattern meaning "everything after the match" and splice the
  // rest of the template into the document — silently, with a valid-looking
  // exit 0. A replacer function's return value is inserted literally.
  for (const [key, value] of Object.entries(substitutions)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), () => value);
  }

  return { tex: template, unresolved: template.match(PLACEHOLDER_RE) || [] };
}

/** Counts reported back to the caller (and the mode's final report). */
function countEntries(payload) {
  return {
    summaryPresent: Boolean(String(payload.summary || '').trim()),
    educationEntries: (payload.education || []).length,
    experienceEntries: (payload.experience || []).length,
    projectEntries: (payload.projects || []).length,
    awardEntries: (payload.awards || []).length,
    skillCategories: (payload.skills || []).length,
    totalBullets: (() => {
      const ex = Array.isArray(payload.experience) ? payload.experience.flatMap(e => Array.isArray(e?.bullets) ? e.bullets : []) : [];
      const pr = Array.isArray(payload.projects) ? payload.projects.flatMap(p => Array.isArray(p?.bullets) ? p.bullets : []) : [];
      return ex.length + pr.length;
    })(),
  };
}

function parseArgs(args) {
  const out = { _: [], template: '', master: '' };
  for (const a of args) {
    if (a === '--test') out.test = true;
    else if (a === '--help') out.help = true;
    else if (a.startsWith('--template=')) out.template = a.split('=')[1];
    else if (a.startsWith('--master=')) out.master = a.split('=')[1];
    else out._.push(a);
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.help || (parsed._.length === 0 && !parsed.test)) {
    console.error('Usage:');
    console.error('  node build-cv-latex.mjs <input.json> <output.tex> [--template=<name>] [--master=<cv.md>]');
    console.error('  node build-cv-latex.mjs --test');
    process.exit(1);
  }

  if (parsed.test) {
    await runSelfTest();
    return;
  }

  const [inputPath, outputPath] = parsed._;

  if (!inputPath || !outputPath) {
    console.error('Usage: node build-cv-latex.mjs <input.json> <output.tex> [--template=<name>] [--master=<cv.md>]');
    process.exit(1);
  }

  const absInput = resolve(inputPath);
  const absOutput = resolve(outputPath);
  const outDir = dirname(absOutput);

  if (!existsSync(absInput)) {
    console.error(`Input file not found: ${absInput}`);
    process.exit(1);
  }

  let payload;
  try {
    const raw = await readFile(absInput, 'utf-8');
    payload = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse input JSON: ${err.message}`);
    process.exit(1);
  }

  if (!String(payload.summary || '').trim()) {
    console.error('Error: "summary" is required — the template renders a Summary section. Write a 2-3 line summary tailored to the target role, grounded in cv.md (never invented).');
    process.exit(1);
  }

  // Honor a selected .tex template variant (cv.template default or --template=<name>),
  // falling back to the base cv-template.tex when no variant exists.
  let TEMPLATE_PATH_RESOLVED;
  try {
    TEMPLATE_PATH_RESOLVED = resolveTemplate('cv', parsed.template, { format: 'tex', fallback: true });
  } catch {
    TEMPLATE_PATH_RESOLVED = TEMPLATE_PATH;
  }

  if (!existsSync(TEMPLATE_PATH_RESOLVED)) {
    console.error(`Template not found: ${TEMPLATE_PATH_RESOLVED}`);
    process.exit(1);
  }

  const template = await readFile(TEMPLATE_PATH_RESOLVED, 'utf-8');
  const { tex, unresolved } = fillTemplate(template, payload);

  if (unresolved.length > 0) {
    console.error(`Unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
    process.exit(1);
  }

  // Soft entity provenance check against the master CV (cv.md by default).
  const masterPath = parsed.master ? resolve(parsed.master) : resolve(process.cwd(), 'cv.md');
  let provenance;
  if (existsSync(masterPath)) {
    provenance = {
      checked: true,
      master: masterPath,
      warnings: checkProvenance(payload, await readFile(masterPath, 'utf-8')),
    };
  } else {
    provenance = {
      checked: false,
      master: null,
      warnings: [],
      reason: 'master CV not found — entity provenance check skipped (run from the project root or pass --master=<cv.md>)',
    };
  }

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  await writeFile(absOutput, tex, 'utf-8');

  const fileInfo = await stat(absOutput);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  const report = {
    file: basename(absOutput),
    path: absOutput,
    sizeKB: parseFloat(sizeKB),
    template: TEMPLATE_PATH_RESOLVED,
    counts: countEntries(payload),
    provenance,
    valid: true,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

async function runSelfTest() {
  const sample = {
    name: 'Test Candidate',
    summary: 'Early-career software engineer focused on backend systems and applied AI, with measurable performance wins across C++ and Python.',
    contact_line: 'City, State | +1 234 567 8900',
    email: { url: 'test@example.com', display: 'test@example.com' },
    linkedin: { url: 'https://linkedin.com/in/test', display: 'linkedin.com/in/test' },
    github: { url: 'https://github.com/test', display: 'github.com/test' },
    portfolio: { url: 'https://test.dev', display: 'test.dev' },
    education: [{
      institution: 'Test University',
      location: 'City, State',
      degree: 'Bachelor of Science in Testing | Magna Cum Laude',
      dates: '2020 - 2024',
      coursework: ['Data Structures', 'Algorithms', 'Machine Learning'],
      honors: 'Dean\'s List (2x)',
    }],
    experience: [{
      company: 'Test Corp',
      role: 'Test Engineer',
      location: 'Remote',
      dates: 'June 2024 - Present',
      bullets: [
        'Built automated testing pipelines with CI/CD integration',
        'Reduced regression test time by 60% through parallel execution',
      ],
    }],
    projects: [{
      name: 'Test Project',
      url: 'https://github.com/test/project',
      context: 'Python, FastAPI, Docker',
      dates: '2024',
      bullets: [
        'Built a REST API with automated test coverage exceeding 90%',
      ],
    }],
    awards: [
      { title: 'Gold Medal, International Olympiad in Informatics', org: 'IOI', year: '2023' },
      { title: "Dean's List", org: 'Test University', year: '2022' },
    ],
    skills: [
      { category: 'Languages', items: 'Python, JavaScript, TypeScript' },
      { category: 'Frameworks', items: 'FastAPI, React, PyTorch' },
    ],
  };

  const testOutput = join(tmpdir(), 'build-cv-latex-test.tex');
  const raw = JSON.stringify(sample, null, 2);
  const tmpInput = join(tmpdir(), 'build-cv-latex-test-input.json');
  await writeFile(tmpInput, raw, 'utf-8');

  const absInput = resolve(tmpInput);
  const absOutput = resolve(testOutput);

  if (!existsSync(TEMPLATE_PATH)) {
    console.error(`Self-test failed: template not found at ${TEMPLATE_PATH}`);
    process.exit(1);
  }

  const template = await readFile(TEMPLATE_PATH, 'utf-8');
  const { tex, unresolved } = fillTemplate(template, sample);

  if (unresolved.length > 0) {
    console.error(`Self-test failed: unresolved placeholders: ${[...new Set(unresolved)].join(', ')}`);
    process.exit(1);
  }

  // Sanity: the rendered document must use the template's macro family and
  // keep the ATS pragma.
  for (const marker of ['\\roleheading', '\\bul{', '\\projheading', '\\pdfgentounicode=1']) {
    if (!tex.includes(marker)) {
      console.error(`Self-test failed: rendered tex is missing ${marker}`);
      process.exit(1);
    }
  }

  const outDir = dirname(absOutput);
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  await writeFile(absOutput, tex, 'utf-8');

  const fileInfo = await stat(absOutput);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  const report = {
    status: 'self-test-passed',
    file: basename(absOutput),
    path: absOutput,
    sizeKB: parseFloat(sizeKB),
    counts: countEntries(sample),
  };

  console.log(JSON.stringify(report, null, 2));

  await import('fs/promises').then(fs =>
    Promise.all([
      fs.rm(tmpInput).catch(() => {}),
      fs.rm(testOutput).catch(() => {}),
    ])
  );

  process.exit(0);
}

main();
