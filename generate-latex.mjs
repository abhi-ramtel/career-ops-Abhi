#!/usr/bin/env node

/**
 * generate-latex.mjs — Validate and compile a generated .tex CV file to PDF
 *
 * Usage:
 *   node generate-latex.mjs <input.tex> [output.pdf]
 *   node generate-latex.mjs <input.tex> [output.pdf] --compile-only
 *   node generate-latex.mjs <input.tex> [output.pdf] --max-pages=1 --strict-pages
 *
 * Default: validates career-ops template structure (from templates/cv-template.tex).
 * The structural check accepts BOTH shipped macro families — the legacy
 * \resumeSubheading/\resumeItem/\resumeProjectHeading family and the
 * \roleheading/\bul/\projheading family used by the current (main.tex-design)
 * template — so older and newer generated files validate the same way.
 * --compile-only: skip template validation; compile any user-owned .tex (latex-tex mode).
 *
 * One-page enforcement mirrors generate-pdf.mjs: `--max-pages=N` (default 2)
 * adds a loud warning when the compiled PDF is longer, and `--strict-pages`
 * turns that overflow into a non-zero exit (the PDF is still written).
 * A one-page PDF whose final text ends well above the bottom margin gets a
 * PAGE IS UNDER-FILLED warning (measured via Poppler `pdftotext -bbox` when
 * available — best effort, never blocks).
 *
 * Requires: tectonic (preferred) or pdflatex on PATH.
 */

import { readFile, writeFile, stat, copyFile, rm } from 'fs/promises';
import { resolve, basename, dirname, join } from 'path';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const MIN_SECTIONS = 4;

// Bullet commands from either shipped macro family. (The /g flag matters:
// .match() without it returns only the FIRST match, which silently turned
// every count into a 0/1 presence test.)
const BULLET_RE = /\\resumeItem\{|\\bul\{/g;
// Entry-heading commands from either family.
const SUBHEADING_RE = /\\resumeSubheading(?![a-zA-Z])|\\roleheading\b/g;
const PROJECT_HEADING_RE = /\\resumeProjectHeading\b|\\projheading\b/g;

const CJK_RE = /[぀-ヿ㐀-鿿豈-﫿ｦ-ﾟ가-힯ᄀ-ᇿ]/;

/**
 * @param {string} content
 * @param {boolean} compileOnly
 * @returns {{ issues: string[], counts: object }}
 */
export function validateLatexContent(content, compileOnly) {
  const issues = [];
  let bulletCount = 0;
  let subheadingCount = 0;
  let projectHeadingCount = 0;

  if (!content.includes('\\begin{document}')) {
    issues.push('Missing \\begin{document}');
  }
  if (!content.includes('\\end{document}')) {
    issues.push('Missing \\end{document}');
  }

  if (compileOnly) {
    return {
      issues,
      counts: { bullets: 0, subheadings: 0, projectHeadings: 0 },
    };
  }

  const sectionCount = (content.match(/\\section\{/g) || []).length;
  if (sectionCount < MIN_SECTIONS) {
    issues.push(`Expected at least ${MIN_SECTIONS} \\section{} blocks (Summary, Experience, Projects, Skills, Education — or localized equivalents), found ${sectionCount}`);
  }

  if (CJK_RE.test(content)) {
    issues.push('CJK characters detected. The LaTeX template does not support Japanese/Chinese/Korean yet (pdfLaTeX setup with no CJK font). Use `pdf` mode (HTML to PDF, which renders CJK) for these CVs.');
  }

  // At least one shipped macro family must be present. A CV with neither
  // bullets nor entry headings is not a CV regardless of template vintage.
  bulletCount = (content.match(BULLET_RE) || []).length;
  subheadingCount = (content.match(SUBHEADING_RE) || []).length;
  projectHeadingCount = (content.match(PROJECT_HEADING_RE) || []).length;
  const hasResumeFamily = /\\resumeSubheading(?![a-zA-Z])|\\resumeItem\b|\\resumeProjectHeading\b/.test(content);
  const hasNativeFamily = /\\roleheading\b|\\projheading\b|\\bul\b/.test(content);
  if (!hasResumeFamily && !hasNativeFamily) {
    issues.push('Missing entry commands: expected the \\resumeSubheading/\\resumeItem/\\resumeProjectHeading family or the \\roleheading/\\bul/\\projheading family (main.tex design)');
  }
  if (bulletCount === 0 && (subheadingCount > 0 || projectHeadingCount > 0)) {
    issues.push('No bullet commands found (\\resumeItem or \\bul) — the document has headings but no content under them');
  }

  const unresolvedMatch = content.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolvedMatch) {
    issues.push(`Unresolved placeholders: ${[...new Set(unresolvedMatch)].join(', ')}`);
  }

  if (!content.includes('\\pdfgentounicode=1')) {
    issues.push('Missing \\pdfgentounicode=1 (ATS compatibility)');
  }

  return {
    issues,
    counts: {
      bullets: bulletCount,
      subheadings: subheadingCount,
      projectHeadings: projectHeadingCount,
    },
  };
}

/**
 * Extract the page count from a LaTeX engine's output or log.
 * pdflatex/tectonic print "Output written on <file> (N pages, M bytes)." —
 * but a long <file> wraps across lines in the log, so match the "(N pages,
 * … bytes)" tail, which never wraps. Falls back to a whitespace-collapsed
 * match (ported from mcp-overleaf-server's latexCompile parsePageCount).
 *
 * @param {string} text
 * @returns {number|undefined}
 */
export function parsePageCount(text) {
  if (typeof text !== 'string' || !text) return undefined;
  const m = text.match(/\((\d+)\s+pages?,\s*\d+\s*bytes\)/);
  if (m) return Number(m[1]);
  const m2 = text.replace(/\s+/g, ' ').match(/Output written on [^(]+\((\d+)\s+pages?/);
  return m2 ? Number(m2[1]) : undefined;
}

/**
 * Parse Poppler's `pdftotext -bbox` XHTML without taking a runtime dependency
 * on a PDF library. The final page is the meaningful one for a one-page
 * résumé: its lowest text reveals whether the visible lower third is empty
 * (ported from mcp-overleaf-server's latexCompile parsePdfPageUsage).
 *
 * @param {string} xhtml
 * @returns {{pageHeightPoints: number, contentBottomYPoints: number, bottomWhitespacePoints: number}|undefined}
 */
export function parsePdfPageUsage(xhtml) {
  if (typeof xhtml !== 'string' || !xhtml) return undefined;
  const pages = [...xhtml.matchAll(/<page\b([^>]*)>([\s\S]*?)<\/page>/g)];
  const page = pages.at(-1);
  if (!page) return undefined;

  const heightMatch = page[1]?.match(/\bheight="([0-9.]+)"/);
  const pageHeightPoints = Number(heightMatch?.[1]);
  if (!Number.isFinite(pageHeightPoints) || pageHeightPoints <= 0) return undefined;

  let contentBottomYPoints = 0;
  for (const word of page[2]?.matchAll(/\byMax="([0-9.]+)"/g) ?? []) {
    const yMax = Number(word[1]);
    if (Number.isFinite(yMax)) contentBottomYPoints = Math.max(contentBottomYPoints, yMax);
  }
  if (contentBottomYPoints <= 0) return undefined;

  return {
    pageHeightPoints,
    contentBottomYPoints,
    bottomWhitespacePoints: Math.max(0, pageHeightPoints - contentBottomYPoints),
  };
}

/**
 * Best-effort lower-page fill measurement via Poppler. Returns undefined when
 * pdftotext is unavailable — the measurement is advisory and must never block
 * a compile.
 *
 * @param {string} pdfPath
 */
function inspectPdfPageUsage(pdfPath) {
  try {
    const stdout = execFileSync('pdftotext', ['-bbox', pdfPath, '-'], {
      stdio: 'pipe',
      encoding: 'utf-8',
      timeout: 15_000,
    });
    return parsePdfPageUsage(stdout);
  } catch {
    return undefined;
  }
}

/** About 0.58 in. The main.tex-design template fills much closer, so this is conservative. */
const MAX_BOTTOM_WHITESPACE_POINTS = 42;

/**
 * @param {string} absPath
 * @param {string} content
 * @param {string|null} outputPath
 * @param {boolean} compileOnly
 * @param {{maxPages?: number, strictPages?: boolean}} [pageOpts]
 * @returns {Promise<object>}
 */
export async function compileLatexFile(absPath, content, outputPath, compileOnly, pageOpts = {}) {
  const maxPages = Number.isFinite(pageOpts.maxPages) && pageOpts.maxPages > 0 ? pageOpts.maxPages : 2;
  const strictPages = Boolean(pageOpts.strictPages);

  const { issues, counts } = validateLatexContent(content, compileOnly);
  const fileInfo = await stat(absPath);
  const sizeKB = (fileInfo.size / 1024).toFixed(1);

  const report = {
    file: basename(absPath),
    path: absPath,
    sizeKB: parseFloat(sizeKB),
    counts,
    issues,
    warnings: [],
    valid: issues.length === 0,
    compileOnly,
  };

  if (issues.length > 0) {
    return report;
  }

  const texDir = dirname(absPath);
  const texBase = basename(absPath, '.tex');
  const defaultPdf = join(texDir, `${texBase}.pdf`);
  const targetPdf = outputPath ? resolve(outputPath) : defaultPdf;

  const targetDir = dirname(targetPdf);
  if (!existsSync(targetDir)) {
    mkdirSync(targetDir, { recursive: true });
  }

  let engine = null;
  for (const candidate of ['tectonic', 'pdflatex']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      engine = candidate;
      break;
    } catch { /* not found */ }
  }

  if (!engine) {
    report.compiled = false;
    report.compileError = 'No LaTeX engine found. Install tectonic (brew install tectonic) or pdflatex.';
    return report;
  }

  report.engine = engine;

  let compilePath = absPath;
  if (engine === 'tectonic') {
    const patched = content
      .replace(/\\pdfgentounicode\s*=\s*\d+[^\n]*\n?/g, '')
      .replace(/\\input\{glyphtounicode\}[^\n]*\n?/g, '');
    compilePath = join(texDir, `${texBase}._tectonic.tex`);
    await writeFile(compilePath, patched, 'utf-8');
  }

  let engineStdout = '';
  try {
    if (engine === 'tectonic') {
      const r = execFileSync('tectonic', ['--outdir', texDir, compilePath], {
        cwd: texDir,
        stdio: 'pipe',
        encoding: 'utf-8',
        timeout: 120_000,
      });
      engineStdout = r || '';
    } else {
      const pdflatexArgs = [
        '-no-shell-escape',
        '-interaction=nonstopmode',
        '-halt-on-error',
        `-output-directory=${texDir}`,
        absPath,
      ];
      execFileSync('pdflatex', pdflatexArgs, { cwd: texDir, stdio: 'pipe', timeout: 120_000 });
      const r = execFileSync('pdflatex', pdflatexArgs, { cwd: texDir, stdio: 'pipe', encoding: 'utf-8', timeout: 120_000 });
      engineStdout = r || '';
    }

    report.compiled = true;
  } catch (err) {
    const logPath = join(texDir, `${texBase}.log`);
    let latexError = err.message;
    try {
      const log = await readFile(logPath, 'utf-8');
      const errorLines = log.split('\n').filter(l => l.startsWith('!'));
      if (errorLines.length > 0) {
        latexError = errorLines.join('\n');
      }
    } catch { /* no log */ }

    report.compiled = false;
    report.compileError = latexError;
    return report;
  }

  if (report.compiled) {
    const compileBase = basename(compilePath, '.tex');
    const compiledPdf = join(texDir, `${compileBase}.pdf`);

    try {
      await copyFile(compiledPdf, targetPdf);
      if (resolve(compiledPdf) !== resolve(targetPdf)) {
        await rm(compiledPdf).catch(() => {});
      }

      const pdfStat = await stat(targetPdf);
      report.pdf = {
        path: targetPdf,
        sizeKB: parseFloat((pdfStat.size / 1024).toFixed(1)),
      };
    } catch (err) {
      report.postCompileError = `Failed to finalize PDF: ${err.message}`;
    }

    const auxExts = ['.aux', '.log', '.out', '.fls', '.fdb_latexmk', '.synctex.gz'];
    for (const ext of auxExts) {
      await rm(join(texDir, `${compileBase}${ext}`)).catch(() => {});
    }
    if (engine === 'tectonic') {
      await rm(compilePath).catch(() => {});
    }

    // ── One-page signals (port of mcp-overleaf-server's compile report) ──
    const pageCount = parsePageCount(engineStdout);
    if (pageCount !== undefined) report.pageCount = pageCount;

    if (report.pdf?.path) {
      const pageUsage = inspectPdfPageUsage(report.pdf.path);
      if (pageUsage) report.pageUsage = pageUsage;
    }

    if (pageCount !== undefined) {
      if (pageCount > maxPages) {
        report.pagesExceeded = true;
        report.warnings.push(
          `⚠️ PDF is ${pageCount} pages (max ${maxPages}) — trim evidence per the One-Page Rule in modes/latex.md (drop low-relevance content first; never shrink the type or margins). Recompile after trimming.`
        );
        if (strictPages) {
          report.strictFailed = true;
          report.warnings.push('Strict page limit active (--strict-pages): this run is NOT a successful one-page render. Trim and rerun.');
        }
      } else if (pageCount === 1 && report.pageUsage && report.pageUsage.bottomWhitespacePoints > MAX_BOTTOM_WHITESPACE_POINTS) {
        report.warnings.push(
          `⚠️ PAGE IS UNDER-FILLED — the final text ends ${Math.round(report.pageUsage.bottomWhitespacePoints)}pt above the bottom of the page (acceptable: ${MAX_BOTTOM_WHITESPACE_POINTS}pt). Add sourced detail from cv.md (another relevant bullet, project, or role); do NOT shrink type or margins to fill the page.`
        );
      }
    }
  }

  return report;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const compileOnly = rawArgs.includes('--compile-only');
  const strictPages = rawArgs.includes('--strict-pages');
  const maxPagesArg = rawArgs.find(a => a.startsWith('--max-pages='));
  const maxPages = maxPagesArg ? Number(maxPagesArg.split('=')[1]) : 2;
  const args = rawArgs.filter(a => !a.startsWith('--'));
  const inputPath = args[0];
  const outputPath = args[1];

  if (!inputPath) {
    console.error('Usage: node generate-latex.mjs <input.tex> [output.pdf] [--compile-only] [--max-pages=N] [--strict-pages]');
    process.exit(1);
  }

  const absPath = resolve(inputPath);
  let content;
  try {
    content = await readFile(absPath, 'utf-8');
  } catch (err) {
    console.error(`Error reading ${absPath}: ${err.message}`);
    process.exit(1);
  }

  const report = await compileLatexFile(absPath, content, outputPath || null, compileOnly, { maxPages, strictPages });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.compiled && !report.strictFailed ? 0 : (report.valid ? 1 : 1));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
