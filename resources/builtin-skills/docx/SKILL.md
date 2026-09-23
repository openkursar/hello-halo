---
name: docx
description: "Work with Microsoft Word documents. Use whenever a .docx file is the input or the deliverable: reading or summarizing a Word document, creating a report/memo/letter/contract as a .docx, editing text in an existing .docx (find-and-replace, filling a template), or converting content into a polished Word document. Trigger on any mention of 'Word document', '.docx', or a deliverable that should open in Word. Do NOT use for PDFs, spreadsheets, or plain-text/markdown deliverables."
version: 1.1.1
---

# Word Documents (.docx)

A `.docx` is a ZIP of XML parts; the body lives in `word/document.xml`. All work is done by writing Node scripts run with `halo-node`. Preloaded libraries: `docx` (create), `mammoth` (read), `jszip` (raw OOXML). Never run `npm install`. Script paths are relative to this skill's directory.

| Task | Approach |
|---|---|
| Read content | `halo-node scripts/read-docx.cjs file.docx` (`--html` when it has tables) |
| Create new document | MANDATORY: read `references/design.md`, THEN write the `docx` script per `references/creating.md` |
| Replace text in existing file | `halo-node scripts/docx-replace.cjs in.docx "old" "new" -o out.docx` |
| Other edits to existing file | Unpack → edit `word/document.xml` → repack — see `references/editing.md` |
| Inspect raw XML | `halo-node scripts/ooxml.cjs cat file.docx word/document.xml` |

The `docx` library **cannot open existing files** — it only creates. Editing therefore always goes through the OOXML path. Every script has `--help`.

## Creating — essentials (details in `references/creating.md`)

```js
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const doc = new Document({ sections: [{ children: [
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Title')] }),
  new Paragraph({ children: [new TextRun({ text: 'Body.', size: 24 })] }), // size = half-points
]}]});
require('fs').writeFileSync('out.docx', await Packer.toBuffer(doc));
```

Non-obvious rules that prevent broken output:

- **Default page size is A4.** For US Letter: `properties: { page: { size: { width: 12240, height: 15840 } } }` (DXA units, 1440 per inch).
- **Never put `\n` in a TextRun** — one `Paragraph` per line. Page breaks are a `PageBreak` child *inside* a `Paragraph`.
- **Bullets/numbering need a `numbering` config** on the Document; never type a literal bullet character. See `references/creating.md`.
- **Tables**: set `columnWidths` on the Table AND a DXA `width` on every cell.
- **Font sizes are half-points** (`size: 24` = 12pt); indents and page geometry are DXA.
- **Images**: `ImageRun` requires an explicit `type` (`'png'`, `'jpg'`) plus width/height in `transformation`.

## Design is the default — not opt-in

When the user gives no styling requirements, that means "deliver a designed professional document", never "library defaults". Before writing any create script, read `references/design.md` and apply its standard: theme constants (one accent color), wider side margins, the heading hierarchy with explicit run colors/spacing, styled tables (accent header row, no default black grid), a cover page for reports, and the CJK font-pairing conventions for Chinese documents. Default headings/tables from the `docx` library render as an obviously unstyled draft — that output is not acceptable as a deliverable.

## Editing — essentials (details in `references/editing.md`)

Word fragments visible text across many `<w:r>` runs, so a phrase you can read often does not exist as a contiguous string in the XML. `docx-replace.cjs` handles this — it matches across run boundaries within a paragraph and keeps the first run's formatting. Use it for all text substitution, including template filling (`--all` for every occurrence, `--part word/header1.xml` for headers/footers).

For structural edits (add/remove paragraphs, restyle) work on the unpacked XML:

```
halo-node scripts/ooxml.cjs unpack in.docx work/
# edit work/word/document.xml — copy an existing sibling element as your template
halo-node scripts/ooxml.cjs pack work/ out.docx
halo-node scripts/ooxml.cjs validate out.docx
```

Never pretty-print or reformat the XML — whitespace between `<w:t>` tags is content. Text with leading/trailing spaces needs `xml:space="preserve"` on its `<w:t>`.

## Verification loop (required)

After every create or edit:
1. `halo-node scripts/ooxml.cjs validate out.docx` — zip integrity, XML well-formedness, relationship resolution.
2. `halo-node scripts/read-docx.cjs out.docx` — read the extracted content and confirm the text, order, and headings are what you intended. For templates, grep the output for leftover placeholders (`TODO`, `[insert`, `XXX`, `lorem`).

There is no visual renderer here — text extraction plus XML validation is the verification standard. Say so if the user asks about visual fidelity.

## Boundaries — say so, offer the alternative

- **Legacy `.doc` cannot be read or written.** Tell the user: "I can't open the old .doc format — please re-save it as .docx in Word, or paste the text; I can then produce a proper .docx."
- **Track changes**: cannot accept/reject revisions or author tracked edits. Offer a clean edited copy instead, with a summary of what changed.
- **Comments** cannot be added or read reliably. Offer inline bracketed notes or a separate notes section.
- **No visual preview**: layout is verified structurally, not by rendering. For pixel-accurate review the user must open the file in Word/WPS.
- Mammoth intentionally drops most styling when reading (it extracts semantic structure). Do not infer "the document is unstyled" from its output — check the XML if styling matters.
