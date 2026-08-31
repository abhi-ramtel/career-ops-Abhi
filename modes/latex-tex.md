# Mode: latex-tex — Tailor a user-owned LaTeX CV in place

> **Authoring rules:** `modes/resume-authoring.md` is the canonical source for truthfulness/provenance, the fill-the-page density targets, skills discipline, and template selection. Read it before generating content.


Opt-in mode for candidates who already maintain a hand-tuned `.tex` CV. **Does not change the global source of truth** — `cv.md` remains the default for evaluations, apply mode, and auto-pipeline. Invoke explicitly via `/career-ops latex-tex`.

## When to use

- User has `resume.tex` (or `config/profile.yml → latex.source`) in a supported layout
- User wants JD-tailored bullets/skills while keeping their preamble, macros, colors, and spacing

## Supported layouts (v1)

| Family | Detection | Editable prose |
|--------|-----------|----------------|
| `resumeSubheading` | `\resumeSubheading` + `\resumeItem`/`\resumeItemWithoutTitle`/`\resumeSubItem` | `\resumeItem{...}` and `\resumeItemWithoutTitle{}{...}` bullets; `\textbf{Category}{: items}` and `\resumeSubItem{Category}{items}` skill values |
| `roleheading` | `\roleheading` + `\bul` + `\bullist` (the main.tex-design family used by `templates/cv-template.tex`) | `\bul{...}` bullets; `\textbf{Category:} items \\` skill lines **within the Skills section only** (Education's `Coursework:`/`Honors & Activities:` lines look alike but are not editable skills) |
| `tabularx-itemize` | `tabularx` + `itemize`, no resume macros | `\item` body text in the document body |

Detection order matters: `roleheading` is checked before `tabularx-itemize`, because roleheading documents load `tabularx` and use `itemize` as well (an unpatched document would otherwise be misdetected and only its `\item` lines extracted).

Extraction only reads the document body (preamble macro definitions are skipped) and ignores commented-out macro calls — old bullets kept as `%` comments never become editable slots.

Any other layout → stop with the script error and suggest `/career-ops latex` (cv.md → career-ops template).

## Source file resolution

**Implemented in `extract-latex-content.mjs` (`resolveLatexSource`) — run it with
no path argument and it resolves the source itself.** This used to be prose here
and nothing else, so `latex.source` was honoured only when whoever drove the mode
remembered to read the profile; a user pointing at `data/main.tex` silently got
their file ignored.

```bash
node extract-latex-content.mjs --out /tmp/cv-slots-{company}.json
```

Order:

1. `config/profile.yml → latex.source` if set (resolved relative to the project
   root, so it means the same thing from any working directory)
2. Else `resume.tex` in project root
3. Else `cv.tex` in project root

A configured path that does not exist is reported as **missing** and stops the
run — it never falls through to a filename default, because tailoring the wrong
document silently is worse than stopping.

If nothing resolves, stop and ask the user to add their `.tex` file or set
`latex.source`.

```yaml
# config/profile.yml (optional, user layer)
latex:
  source: resume.tex
```

## Pipeline

1. Resolve source `.tex` path (see above)
2. Run: `node extract-latex-content.mjs <source.tex> --out /tmp/cv-slots-{company}.json`
3. If `supported: false` → show `error` + `hint`; do not proceed
4. Read JD (from context, report, or ask user)
5. Tailor **only** the `slots[].text` values for JD fit (same ethics as `modes/latex.md` / `pdf`):
   - Extract 15–20 JD keywords
   - Reorder bullets by relevance (reorder patch list order if needed; patch ids stay stable)
   - Inject keywords into existing achievements — **NEVER invent skills**
   - If `cv.md` exists, cross-check claims against it; omit anything not backed by in-scope sources
6. Write patches file:

```json
{
  "slots": [ "... copy from extract manifest ..." ],
  "patches": [
    { "id": "bullet-0", "text": "Tailored plain-text bullet (no LaTeX escaping — the script escapes)" }
  ]
}
```

7. Run: `node patch-latex-content.mjs <source.tex> /tmp/cv-patches-{company}.json output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex`
8. Run: `node generate-latex.mjs output/cv-{candidate}-{company}-{YYYY-MM-DD}.tex output/cv-{candidate}-{company}-{YYYY-MM-DD}.pdf --compile-only`
9. Report: family, slot count, patched count, `.tex` path, `.pdf` path (or compile error)

**Requires:** `tectonic` or `pdflatex` on PATH (same as `latex` mode).

## Ethical rules (mandatory)

Same as `modes/latex.md` and `modes/pdf.md`:

- Keywords get **reformulated, never fabricated**
- Never add tools, skills, or metrics the candidate does not already have in the source `.tex` or `cv.md`
- Preserve inline LaTeX markup inside bullets when possible; when rewriting, output **plain text** in patch JSON (the patch script escapes special characters)
- Do **not** rewrite preamble, macro definitions, section titles, dates, company names, or job titles unless the user explicitly asks

## What this mode does NOT do

- Does not replace `cv.md` as the system source of truth
- Does not parse arbitrary LaTeX templates
- Does not auto-run during auto-pipeline or evaluation
- Does not submit applications

## Relationship to `latex` mode

| Mode | Input | Output |
|------|-------|--------|
| `latex` | `cv.md` | career-ops `templates/cv-template.tex` (main.tex design) → `.tex` + PDF |
| `latex-tex` | user's `resume.tex` (any supported family, incl. main.tex-style) | same template shape, tailored prose only → `.tex` + PDF |
