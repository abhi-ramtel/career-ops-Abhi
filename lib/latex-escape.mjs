/**
 * Shared LaTeX escaping for career-ops CV scripts.
 */

/**
 * Normalize plain text before LaTeX escaping, so the generated .tex renders
 * with clean ASCII-safe characters that PDF text extractors and legacy ATS
 * parsers read back verbatim.
 *
 * Ported from mcp-overleaf-server (src/core/atsNormalize.ts, which itself was
 * adapted from career-ops' HTML-path normalizer in generate-pdf.mjs). Unlike
 * that HTML function, this one operates on plain text and must run BEFORE
 * escapeLatex — an em-dash becomes a real en-dash ("--") rather than a raw
 * Unicode byte that pdfLaTeX would mis-handle or that pdftotext would drop.
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeForLatex(text) {
  // Coerce scalars, same rule as escapeLatex (#2641): a JSON number like
  // dates: 2024 must render as "2024", not vanish. null/undefined/objects
  // stay blank.
  if (text === null || text === undefined || typeof text === 'object') return '';
  let t = String(text);
  t = t.replace(/[\u2014\u2013]/g, '--');        // em/en dash -> LaTeX en dash
  t = t.replace(/\u2011/g, '-');                 // non-breaking hyphen -> ASCII hyphen
  t = t.replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  t = t.replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  t = t.replace(/\u2026/g, '...');
  t = t.replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '');
  t = t.replace(/\u00A0/g, ' ');
  return t;
}

/**
 * Escape user text for insertion into LaTeX macro arguments.
 *
 * @param {string} text
 * @param {'text'|'url'} [mode='text']
 * @returns {string}
 */
export function escapeLatex(text, mode = 'text') {
  // Blank out only truly absent/structural values, and coerce scalars — the
  // same rule #2641 applied to escapeHtml, which this function mirrors.
  // `typeof text !== 'string' -> ''` silently dropped NUMBERS: a payload with
  // `year: 2019` or `dates: 2024` (JSON numbers, not strings) rendered an empty
  // date field while the section stayed present, so the .tex shipped without
  // employment dates or graduation years — and the builder still reported
  // "valid": true and exited 0.
  if (text === null || text === undefined || typeof text === 'object') return '';
  const value = String(text);
  if (mode === 'url') return value;
  const out = [];
  for (const ch of value) {
    switch (ch) {
      case '\\': out.push('\\textbackslash{}'); break;
      case '{': case '}': out.push('\\' + ch); break;
      case '^': out.push('\\textasciicircum{}'); break;
      case '~': out.push('\\textasciitilde{}'); break;
      case '_': out.push('\\_'); break;
      case '&': out.push('\\&'); break;
      case '%': out.push('\\%'); break;
      case '$': out.push('\\$'); break;
      case '#': out.push('\\#'); break;
      // With pdflatex's default OT1 encoding these three have no glyph in the
      // text font: < and > print as inverted ¡/¿ and | as an em-dash, so
      // "p99 <100ms" renders "p99 ¡100ms". The text commands are safe in all
      // encodings.
      case '<': out.push('\\textless{}'); break;
      case '>': out.push('\\textgreater{}'); break;
      case '|': out.push('\\textbar{}'); break;
      case '\u00B1': out.push('$\\pm$'); break;
      case '\u2192': out.push('$\\rightarrow$'); break;
      default: out.push(ch);
    }
  }
  return out.join('');
}

/**
 * Validate and normalize URLs for \\href{} (not LaTeX-escaped).
 *
 * @param {string} url
 * @returns {string}
 */
export function sanitizeUrl(url) {
  if (typeof url !== 'string') return '';
  url = url.trim();
  if (!url) return '';
  const allowedSchemes = ['mailto:', 'http:', 'https:'];
  const hasScheme = allowedSchemes.some(s => url.toLowerCase().startsWith(s));
  if (!hasScheme) {
    if (url.includes('@') && !url.includes('/')) {
      url = 'mailto:' + url;
    } else {
      url = 'https://' + url;
    }
  }
  return url.replace(/[{}%$#\\~^]/g, '');
}
