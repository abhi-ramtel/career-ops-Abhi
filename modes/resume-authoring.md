# Resume Authoring Rules

Canonical rules for producing tailored CV/résumé content. `modes/pdf.md`,
`modes/latex.md`, `modes/latex-tex.md` and `modes/batch.md` all defer to this
file — change a rule here, not in four places.

Ported from `mcp-overleaf-server` (`src/prompts.ts`, `src/core/pipeline.ts` →
`measureDensity`, `templates/AUTHORING.md`), which is where these rules were
worked out. The implementation side lives in `resume-density.mjs`,
`build-cv-latex.mjs` and `verify-cv-facts.mjs`.

---

## 1. Truthfulness beats keyword matching

The only permitted operations on source content are **reorder, rewrite,
shorten, merge, drop, emphasize**. Never invent.

Specifically forbidden, regardless of how well it would match the JD:

- An employer, client, team, or institution not in `cv.md`
- A job title the candidate did not hold
- A project the candidate did not build
- Any number, percentage, scale figure, or date not in the source
- A skill the candidate has not claimed
- **Authorship of a tool the candidate merely used.** "Uses Modal" is not
  "built Modal". This is the single most common fabrication pattern and it is
  the one a reviewer is most likely to catch.

If a JD asks for something the source does not support, the résumé goes
without it. Silence on a topic is fine; manufactured detail is not.

**Every bullet and entry must trace to a source.** In the Overleaf server this
is a literal `sourceId` on each item. Here it is enforced two ways:

- `build-cv-latex.mjs` runs an entity-provenance check and warns when an
  employer, title, project name, institution, date, or skill in the payload
  does not appear in `cv.md`.
- `verify-cv-facts.mjs` gates claims and metrics in the rendered `.tex`.

A provenance warning is a **prompt to verify, not a blocker** — a legitimate
rewording ("Software Engineer Intern" for cv.md's "Software Engineer") fires it
too. Read every warning and confirm the entity is real before sending. Do not
suppress them.

---

## 2. Fill the page naturally

The résumé must fit exactly one page **and fill it**. A one-page CV with a
blank lower third is a worse document than a full one, and it is what you get
by cutting pre-emptively.

**Target density**, whenever `cv.md` supplies the evidence:

| Section | Entries | Bullets each |
|---|---|---|
| Experience | 4 | 3 |
| Projects | 3 | 3 |
| | | **≈21 bullets total** |

Targets are **capped by the master CV**. With two roles on file, two roles is
complete — not thin. `measureDensity` in `resume-density.mjs` computes the cap
and the `underFilled` verdict; it never asks for evidence that does not exist.

Rules, in priority order:

1. **Start at the target.** Begin with four relevant roles and three relevant
   projects, three sourced bullets each. Do not start lean and add later.
2. **Do not drop a role or project merely because it is not the single best
   match.** Relevance orders the content; it does not delete it.
3. **Do not cut because the résumé "seems likely" to overflow.** Only trim
   after an actual render reports 2+ pages.
4. **Never shrink type or margins to fit.** The template's scale and margins
   are fixed design. `--fit-pages` scales only to a readable floor (~0.68) and
   then reports honestly rather than lying about the fit. Adjust *evidence*,
   not point size.
5. **Under-filled means add, not stretch.** On `⚠️ PAGE IS UNDER-FILLED`, add
   sourced detail or another relevant entry from `cv.md` and render again.
   Padding an existing bullet with adjectives is not adding evidence.
6. **Match the template's compactness, not merely a one-page count.**

---

## 3. Skills stay close to the master

Keep top-level skill **category labels** and **items** close to `cv.md`. Do not
invent JD-derived labels ("GenAI Orchestration") or add skills because the
posting names them. Reordering categories and items to lead with what the JD
asks for is exactly right; inventing them is fabrication.

---

## 4. Validate the render, never the draft

Page count and density both come from the real compiled artifact. An estimate
from the markdown or the `.tex` source is not a check.

```bash
# HTML path
node resume-density.mjs output/cv-{company}-{role}.html

# LaTeX path — validates macros, compiles, reports pages + underfill
node generate-latex.mjs output/cv-{company}-{role}.tex
```

Revise and re-render on any of: provenance warnings, more than one page, or
`PAGE IS UNDER-FILLED`.

---

## 5. Templates

| Name | File | Design |
|---|---|---|
| `standard` (default) | `templates/cv-template.tex` | Charter 10.5pt, accent section rules, tight spacing. From the candidate's own `data/main.tex`. |
| `overleaf` | `templates/cv-template.overleaf.tex` | sb2nov lineage ported from `mcp-overleaf-server`. `\scshape` section rules, letterpaper 11pt. |

```bash
node build-cv-latex.mjs payload.json out.tex --template=overleaf
```

Both keep `\pdfgentounicode=1` and `\input{glyphtounicode}`, single column, no
text in images, standard section titles — the things that make the PDF
machine-readable. Do not remove them.

Authoring notes for the ported template, including its placeholder and macro
contract, are in `templates/AUTHORING-overleaf.md`.

**Do not pre-escape content.** `build-cv-latex.mjs` LaTeX-escapes
(`& % $ # _ { } ~ ^`) and ATS-normalizes (em-dash → `-`, smart quotes →
straight) everything it renders. Write `cv.md` naturally.

---

## 6. Cover letters

3–4 tight paragraphs, drawn only from `cv.md` and `article-digest.md`:

1. Why this company and this role specifically — using details from the actual
   posting, not generic praise.
2. The strongest proof from real experience.
3. A brief close.

No invented employers, projects, or figures. Across a batch, reuse the same
proof points for similar roles and vary only the company-specific opening —
rewriting the evidence per letter invites drift away from the source.

---

## 7. Application questions

Application-portal questions are answered **in chat or in the application
answers file — never inside the résumé or the letter**.

First person, grounded only in `cv.md`, referencing the specific company and
role. If a question cannot be answered truthfully from the source, say so and
say what you would need from the candidate.

Free-text answers additionally run through the humanizing pass — see
`modes/apply.md` § Humanized answers and `modes/_writing.md`.
