# Editing existing .pptx via OOXML

pptxgenjs cannot open files, so edits work on the XML inside the ZIP using `scripts/ooxml.cjs` (unpack/pack/cat/validate) and `scripts/pptx-replace.cjs` (text). Every script prints usage with `--help`.

## Package anatomy

| Part | Content |
|---|---|
| `ppt/presentation.xml` | Deck-level: slide order lives in `<p:sldIdLst>` |
| `ppt/_rels/presentation.xml.rels` | Maps each `<p:sldId r:id>` to a slide part |
| `ppt/slides/slideN.xml` | One slide's shapes and text |
| `ppt/slides/_rels/slideN.xml.rels` | That slide's images, layout, notes links |
| `ppt/slideLayouts/`, `ppt/slideMasters/` | Inherited placeholder geometry and theme |
| `ppt/notesSlides/` | Speaker notes |
| `ppt/media/` | Images |
| `ppt/theme/theme1.xml` | Color scheme and fonts |

Slide text structure: `<p:sp>` (shape) → `<p:txBody>` → `<a:p>` (paragraph) → `<a:r>` (run) → `<a:t>` (text). File numbering ≠ deck order: always resolve order via `pptx-outline.cjs` (it reads `<p:sldIdLst>`).

## Text edits

Use `pptx-replace.cjs` for all text substitution — PowerPoint fragments runs exactly like Word, so raw string search misses visible phrases. It matches across runs within a paragraph, keeps the first run's formatting, and refuses to overwrite its input (`-o` required).

Hand-editing `<a:t>` directly is fine for text you located with `ooxml.cjs cat`; escape `& < >` and never pretty-print the XML.

Text that must keep leading/trailing spaces across a run boundary is stored as-is in `<a:t>` — DrawingML preserves spaces without `xml:space`.

## Reordering and deleting slides

1. `ooxml.cjs unpack deck.pptx work/`
2. Edit `work/ppt/presentation.xml`: reorder or remove `<p:sldId>` entries in `<p:sldIdLst>`.
3. Deletion only: also delete the slide part, its `_rels` file, and its entry in `work/ppt/_rels/presentation.xml.rels` and `[Content_Types].xml`. (Leaving orphan parts technically survives validation but bloats the file and confuses later edits — clean all four touchpoints.)
4. `ooxml.cjs pack work/ out.pptx && ooxml.cjs validate out.pptx`

## Duplicating a slide (the safe way to "add" one)

A new slide needs five registrations; copying an existing slide and re-texting it is far safer than authoring XML from scratch:

1. Copy `ppt/slides/slideN.xml` → `slideM.xml` (M = max existing + 1) and `ppt/slides/_rels/slideN.xml.rels` → `slideM.xml.rels`.
2. In the copied `.rels`, keep the layout reference; drop the notes-slide relationship (or copy the notes part too).
3. Add `<Override PartName="/ppt/slides/slideM.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>` to `[Content_Types].xml`.
4. Add `<Relationship Id="rIdNEW" Type=".../slide" Target="slides/slideM.xml"/>` to `ppt/_rels/presentation.xml.rels` (pick an unused `rId`).
5. Add `<p:sldId id="NNN" r:id="rIdNEW"/>` to `<p:sldIdLst>` at the desired position (`id` must be unique, ≥ 256).

Then edit the copy's text. A duplicated slide still **shares** any chart/embedded parts with its source — editing the shared part changes both slides; duplicate those parts too if they must diverge. Always finish with `validate` (it catches a missed registration as a broken relationship).

## Replacing an image

Cheapest path: overwrite the media file. Find the image name via the slide's `.rels` (`Target="../media/image2.png"`), then replace `ppt/media/image2.png` with a new image of the **same format**. Dimensions on the slide stay fixed — match the aspect ratio or the new image appears stretched.

## Template filling

- Extract the template's text with `pptx-outline.cjs`, map your content onto its slides, then replace slot-by-slot with `pptx-replace.cjs` (exact placeholder strings, `--all` when a token repeats).
- If the template has more slots than you have items (4 team-member boxes, 3 members), delete the whole leftover group — its shape `<p:sp>` (and picture `<p:pic>`) elements — not just the text.
- Grep your final outline for leftover placeholders: `pptx-outline.cjs out.pptx | grep -iE 'lorem|xxx|todo|\[insert'`.
