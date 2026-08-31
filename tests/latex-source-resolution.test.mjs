// tests/latex-source-resolution.test.mjs — `latex.source` in config/profile.yml
// must actually select the user's hand-maintained .tex CV.
//
// The bug this guards: modes/latex-tex.md documented a three-step resolution
// order (latex.source -> resume.tex -> cv.tex), but NOTHING implemented it.
// `latex.source` appeared in the codebase only inside an error-hint string, so
// a profile pointing at `data/main.tex` was honoured only when the agent
// driving the mode happened to read the profile, and silently ignored
// otherwise — the user's real CV was simply never used.

import { pass, fail } from './helpers.mjs';
import { resolveLatexSource } from '../extract-latex-content.mjs';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

console.log('\nlatex source resolution (config/profile.yml -> latex.source)');

const dir = mkdtempSync(join(tmpdir(), 'latex-src-'));
const profile = join(dir, 'profile.yml');

// 1. A configured source wins.
writeFileSync(profile, 'latex:\n  source: data/main.tex\n');
const configured = resolveLatexSource(profile);
if (configured && configured.path.endsWith('data/main.tex') && /latex\.source/.test(configured.from)) {
  pass('a configured latex.source is resolved and attributed to the profile');
} else {
  fail(`latex.source not resolved: ${JSON.stringify(configured)}`);
}

// 2. A configured-but-absent path reports missing rather than falling through.
// Falling back here would silently tailor the WRONG document — the failure has
// to name the file the user asked for.
writeFileSync(profile, 'latex:\n  source: data/does-not-exist.tex\n');
const absent = resolveLatexSource(profile);
if (absent && absent.missing === true && absent.path.endsWith('data/does-not-exist.tex')) {
  pass('a configured path that does not exist is reported missing, not silently replaced');
} else {
  fail(`absent latex.source mishandled: ${JSON.stringify(absent)}`);
}

// 3. No latex block -> fall back to the documented filenames.
writeFileSync(profile, 'candidate:\n  full_name: Test\n');
const fallback = resolveLatexSource(profile);
if (fallback === null || ['resume.tex', 'cv.tex'].includes(fallback.from)) {
  pass('with no latex.source it falls back to resume.tex / cv.tex or reports nothing');
} else {
  fail(`unexpected fallback: ${JSON.stringify(fallback)}`);
}

// 4. A malformed profile must not crash the extractor.
writeFileSync(profile, 'latex:\n  source: [unclosed\n');
try {
  const broken = resolveLatexSource(profile);
  if (broken === null || typeof broken === 'object') {
    pass('a malformed profile falls through instead of throwing');
  } else {
    fail(`malformed profile returned ${JSON.stringify(broken)}`);
  }
} catch (err) {
  fail(`malformed profile threw: ${err.message}`);
}

// 5. A missing profile file is not an error.
try {
  const none = resolveLatexSource(join(dir, 'nope.yml'));
  if (none === null || typeof none === 'object') {
    pass('an absent profile file resolves without throwing');
  } else {
    fail('absent profile mishandled');
  }
} catch (err) {
  fail(`absent profile threw: ${err.message}`);
}

// 6. A blank/whitespace source is treated as unset, not as the root directory.
writeFileSync(profile, 'latex:\n  source: "   "\n');
const blank = resolveLatexSource(profile);
if (blank === null || ['resume.tex', 'cv.tex'].includes(blank.from)) {
  pass('a whitespace-only latex.source is treated as unset');
} else {
  fail(`blank latex.source resolved to ${JSON.stringify(blank)}`);
}

rmSync(dir, { recursive: true, force: true });
