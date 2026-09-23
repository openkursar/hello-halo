---
name: pdf
description: "Work with PDF files. Use whenever a .pdf is the input or the deliverable: reading or extracting text from a PDF, merging or splitting PDFs, rotating pages, adding watermarks, filling PDF forms, creating a new PDF, or inspecting a PDF's pages/metadata/form fields. Trigger on any mention of a .pdf file or a request to produce one. For scanned/image-only PDFs, this skill detects them and hands off to OCR."
version: 1.0.1
---

# PDF Files

All work is done via Node scripts run with `halo-node`. Preloaded libraries: `pdf-lib` (create/modify/forms) and `unpdf` (text extraction). Never run `npm install`. Script paths are relative to this skill's directory; every script has `--help`.

| Task | Approach |
|---|---|
| Read text | `halo-node scripts/pdf-extract-text.cjs file.pdf` (`--pages 2-5`, `--json`) |
| Inspect pages / metadata / form fields | `halo-node scripts/pdf-info.cjs file.pdf` |
| Merge / split / burst / rotate / watermark | `halo-node scripts/pdf-ops.cjs <cmd> ... -o out.pdf` |
| Fill a form | `pdf-info.cjs` to list fields, then a pdf-lib script — `references/forms.md` |
| Create a PDF | pdf-lib drawing script — `references/creating.md` |

## Reading

`pdf-extract-text.cjs` returns text per page. Pages reported as `[no text layer]` are scanned images — **do not** conclude the page is empty. Hand off to OCR: Halo has an `ocr` toolset; if its tools are not currently available, request them via the capability tool, or tell the user to enable OCR in the Tools menu. Text extraction order can differ from visual order in multi-column layouts — sanity-check extracted text against the user's description before analyzing it.

## Modifying

`pdf-ops.cjs` covers the standard operations (merge, keep-pages split, one-file-per-page burst, rotate, diagonal text watermark) — run it, don't rewrite it. For operations it doesn't cover (page reordering, stamping one PDF onto another, cropping), write a pdf-lib script; `references/creating.md` documents the coordinate system and the `copyPages` pattern.

pdf-lib rewrites the file on save: unusual features (JavaScript actions, digital signatures, tagged-PDF accessibility trees) may not survive. If `pdf-info.cjs` shows the file has a signature, warn the user that any modification invalidates it.

## Forms

1. `halo-node scripts/pdf-info.cjs form.pdf` — lists every field with name, type, current value, options.
2. Write a fill script per `references/forms.md` (exact field names from step 1).
3. Flatten only if the user wants a non-editable result — flattening is irreversible.
4. Verify: `pdf-info.cjs` on the output (values set) or `pdf-extract-text.cjs` (flattened text visible).

If `pdf-info.cjs` reports no form fields but the document *looks* like a form, it is a flat scan of a form — offer to overlay text at measured coordinates instead (`references/forms.md` §Flat forms).

## Creating

pdf-lib draws primitives at absolute coordinates — there is no layout engine, no automatic text wrapping, no HTML/Markdown rendering. `references/creating.md` provides the wrapping/pagination helpers. For a text-heavy multi-page report, consider whether the user actually needs PDF; a .docx (docx skill) gives better structure for the same effort. **Non-Latin text (Chinese/Japanese/Korean/Cyrillic) requires embedding a Unicode font** — the standard 14 fonts throw on it. A bundled Chinese font is provided: `$HALO_OFFICE_FONTS_DIR/NotoSansSC-Regular.otf` — use it whenever that env var is set; system fonts are the fallback. `references/creating.md` §Unicode has the lookup order and embed code.

## Boundaries — say so, offer the alternative

- **Scanned PDFs**: no text without OCR — use Halo's OCR toolset as above, then continue with the extracted text.
- **Encrypted PDFs**: cannot be opened; ask the user for the password (then `PDFDocument.load(bytes, { password })`) or a decrypted copy.
- **No visual rendering**: PDFs cannot be screenshotted here. Verification is text extraction + structural checks; for pixel-exact layout review the user must open the file.
- **Editing existing text in place** (rewording a paragraph inside an existing PDF) is not supported by design — PDF has no reflow. Offer: extract all text, produce a corrected new document (PDF or docx), or overlay/redact patches at specific coordinates for small fixes.
- **Tables**: extraction returns reading-order text, not table structure. Offer best-effort reconstruction, flagged as approximate; for reliable tables ask for the source spreadsheet.
