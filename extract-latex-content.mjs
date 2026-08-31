#!/usr/bin/env node

/**
 * extract-latex-content.mjs — Detect LaTeX CV family and list editable prose slots.
 *
 * v1 families:
 *   - resumeSubheading (\\resumeItem bullets + \\textbf{Category}{: skills})
 *   - roleheading (\\bul bullets + \\textbf{Category:} items \\\\ skill lines; main.tex design)
 *   - tabularx-itemize (\\item bodies inside itemize, no resume macros)
 *
 * Usage:
 *   node extract-latex-content.mjs                      # resolve from profile.yml
 *   node extract-latex-content.mjs <source.tex>
 *   node extract-latex-content.mjs <source.tex> --out manifest.json
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync, readFileSync } from 'fs';
import { resolve, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { buildManifest } from './lib/latex-content.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the user's hand-maintained .tex CV, in the order modes/latex-tex.md
 * documents: `latex.source` from config/profile.yml, then resume.tex, then
 * cv.tex in the project root.
 *
 * This existed only as prose in the mode file, and `latex.source` appeared in
 * the codebase solely inside an error hint — nothing read it. So a profile
 * pointing at `data/main.tex` was honoured only if the agent driving the mode
 * happened to remember to look, and silently ignored otherwise. AGENTS.md's own
 * rule applies: reinforcement without enforcement decays.
 *
 * @returns {{ path: string, from: string } | null}
 */
export function resolveLatexSource(profilePath = resolve(ROOT, 'config', 'profile.yml')) {
  try {
    if (existsSync(profilePath)) {
      const profile = yaml.load(readFileSync(profilePath, 'utf-8')) || {};
      const configured = profile?.latex?.source;
      if (typeof configured === 'string' && configured.trim()) {
        // Relative to the project root, not the caller's cwd — the profile is a
        // property of the workspace, so `data/main.tex` must mean the same
        // thing regardless of where the command is run from.
        const abs = resolve(ROOT, configured.trim());
        if (existsSync(abs)) return { path: abs, from: 'config/profile.yml latex.source' };
        return { path: abs, from: 'config/profile.yml latex.source', missing: true };
      }
    }
  } catch {
    // A malformed profile is doctor.mjs's problem to report, not this
    // script's problem to crash on. Fall through to the filename defaults.
  }
  for (const name of ['resume.tex', 'cv.tex']) {
    const abs = resolve(ROOT, name);
    if (existsSync(abs)) return { path: abs, from: name };
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--help');
  const outIdx = args.indexOf('--out');
  let outPath = null;
  if (outIdx !== -1) {
    outPath = args[outIdx + 1];
    args.splice(outIdx, 2);
  }

  let absPath;
  if (args[0]) {
    absPath = resolve(args[0]);
  } else {
    const resolved = resolveLatexSource();
    if (!resolved) {
      console.error('Usage: node extract-latex-content.mjs <source.tex> [--out manifest.json]');
      console.error('No source given and none resolved: set `latex.source` in config/profile.yml,');
      console.error('or place resume.tex / cv.tex in the project root.');
      process.exit(1);
    }
    if (resolved.missing) {
      console.error(`Source from ${resolved.from} does not exist: ${resolved.path}`);
      process.exit(1);
    }
    absPath = resolved.path;
    console.error(`Using ${resolved.path} (from ${resolved.from})`);
  }
  if (!existsSync(absPath)) {
    console.error(`Source not found: ${absPath}`);
    process.exit(1);
  }

  let tex;
  try {
    tex = await readFile(absPath, 'utf-8');
  } catch (err) {
    console.error(`Failed to read ${absPath}: ${err.message}`);
    process.exit(1);
  }

  const manifest = buildManifest(basename(absPath), tex);
  const json = JSON.stringify(manifest, null, 2);

  if (outPath) {
    await writeFile(resolve(outPath), json, 'utf-8');
  }
  console.log(json);
  process.exit(manifest.supported ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main();
}
