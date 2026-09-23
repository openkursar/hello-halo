#!/usr/bin/env node
/*
 * inspect-xlsx.js — dump the contents of an .xlsx workbook for reading and edit planning.
 *
 * Usage:
 *   halo-node inspect-xlsx.js <file.xlsx>                     # sheet list + preview of each sheet
 *   halo-node inspect-xlsx.js <file.xlsx> --sheet "Name"      # one sheet, full grid
 *   halo-node inspect-xlsx.js <file.xlsx> --formulas          # only cells containing formulas
 *   halo-node inspect-xlsx.js <file.xlsx> --parts             # list OOXML parts; warns about charts/pivots/macros
 *   halo-node inspect-xlsx.js <file.xlsx> --json              # machine-readable output
 *   Options: --max-rows N (default 50 per sheet), --max-cols N (default 20)
 *
 * Output cells are shown with A1 coordinates so edits can be planned precisely.
 */

const path = require('path');

function parseArgs(argv) {
  const args = { maxRows: 50, maxCols: 20 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--sheet') args.sheet = argv[++i];
    else if (a === '--formulas') args.formulas = true;
    else if (a === '--parts') args.parts = true;
    else if (a === '--json') args.json = true;
    else if (a === '--max-rows') args.maxRows = parseInt(argv[++i], 10);
    else if (a === '--max-cols') args.maxCols = parseInt(argv[++i], 10);
    else rest.push(a);
  }
  args.file = rest[0];
  return args;
}

function usage() {
  const lines = require('fs').readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

function colLetter(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Normalize the many shapes of cell.value into { display, formula }
function readCell(cell) {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v.formula !== undefined || v.sharedFormula !== undefined) {
      return { display: v.result === undefined ? '' : String(v.result), formula: v.formula || `(shared:${v.sharedFormula})` };
    }
    if (v.richText) return { display: v.richText.map((r) => r.text).join('') };
    if (v.hyperlink) return { display: `${v.text} -> ${v.hyperlink}` };
    if (v.error) return { display: String(v.error) };
    if (v instanceof Date) return { display: v.toISOString().slice(0, 10) };
    return { display: JSON.stringify(v) };
  }
  return { display: String(v) };
}

async function listParts(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(require('fs').readFileSync(file));
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  const risky = [];
  if (names.some((n) => /^xl\/charts\//.test(n))) risky.push('charts');
  if (names.some((n) => /^xl\/pivotTables\//.test(n) || /^xl\/pivotCache\//.test(n))) risky.push('pivot tables');
  if (names.some((n) => /vbaProject\.bin$/.test(n))) risky.push('VBA macros');
  if (names.some((n) => /^xl\/slicers?\//.test(n))) risky.push('slicers');
  return { names, risky };
}

function sheetInfo(ws, args) {
  const rows = [];
  const formulas = [];
  const maxRow = Math.min(ws.rowCount, args.maxRows);
  ws.eachRow({ includeEmpty: false }, (row, rowNum) => {
    if (rowNum > maxRow) return;
    const cells = [];
    row.eachCell({ includeEmpty: false }, (cell, colNum) => {
      if (colNum > args.maxCols) return;
      const rc = readCell(cell);
      if (!rc) return;
      const addr = `${colLetter(colNum)}${rowNum}`;
      cells.push({ addr, ...rc, numFmt: cell.numFmt || undefined });
      if (rc.formula) formulas.push({ addr, formula: rc.formula, result: rc.display });
    });
    if (cells.length) rows.push({ row: rowNum, cells });
  });
  const merges = ws.model && ws.model.merges ? ws.model.merges : [];
  return { name: ws.name, rowCount: ws.rowCount, columnCount: ws.actualColumnCount, merges, rows, formulas, truncated: ws.rowCount > maxRow };
}

function printSheet(info, args) {
  console.log(`\n=== Sheet "${info.name}" — ${info.rowCount} rows x ${info.columnCount} cols${info.truncated ? ` (showing first ${args.maxRows} rows)` : ''} ===`);
  if (info.merges.length) console.log(`merged ranges: ${info.merges.join(', ')}`);
  if (args.formulas) {
    if (!info.formulas.length) { console.log('(no formulas)'); return; }
    for (const f of info.formulas) console.log(`${f.addr}: =${f.formula}  => ${f.result}`);
    return;
  }
  for (const r of info.rows) {
    const line = r.cells.map((c) => `${c.addr}=${c.formula ? `{=${c.formula} => ${c.display}}` : JSON.stringify(c.display)}`).join('  ');
    console.log(line);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.file) { usage(); process.exit(args.file ? 0 : 1); }
  const file = path.resolve(args.file);

  if (args.parts) {
    const { names, risky } = await listParts(file);
    if (args.json) { console.log(JSON.stringify({ parts: names, risky }, null, 2)); return; }
    names.forEach((n) => console.log(n));
    if (risky.length) console.log(`\nWARNING: workbook contains ${risky.join(', ')} — re-saving with exceljs will DESTROY these parts. Do not edit-and-save this file with exceljs.`);
    else console.log('\nNo charts/pivots/macros detected — safe to edit with exceljs.');
    return;
  }

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const sheets = args.sheet
    ? [wb.getWorksheet(args.sheet)].filter(Boolean)
    : wb.worksheets;
  if (args.sheet && !sheets.length) {
    console.error(`Sheet "${args.sheet}" not found. Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`);
    process.exit(1);
  }

  const infos = sheets.map((ws) => sheetInfo(ws, args));
  if (args.json) { console.log(JSON.stringify(infos, null, 2)); return; }
  console.log(`Workbook: ${file}`);
  console.log(`Sheets: ${wb.worksheets.map((w) => `"${w.name}" (${w.rowCount}r)`).join(', ')}`);
  infos.forEach((i) => printSheet(i, args));
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
