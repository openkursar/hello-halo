---
name: xlsx
description: "Work with Excel spreadsheets. Use whenever a spreadsheet file (.xlsx, .csv, .tsv) is the input or the deliverable: reading or summarizing workbook contents, editing cells/formulas/formatting in an existing file, creating a new spreadsheet from data or from scratch, cleaning messy tabular data into a proper workbook, or converting between tabular formats. Trigger on any mention of Excel, spreadsheet, workbook, or an .xlsx/.csv file path. Do NOT use when the deliverable is a Word document, PDF report, or chart image."
version: 1.1.0
---

# Excel Spreadsheets

All spreadsheet work is done by writing Node scripts and running them with `halo-node script.cjs`. The `exceljs` library is preloaded — `require('exceljs')` works directly. Never run `npm install`. Script paths below are relative to this skill's directory.

| Task | Approach |
|---|---|
| Inspect / read | `halo-node scripts/inspect-xlsx.cjs file.xlsx` (run with `--help` for options) |
| Create new file | Write an exceljs script — see rules below and `references/recipes.md` |
| Edit existing file | exceljs `readFile` → modify → `writeFile` — read Preservation limits first |
| Huge files (100k+ rows) | Streaming API — see `references/recipes.md` §Large files |
| CSV in / out | `workbook.csv.readFile` / `writeFile`, or plain `fs` for simple cases |

## The formula rule (critical)

This environment has **no recalculation engine** — no Excel, no LibreOffice. A formula cell written without a cached result displays as blank or 0 in most viewers and previews until the user opens it in Excel. Therefore:

1. **Always write formulas as `{ formula, result }` pairs**, computing the result yourself in the same script:

```js
const data = [10, 32];
ws.getCell('B4').value = { formula: 'SUM(B2:B3)', result: data.reduce((a, b) => a + b, 0) };
```

2. **Still use real formulas, never bake in plain numbers** where a formula belongs — the workbook must recalculate correctly when the user later changes inputs in Excel.
3. When you **edit input cells of an existing model**, cached results of dependent formulas go stale. Recompute and update `result` for every dependent cell you can, and tell the user which formulas will refresh only when opened in Excel.
4. Verify your formula strings by re-reading the saved file with `inspect-xlsx.cjs --formulas` — a typo in a formula string is silent at write time.

Prefer widely-supported functions (`SUM`, `SUMIFS`, `INDEX`/`MATCH`, `IFERROR`, `SUMPRODUCT`). Avoid dynamic-array functions (`XLOOKUP`, `FILTER`, `SORT`, `UNIQUE`) — sort/filter/deduplicate in JavaScript before writing cells instead.

## exceljs gotchas (verified)

- **Reading cell values**: `cell.value` may be a primitive, a `Date`, or an object — `{ formula, result }`, `{ richText: [...] }`, `{ text, hyperlink }`, or `{ error }`. Use `cell.text` for a display string, `cell.formula` / `cell.result` for formula parts. `inspect-xlsx.cjs` handles all shapes.
- **Dates**: write a JS `Date` and set `cell.numFmt = 'yyyy-mm-dd'` (or another date format). Without a numFmt the user sees a raw serial number. Construct with `Date.UTC(...)` to avoid timezone off-by-one-day errors.
- **Percentages**: store the fraction (`0.153`) with `numFmt: '0.0%'` → renders 15.3%. Storing `15.3` renders 1530%.
- **Currency**: `numFmt: '$#,##0.00'` (or `'#,##0'` with the unit named in the header).
- **Merged cells**: `ws.mergeCells('B1:D1')`, then write the top-left anchor. Writing any other cell of the range silently redirects to the anchor — always address the anchor to keep code readable.
- **Column widths are in characters**, not pixels: `ws.getColumn(1).width = 18`. Set them explicitly — there is no auto-fit.
- **Freeze panes**: `ws.views = [{ state: 'frozen', ySplit: 1 }]` freezes row 1 (`xSplit` for columns).
- **1-based indexing** everywhere: `getRow(1)` is the first row, `getColumn(1)` is column A.
- **Row insertion does not rewrite formula references.** After `spliceRows` / `insertRow`, formulas that pointed below the insertion still point at their old row numbers. Prefer rebuilding the affected formula strings yourself after structural edits.

## Preservation limits when editing existing files

exceljs round-trips cell values, formulas, number formats, fonts, fills, borders, merges, column widths, and freeze panes faithfully (verified). It does **not** preserve: charts, pivot tables, slicers, VBA macros (.xlsm), and some conditional-formatting/data-validation edge cases — these are silently dropped on save.

Before editing an existing file, check for those parts: `halo-node scripts/inspect-xlsx.cjs file.xlsx --parts` lists the OOXML parts; the output warns if charts/pivots/macros are present. If they are, do not re-save with exceljs. Tell the user: "This workbook contains charts/pivot tables/macros that my editing library would destroy. I can (a) produce an edited copy without them, (b) create a separate new sheet/file with the changes, or (c) give you exact cell values to paste in manually." Let the user choose.

## Quality bar for every workbook you produce

"No styling requirements" from the user means "deliver the designed default", never "leave it unstyled". Apply the standard treatment from `references/recipes.md` §Default table aesthetics to every data table:

- Header row: accent fill + white bold text; freeze the header row always; sensible column widths (no `####`).
- Body: zebra row tint (tables ≥ 5 rows), light gray grid inside, strong accent border on header and table bottom; bold total rows.
- Every number carries an appropriate `numFmt`; units named in headers (`Revenue ($k)`).
- Follow the user's spec literally — exact sheet names, exact headers, the formulas they asked for.
- Note assumptions in a labeled cell near the data, not silently.
- After saving, **verify**: re-read the file with `inspect-xlsx.cjs` and confirm the numbers, formulas, and layout you intended actually landed.

## Boundaries — say so, offer the alternative

- **Legacy `.xls` cannot be read or written.** Ask the user to re-save it as `.xlsx` in Excel, or provide the data another way.
- **`.xlsm` macros are destroyed on save.** Offer output as `.xlsx`, or values-to-paste.
- **No formula evaluation**: you cannot compute what an arbitrary existing formula would produce — only read the cached result from the last save.
- **No chart creation.** Offer: build the data table ready for a chart, and tell the user how to insert the chart in Excel (or render a chart image separately if a chart picture is acceptable).

For style/formatting recipes, large-file streaming, and CSV details, read `references/recipes.md`.
