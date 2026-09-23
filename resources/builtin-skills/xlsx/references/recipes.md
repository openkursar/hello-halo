# exceljs recipes

Verified patterns for common spreadsheet work. `const ExcelJS = require('exceljs')` — all snippets assume a `Workbook`/`Worksheet` in scope.

## Skeleton

```js
const ExcelJS = require('exceljs');

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Data');           // create
  // ... build content ...
  await wb.xlsx.writeFile('out.xlsx');
}
main().catch((err) => { console.error(err); process.exit(1); });
```

Editing: `await wb.xlsx.readFile('in.xlsx')` then `wb.getWorksheet('Name')` (or by 1-based index). Always write the output, then re-read it to verify.

## Rows and cells

```js
ws.addRow(['Item', 'Qty', 'Price']);            // appends as next row
ws.addRows([[...], [...]]);
ws.getCell('B2').value = 42;                    // A1 addressing
ws.getRow(2).getCell(3).value = 9.5;            // 1-based row/col addressing
ws.lastRow, ws.rowCount, ws.actualColumnCount   // extent info
ws.eachRow({ includeEmpty: false }, (row, n) => { ... });
```

`ws.columns = [{ header: 'Item', key: 'item', width: 20 }, ...]` lets you `ws.addRow({ item: 'A', qty: 2 })` by key — convenient for record data.

## Styling

```js
const cell = ws.getCell('A1');
cell.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
cell.border = { bottom: { style: 'thin', color: { argb: 'FF888888' } } };
cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
cell.numFmt = '#,##0.00';
```

- Colors are 8-hex **ARGB** strings (leading `FF` = opaque), no `#`.
- Style a whole header row: `ws.getRow(1).eachCell(c => { c.font = {...}; c.fill = {...}; })`.
- Number format cheat sheet: money `'$#,##0'` · two decimals `'#,##0.00'` · percent `'0.0%'` (store fractions) · date `'yyyy-mm-dd'` · negative in parens `'#,##0;(#,##0)'` · zeros as dash `'#,##0;(#,##0);"-"'`.

## Default table aesthetics — the standard treatment

Apply this to every data table you produce when the user gives no styling spec. It is what separates a deliverable from a raw dump. Theme: one accent color per workbook.

```js
const A = { accent: 'FF1F4E79', zebra: 'FFF2F6FA', border: 'FFD6DCE4', ink: 'FF24292F' };
const thin = { style: 'thin', color: { argb: A.border } };
const medium = { style: 'medium', color: { argb: A.accent } };

// header row: accent fill, white bold text, taller row
const head = ws.getRow(1);
head.height = 22;
head.eachCell((c) => {
  c.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 11 };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: A.accent } };
  c.alignment = { vertical: 'middle' };
  c.border = { top: medium, bottom: medium, left: thin, right: thin };
});

// body: zebra tint on even data rows, light grid, ink text
for (let r = 2; r <= ws.rowCount; r++) {
  ws.getRow(r).eachCell({ includeEmpty: true }, (c) => {
    c.font = { color: { argb: A.ink }, size: 11 };
    if (r % 2 === 0) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: A.zebra } };
    c.border = { top: thin, bottom: thin, left: thin, right: thin };
  });
}

// strong outline around the whole table (re-apply on the edge cells)
ws.getRow(ws.rowCount).eachCell({ includeEmpty: true }, (c) => { c.border = { ...c.border, bottom: medium }; });
```

Rules:

- **Freeze panes always** on data tables: `ws.views = [{ state: 'frozen', ySplit: 1 }]` (add `xSplit: 1` when the first column is labels).
- **Column widths**: `Math.min(60, maxLen + 2)` per column from the longest text you wrote; give numeric columns at least 12 so formatted numbers never render as `####`.
- **Number formats on every numeric column** — money/percent/date per the cheat sheet above; same decimal places down a column; numbers right-align by default, leave them that way.
- **Border discipline**: light grid (`thin`, light gray) inside, strong line (`medium`, accent) on the header edges and bottom of the table. Never heavy black grids everywhere.
- **Total rows**: bold, no zebra fill, `medium` top border — visually closes the table.
- Zebra only pays off on tables of ≥ 5 data rows; skip it for tiny tables.

## Layout

```js
ws.mergeCells('A1:D1');                          // write only A1 afterwards
ws.getColumn(2).width = 14;                      // characters, not px; no auto-fit
ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];  // freeze row 1 + col A
ws.autoFilter = 'A1:D1';                         // filter dropdowns on the header
ws.getRow(1).height = 22;
```

Rough auto-fit substitute: set each column's width to `Math.min(60, maxLen + 2)` where `maxLen` is the longest cell text you wrote in that column.

## Formulas (always with a computed result)

```js
const qty = [4, 7, 2];
qty.forEach((q, i) => ws.getCell(`B${i + 2}`).value = q);
ws.getCell('B5').value = {
  formula: 'SUM(B2:B4)',
  result: qty.reduce((a, b) => a + b, 0),
};
```

Cross-sheet references quote names containing spaces: `'Raw Data'!B2`. Reading back: `cell.formula`, `cell.result`; `cell.value` is the `{ formula, result }` object.

## Dates

```js
ws.getCell('A2').value = new Date(Date.UTC(2026, 0, 15));  // Jan 15 2026
ws.getCell('A2').numFmt = 'yyyy-mm-dd';
```

Use `Date.UTC` — local-time construction can land a day off after Excel's serial conversion. Reading: date cells come back as JS `Date` instances (`value instanceof Date`).

## Hyperlinks and rich text (read + write)

```js
ws.getCell('A1').value = { text: 'Docs', hyperlink: 'https://example.com' };
// reading: cell.value = { richText: [{ text, font }, ...] } for mixed-format cells;
// cell.text flattens any shape to a display string
```

## CSV

```js
await wb.csv.readFile('in.csv');                 // becomes worksheet 1
await wb.csv.writeFile('out.csv');               // writes the FIRST worksheet only
```

CSV loses all formatting/formulas by nature. For messy CSV (irregular rows, junk headers), read with plain `fs.readFileSync` + manual parsing, clean in JS, then write a proper .xlsx.

## Large files (100k+ rows)

The default API loads the whole workbook into memory. Beyond roughly 50–100k rows, switch to streaming:

```js
// Read
const rd = new ExcelJS.stream.xlsx.WorkbookReader('big.xlsx');
for await (const sheet of rd) {
  for await (const row of sheet) {
    // row.values is 1-based (index 0 unused)
  }
}

// Write
const wr = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: 'big.xlsx' });
const ws = wr.addWorksheet('Data');
for (const rec of records) ws.addRow(rec).commit();
ws.commit();
await wr.commit();
```

Streaming constraints: rows are visited in file order and cannot be revisited; styles must be set as rows are written; no merged-cell editing after commit. For a quick look at a big file, `inspect-xlsx.cjs` accepts `--max-rows` to cap output.

## Structural edits on existing sheets

`ws.spliceRows(start, deleteCount, ...newRows)` inserts/deletes rows, and `ws.insertRow(pos, values)` inserts one — but **formula strings elsewhere are not rewritten** to account for shifted rows. After any structural edit, re-derive affected formulas yourself (find them with `inspect-xlsx.cjs --formulas`). When in doubt, rebuild the sheet: read all data, transform in JS, write a fresh worksheet.
