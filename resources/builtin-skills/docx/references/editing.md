# Editing existing .docx via OOXML

The `docx` library cannot open files, so edits work on the XML inside the ZIP. The tooling is `scripts/ooxml.cjs` (unpack/pack/cat/validate) and `scripts/docx-replace.cjs` (text substitution). Both print usage with `--help`.

## Package anatomy

| Part | Content |
|---|---|
| `word/document.xml` | The body — paragraphs, tables, runs |
| `word/styles.xml` | Style definitions referenced by `w:pStyle` / `w:rStyle` |
| `word/numbering.xml` | List definitions referenced by `w:numPr` |
| `word/header1.xml`, `footer1.xml`… | Headers/footers (numbering varies; `ooxml.cjs list` shows what exists) |
| `word/_rels/document.xml.rels` | Relationships: images, hyperlinks, headers |
| `word/media/*` | Embedded images |

Text structure: `<w:p>` (paragraph) → `<w:r>` (run: one formatting span) → `<w:t>` (text). Paragraph properties in `<w:pPr>`, run properties in `<w:rPr>`.

## The run-fragmentation problem

Word splits what looks like one phrase into many runs — spell-check markers, revision-save artifacts, and formatting boundaries all cut runs. `Total revenue` may be stored as `<w:t>Tot</w:t>…<w:t>al reve</w:t>…<w:t>nue</w:t>`. Consequences:

- Naive string search on the XML misses text that is visibly present. **Always use `docx-replace.cjs`** for text substitution — it concatenates run text per paragraph, matches across boundaries, writes the replacement into the first affected run (keeping its formatting), and empties the rest.
- When inspecting, read extracted text (`read-docx.cjs`) to know *what* the document says, and `ooxml.cjs cat` to see *how* it is stored before planning surgical edits.

## Safe editing rules

1. **Copy a sibling, then modify.** To add a paragraph/table row, duplicate an existing `<w:p>`/`<w:tr>` with the look you want and change its text — hand-built elements miss required properties.
2. **Never reformat or pretty-print** `document.xml`. Whitespace inside `<w:t>` is content; whitespace between elements can change rendering. Edit in place with minimal diffs.
3. **Escape text content**: `& < >` must be `&amp; &lt; &gt;` inside `<w:t>`.
4. **Leading/trailing spaces** in a `<w:t>` require `xml:space="preserve"` on that element or Word trims them.
5. **New relationships need three touches.** Adding an image/hyperlink means: the file in `word/media/`, an `<Relationship>` entry in `word/_rels/document.xml.rels` with a fresh `rId`, and (for new media types) a `<Default>`/`<Override>` in `[Content_Types].xml`. Missing any one corrupts the file. Prefer replacing an existing image's media file (same name, same format) — zero bookkeeping.
6. **Deleting a paragraph** means removing the whole `<w:p>…</w:p>` block. To merge two paragraphs, delete the first one's closing `</w:p>` and the second's opening `<w:p…>` *plus its `<w:pPr>`*.
7. After packing, **always** `ooxml.cjs validate out.docx`, then `read-docx.cjs out.docx` to confirm the text.

## Workflow

```
halo-node scripts/ooxml.cjs unpack contract.docx work/
halo-node scripts/ooxml.cjs cat contract.docx word/document.xml > /dev/null  # or read work/word/document.xml
# ... edit work/word/document.xml ...
halo-node scripts/ooxml.cjs pack work/ contract-edited.docx
halo-node scripts/ooxml.cjs validate contract-edited.docx
halo-node scripts/read-docx.cjs contract-edited.docx
```

For pure text substitution skip the unpack cycle entirely — `docx-replace.cjs` operates on the `.docx` directly and refuses to overwrite its input (always `-o`).

## Styling edits

- Change a run's formatting: edit its `<w:rPr>` — e.g. insert `<w:b/>` (bold), `<w:i/>`, `<w:color w:val="C00000"/>`, `<w:sz w:val="28"/>` (14pt; half-points).
- `<w:rPr>` must be the **first child** of `<w:r>`; `<w:pPr>` the first child of `<w:p>`. Order of properties inside is schema-constrained — when unsure, copy the property block from a run that already looks right.
- Document-wide style changes belong in `word/styles.xml` (edit the style's `<w:rPr>`), not in a thousand runs.
