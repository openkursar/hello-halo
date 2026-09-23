---
name: pptx
description: "Work with PowerPoint presentations. Use whenever a .pptx file is the input or the deliverable: creating a slide deck or pitch deck, reading/extracting text from a presentation, editing or updating slides in an existing deck, or filling a deck template. Trigger on any mention of 'slides', 'deck', 'presentation', 'PPT', or a .pptx file path — regardless of what the content will be used for afterward. Do NOT use when the deliverable is a document, spreadsheet, or PDF."
version: 1.1.1
---

# PowerPoint Presentations (.pptx)

A `.pptx` is a ZIP of XML parts; each slide is `ppt/slides/slideN.xml`. All work is done via Node scripts run with `halo-node`. Preloaded: `pptxgenjs` (create), `jszip` (raw OOXML). Never run `npm install`. Script paths are relative to this skill's directory; every script has `--help`.

| Task | Approach |
|---|---|
| Read a deck | `halo-node scripts/pptx-outline.cjs deck.pptx --notes` |
| Create a new deck | MANDATORY: read `references/design.md`, pick a design system, THEN write the pptxgenjs script per `references/creating.md` |
| Replace text in existing deck | `halo-node scripts/pptx-replace.cjs in.pptx "old" "new" -o out.pptx` |
| Structural edits / templates | Unpack → edit slide XML → repack — see `references/editing.md` |
| Validate any output | `halo-node scripts/ooxml.cjs validate out.pptx` |

pptxgenjs **cannot open existing files** — editing always goes through the OOXML path.

## Creating — the rules that prevent broken decks

Full pitfall list in `references/creating.md`; the ones that ruin files or slides:

- **Set layout before adding slides**: `pres.layout = 'LAYOUT_WIDE'` (13.33"×7.5"). The default is 10"×5.625" — content positioned for a 13.3" canvas silently falls off the right edge, because coordinates are written unclamped.
- **Positions are inches** (`x`, `y`, `w`, `h`), from the top-left. Track your own y-cursor; nothing auto-flows, and overflowing text does not grow boxes — it just overlaps whatever is below.
- **Colors are 6-hex without `#`** (`color: '1F4E79'`). Anything else (8-digit, names) is replaced with black and a console warning — watch script output for such warnings.
- **Bullets**: `bullet: true` per item with `breakLine: true` on every item except the last; never type a bullet character.
- **One `new pptxgen()` per output file.** Never share options objects between `add*` calls (the library mutates them in place).
- **Speaker notes**: `slide.addNotes('...')` — never a text box.
- **Verify after writing**: `ooxml.cjs validate` + `pptx-outline.cjs` to confirm text landed on the right slides.

## Design is mandatory — not opt-in

There is no "plain default pptxgenjs look" path. Before any slide code, read `references/design.md`, **pick ONE of its five named design systems** by topic (深空商务 / 浅色极简 / 活力提案 / 高端质感 / 科技蓝), and execute that system's full spec — palette, typography, title-slide recipe, content skeletons, shape language — consistently on every slide. "No styling requirements" from the user means "deliver the aesthetic-best choice", never "use defaults". For Chinese decks also apply the reference's CJK typography section (微软雅黑, line-height, size steps). If the user names a brand/style, adapt the nearest system to it; keep the system's discipline.

## Editing existing decks

For pure text substitution, `pptx-replace.cjs` handles PowerPoint's run fragmentation (visible phrases split across `<a:r>` runs) and preserves formatting. For anything structural — adding slides, deleting slides, images — read `references/editing.md`; slide addition requires bookkeeping in three files and the reference walks through it.

Read first, then edit: `pptx-outline.cjs` prints each slide's part name (`ppt/slides/slideN.xml`) so you can target the right file. **Deck order does not always equal file numbering** — trust the outline, not the filenames.

## Boundaries — say so, offer the alternative

- **Legacy `.ppt` cannot be read or written.** Ask the user to re-save as .pptx, or provide the content; offer to rebuild as a new .pptx.
- **No visual rendering here** — verification is text extraction + XML validation, not screenshots. Layout defects (overlap, overflow) must be prevented by disciplined coordinate math; state this honestly if the user asks for pixel-exact review, and suggest they eyeball the deck once in PowerPoint/WPS.
- **Charts**: `addChart` works for standard types (bar/line/pie), but two configurations corrupt files — see the chart section of `references/creating.md` and stay inside its tested envelope. For exotic chart types, use data-driven shapes or a pre-rendered image instead. Chart output is validated structurally here, not visually — when delivering a deck with charts, tell the user to open the chart slides in PowerPoint/WPS once to confirm they render.
- **Template fidelity**: filling a designed template preserves its look only via the OOXML path (edit text in place). Rebuilding a designed template from scratch in pptxgenjs loses its design — say so rather than approximating silently.
