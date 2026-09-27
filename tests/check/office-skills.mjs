#!/usr/bin/env node
/**
 * Regression suite for the built-in Office document skills
 * (resources/builtin-skills/{xlsx,docx,pptx,pdf}).
 *
 * Exercises every major workflow each skill teaches, against the bundled
 * office runtime (resources/office-runtime/node_modules) — the same libs the
 * halo-node shim exposes to agents. One artifact per workflow is generated in
 * a temp dir and parsed back to prove round-trip integrity.
 *
 * Usage: node tests/check/office-skills.mjs
 * Exit 0 = all pass. Skipped checks (missing optional deps) are reported.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..')
const RUNTIME = path.join(ROOT, 'resources', 'office-runtime', 'node_modules')
const SKILLS = path.join(ROOT, 'resources', 'builtin-skills')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'office-skills-'))

if (!fs.existsSync(RUNTIME)) {
  console.error(`Bundled runtime missing: ${RUNTIME}\nRun: node scripts/prepare-office-runtime.mjs`)
  process.exit(1)
}

const results = []
let current = ''

function check(name, fn) {
  current = name
  try {
    fn()
    results.push({ name, status: 'pass' })
    console.log(`  PASS ${name}`)
  } catch (err) {
    if (err && err.skip) {
      results.push({ name, status: 'skip', reason: err.message })
      console.log(`  SKIP ${name} — ${err.message}`)
    } else {
      results.push({ name, status: 'fail', error: String(err.stack || err) })
      console.log(`  FAIL ${name}\n${String(err.stack || err).split('\n').map((l) => `       ${l}`).join('\n')}`)
    }
  }
}

const skip = (msg) => { const e = new Error(msg); e.skip = true; return e }
const assert = (cond, msg) => { if (!cond) throw new Error(`assertion failed: ${msg}`) }

// Run inline JS against the bundled runtime (CommonJS, like halo-node)
function runJs(code) {
  const file = path.join(TMP, `snippet-${Math.random().toString(36).slice(2)}.cjs`)
  fs.writeFileSync(file, code)
  return execFileSync(process.execPath, [file], {
    env: { ...process.env, NODE_PATH: RUNTIME },
    cwd: TMP,
    encoding: 'utf8',
  })
}

function runScript(skill, script, args, opts = {}) {
  return execFileSync(process.execPath, [path.join(SKILLS, skill, 'scripts', script), ...args], {
    env: { ...process.env, NODE_PATH: RUNTIME },
    cwd: TMP,
    encoding: 'utf8',
    ...opts,
  })
}

const p = (f) => path.join(TMP, f)

console.log(`office-skills regression — runtime: ${RUNTIME}\nartifacts: ${TMP}\n`)

// ---------- xlsx ----------
console.log('xlsx:')

check('xlsx: create with formulas, styles, dates, merge, freeze', () => {
  runJs(`
    const ExcelJS = require('exceljs');
    (async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Report');
      ws.mergeCells('A1:C1');
      ws.getCell('A1').value = 'Quarterly Summary';
      ws.getCell('A1').font = { bold: true, size: 14 };
      ws.addRow(['Item', 'Amount', 'Date']);
      ws.getRow(2).eachCell((c) => { c.font = { bold: true }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF4' } }; });
      const amounts = [120.5, 340.25, 89];
      amounts.forEach((a, i) => {
        ws.addRow(['Item ' + (i + 1), a, new Date(Date.UTC(2026, i, 15))]);
        ws.getCell('B' + (i + 3)).numFmt = '$#,##0.00';
        ws.getCell('C' + (i + 3)).numFmt = 'yyyy-mm-dd';
      });
      ws.getCell('B6').value = { formula: 'SUM(B3:B5)', result: amounts.reduce((x, y) => x + y, 0) };
      ws.getCell('B6').numFmt = '$#,##0.00';
      ws.getColumn(1).width = 16; ws.getColumn(2).width = 12; ws.getColumn(3).width = 12;
      ws.views = [{ state: 'frozen', ySplit: 2 }];
      await wb.xlsx.writeFile('report.xlsx');
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  assert(fs.existsSync(p('report.xlsx')), 'report.xlsx exists')
})

check('xlsx: inspect-xlsx.cjs reads values + formulas back', () => {
  const out = runScript('xlsx', 'inspect-xlsx.cjs', [p('report.xlsx')])
  assert(out.includes('Quarterly Summary'), 'merged title read back')
  assert(out.includes('549.75'), 'computed formula result read back')
  const f = runScript('xlsx', 'inspect-xlsx.cjs', [p('report.xlsx'), '--formulas'])
  assert(f.includes('SUM(B3:B5)'), 'formula string read back')
})

check('xlsx: edit existing preserves styles/formulas', () => {
  runJs(`
    const ExcelJS = require('exceljs');
    (async () => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile('report.xlsx');
      const ws = wb.getWorksheet('Report');
      ws.getCell('B3').value = 200.5;
      ws.getCell('B6').value = { formula: 'SUM(B3:B5)', result: 200.5 + 340.25 + 89 };
      await wb.xlsx.writeFile('report-edited.xlsx');
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.readFile('report-edited.xlsx');
      const w2 = wb2.getWorksheet('Report');
      if (w2.getCell('B6').formula !== 'SUM(B3:B5)') throw new Error('formula lost');
      if (w2.getCell('B6').result !== 629.75) throw new Error('result stale');
      if (!w2.getCell('A1').font || !w2.getCell('A1').font.bold) throw new Error('style lost');
      if (w2.getCell('B3').numFmt !== '$#,##0.00') throw new Error('numFmt lost');
      if (!w2.views.length || w2.views[0].state !== 'frozen') throw new Error('freeze lost');
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
})

check('xlsx: --parts risk detection', () => {
  const out = runScript('xlsx', 'inspect-xlsx.cjs', [p('report.xlsx'), '--parts'])
  assert(out.includes('safe to edit'), 'clean workbook reported safe')
})

// ---------- docx ----------
console.log('docx:')

check('docx: create with headings, bullets, table', () => {
  runJs(`
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, LevelFormat, AlignmentType,
            Table, TableRow, TableCell, WidthType } = require('docx');
    const fs = require('fs');
    (async () => {
      const cell = (t) => new TableCell({ width: { size: 4680, type: WidthType.DXA }, children: [new Paragraph(t)] });
      const doc = new Document({
        numbering: { config: [{ reference: 'b', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\\u2022', alignment: AlignmentType.LEFT }] }] },
        sections: [{
          properties: { page: { size: { width: 12240, height: 15840 } } },
          children: [
            new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Findings Report')] }),
            new Paragraph({ numbering: { reference: 'b', level: 0 }, children: [new TextRun('First finding')] }),
            new Paragraph({ numbering: { reference: 'b', level: 0 }, children: [new TextRun('Second finding')] }),
            new Table({ columnWidths: [4680, 4680], rows: [
              new TableRow({ children: [cell('Metric'), cell('Value')] }),
              new TableRow({ children: [cell('Total'), cell('42')] }),
            ]}),
          ],
        }],
      });
      fs.writeFileSync('report.docx', await Packer.toBuffer(doc));
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  assert(fs.existsSync(p('report.docx')), 'report.docx exists')
})

check('docx: read-docx.cjs extracts structure', () => {
  const out = runScript('docx', 'read-docx.cjs', [p('report.docx')])
  assert(out.includes('# Findings Report'), 'heading extracted as markdown')
  assert(out.includes('First finding'), 'bullet content extracted')
  const html = runScript('docx', 'read-docx.cjs', [p('report.docx'), '--html'])
  assert(html.includes('<table>'), 'table extracted in html mode')
})

check('docx: fragmented-run replacement', () => {
  // fragment 'First finding' across three runs, as Word does
  runJs(`
    const JSZip = require('jszip');
    const fs = require('fs');
    (async () => {
      const zip = await JSZip.loadAsync(fs.readFileSync('report.docx'));
      let xml = await zip.file('word/document.xml').async('string');
      const before = xml;
      xml = xml.replace(/<w:t[^>]*>First finding<\\/w:t>/,
        '<w:t>Fir</w:t></w:r><w:r><w:t>st find</w:t></w:r><w:r><w:t>ing</w:t>');
      if (xml === before) throw new Error('fragmentation setup failed');
      zip.file('word/document.xml', xml);
      fs.writeFileSync('frag.docx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  const out = runScript('docx', 'docx-replace.cjs', [p('frag.docx'), 'First finding', 'Replaced <finding> & verified', '-o', p('frag-out.docx')])
  assert(out.includes('1 replacement'), 'replacement reported')
  const text = runScript('docx', 'read-docx.cjs', [p('frag-out.docx')])
  assert(text.includes('Replaced <finding> & verified'), 'cross-run replacement + entity escaping round-trips')
})

check('docx: ooxml unpack/pack/validate round-trip', () => {
  runScript('docx', 'ooxml.cjs', ['unpack', p('report.docx'), p('unpacked')])
  runScript('docx', 'ooxml.cjs', ['pack', p('unpacked'), p('repacked.docx')])
  const out = runScript('docx', 'ooxml.cjs', ['validate', p('repacked.docx')])
  assert(out.includes('VALID'), 'repacked docx validates')
  const text = runScript('docx', 'read-docx.cjs', [p('repacked.docx')])
  assert(text.includes('Findings Report'), 'repacked content intact')
})

// ---------- pptx ----------
console.log('pptx:')

check('pptx: create deck (text, bullets, notes, table, shape, chart)', () => {
  runJs(`
    const pptxgen = require('pptxgenjs');
    (async () => {
      const pres = new pptxgen();
      pres.layout = 'LAYOUT_WIDE';
      const s1 = pres.addSlide();
      s1.addText('Quarterly Business Review', { x: 0.6, y: 0.5, w: 12.1, h: 1, fontSize: 40, bold: true, color: '1F2937' });
      s1.addNotes('Opening notes.');
      const s2 = pres.addSlide();
      s2.addText([
        { text: 'Revenue grew 18%', options: { bullet: true, breakLine: true } },
        { text: 'Costs held flat', options: { bullet: true } },
      ], { x: 0.6, y: 1.5, w: 5.8, h: 2, fontSize: 18 });
      s2.addShape(pres.ShapeType.roundRect, { x: 6.9, y: 1.5, w: 5.8, h: 2, fill: { color: 'F3F4F6' }, rectRadius: 0.08 });
      s2.addTable([[{ text: 'Q', options: { bold: true } }, { text: 'Rev', options: { bold: true } }], ['Q1', '10'], ['Q2', '14']],
        { x: 0.6, y: 4.0, w: 5.8, colW: [2.9, 2.9], fontSize: 12 });
      const s3 = pres.addSlide();
      s3.addChart(pres.ChartType.bar, [{ name: 'Revenue', labels: ['Q1', 'Q2', 'Q3'], values: [10, 14, 18] }], {
        x: 0.6, y: 1.2, w: 8, h: 4.5, showTitle: true, title: 'Revenue by Quarter',
        showValue: true, chartColors: ['1F4E79'], showLegend: false,
      });
      await pres.writeFile({ fileName: 'deck.pptx' });
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  assert(fs.existsSync(p('deck.pptx')), 'deck.pptx exists')
})

check('pptx: ooxml validate deck (incl. chart part rels)', () => {
  const out = runScript('pptx', 'ooxml.cjs', ['validate', p('deck.pptx')])
  assert(out.includes('VALID'), 'deck validates')
})

check('pptx: pptx-outline.cjs extracts slides in order + notes', () => {
  const out = runScript('pptx', 'pptx-outline.cjs', [p('deck.pptx'), '--notes'])
  assert(out.includes('3 slide(s)'), 'slide count')
  assert(out.indexOf('Quarterly Business Review') < out.indexOf('Revenue grew 18%'), 'deck order')
  assert(out.includes('Opening notes.'), 'speaker notes extracted')
})

check('pptx: fragmented-run replacement', () => {
  runJs(`
    const JSZip = require('jszip');
    const fs = require('fs');
    (async () => {
      const zip = await JSZip.loadAsync(fs.readFileSync('deck.pptx'));
      let xml = await zip.file('ppt/slides/slide2.xml').async('string');
      const before = xml;
      xml = xml.replace(/<a:t>Revenue grew 18%<\\/a:t>/,
        '<a:t>Reve</a:t></a:r><a:r><a:t>nue grew 1</a:t></a:r><a:r><a:t>8%</a:t>');
      if (xml === before) throw new Error('fragmentation setup failed');
      zip.file('ppt/slides/slide2.xml', xml);
      fs.writeFileSync('deck-frag.pptx', await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  const out = runScript('pptx', 'pptx-replace.cjs', [p('deck-frag.pptx'), 'Revenue grew 18%', 'Revenue grew 22% YoY', '-o', p('deck-out.pptx')])
  assert(out.includes('1 replacement'), 'replacement reported')
  const outline = runScript('pptx', 'pptx-outline.cjs', [p('deck-out.pptx')])
  assert(outline.includes('Revenue grew 22% YoY'), 'replacement visible in outline')
  const val = runScript('pptx', 'ooxml.cjs', ['validate', p('deck-out.pptx')])
  assert(val.includes('VALID'), 'edited deck validates')
})

// ---------- pdf ----------
console.log('pdf:')

check('pdf: create with wrapped text + extract back', () => {
  runJs(`
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const fs = require('fs');
    (async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([612, 792]);
      page.drawText('Annual Report 2026', { x: 72, y: 720, size: 24, font });
      page.drawText('Revenue was 42 million dollars.', { x: 72, y: 690, size: 12, font });
      page.drawLine({ start: { x: 72, y: 680 }, end: { x: 540, y: 680 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
      fs.writeFileSync('a.pdf', await doc.save());
      const doc2 = await PDFDocument.create();
      const f2 = await doc2.embedFont(StandardFonts.Helvetica);
      doc2.addPage([612, 792]).drawText('Second document page one.', { x: 72, y: 720, size: 12, font: f2 });
      fs.writeFileSync('b.pdf', await doc2.save());
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  const out = runScript('pdf', 'pdf-extract-text.cjs', [p('a.pdf')])
  assert(out.includes('Revenue was 42 million dollars.'), 'created text extracts back')
})

check('pdf: merge / split / rotate / watermark / burst via pdf-ops.cjs', () => {
  runScript('pdf', 'pdf-ops.cjs', ['merge', p('a.pdf'), p('b.pdf'), '-o', p('m.pdf')])
  const info = runScript('pdf', 'pdf-info.cjs', [p('m.pdf')])
  assert(info.includes('Pages: 2'), 'merge produced 2 pages')
  runScript('pdf', 'pdf-ops.cjs', ['split', p('m.pdf'), '--pages', '2', '-o', p('s.pdf')])
  const stext = runScript('pdf', 'pdf-extract-text.cjs', [p('s.pdf')])
  assert(stext.includes('Second document'), 'split kept the right page')
  runScript('pdf', 'pdf-ops.cjs', ['rotate', p('m.pdf'), '--degrees', '90', '--pages', '1', '-o', p('r.pdf')])
  runScript('pdf', 'pdf-ops.cjs', ['watermark', p('m.pdf'), '--text', 'DRAFT', '-o', p('w.pdf')])
  const wtext = runScript('pdf', 'pdf-extract-text.cjs', [p('w.pdf')])
  assert(wtext.includes('DRAFT'), 'watermark text present')
  runScript('pdf', 'pdf-ops.cjs', ['burst', p('m.pdf'), '-o', p('part')])
  assert(fs.existsSync(p('part-001.pdf')) && fs.existsSync(p('part-002.pdf')), 'burst wrote per-page files')
})

check('pdf: form create → pdf-info lists fields → fill → flatten', () => {
  runJs(`
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const fs = require('fs');
    (async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.drawText('Name:', { x: 50, y: 700, size: 12, font });
      const form = doc.getForm();
      const name = form.createTextField('applicant.name');
      name.addToPage(page, { x: 120, y: 690, width: 200, height: 20 });
      const agree = form.createCheckBox('applicant.agree');
      agree.addToPage(page, { x: 50, y: 650, width: 15, height: 15 });
      fs.writeFileSync('form.pdf', await doc.save());
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  const info = runScript('pdf', 'pdf-info.cjs', [p('form.pdf')])
  assert(info.includes('"applicant.name"'), 'field listed by name')
  runJs(`
    const { PDFDocument } = require('pdf-lib');
    const fs = require('fs');
    (async () => {
      const doc = await PDFDocument.load(fs.readFileSync('form.pdf'));
      const form = doc.getForm();
      form.getTextField('applicant.name').setText('Ada Lovelace');
      form.getCheckBox('applicant.agree').check();
      form.flatten();
      fs.writeFileSync('form-filled.pdf', await doc.save());
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  const text = runScript('pdf', 'pdf-extract-text.cjs', [p('form-filled.pdf')])
  assert(text.includes('Ada Lovelace'), 'flattened value extractable')
})

check('pdf: CJK creation via fontkit (bundled Noto first, system TTF fallback)', () => {
  if (!fs.existsSync(path.join(RUNTIME, '@pdf-lib', 'fontkit'))) {
    throw skip('@pdf-lib/fontkit not in bundled runtime yet')
  }
  const candidates = [
    // bundled font contract: HALO_OFFICE_FONTS_DIR env var, else fonts/ sibling of node_modules
    process.env.HALO_OFFICE_FONTS_DIR && path.join(process.env.HALO_OFFICE_FONTS_DIR, 'NotoSansSC-Regular.otf'),
    path.join(RUNTIME, '..', 'fonts', 'NotoSansSC-Regular.otf'),
    '/Library/Fonts/Arial Unicode.ttf',
    'C:\\Windows\\Fonts\\simhei.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-SC-Regular.otf',
  ].filter((f) => f && fs.existsSync(f))
  if (!candidates.length) throw skip('no bundled or system Unicode font found')
  runJs(`
    const { PDFDocument } = require('pdf-lib');
    const fontkit = require('@pdf-lib/fontkit');
    const fs = require('fs');
    (async () => {
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(fs.readFileSync(${JSON.stringify(candidates[0])}), { subset: true });
      doc.addPage([612, 792]).drawText('\\u4e2d\\u6587\\u6d4b\\u8bd5 CJK ok', { x: 72, y: 700, size: 14, font });
      fs.writeFileSync('cjk.pdf', await doc.save());
    })().catch((e) => { console.error(e); process.exit(1); });
  `)
  const text = runScript('pdf', 'pdf-extract-text.cjs', [p('cjk.pdf')])
  assert(text.includes('中文测试'), 'CJK text round-trips')
})

// ---------- summary ----------
const pass = results.filter((r) => r.status === 'pass').length
const skipped = results.filter((r) => r.status === 'skip').length
const fail = results.filter((r) => r.status === 'fail').length
console.log(`\n${pass} passed, ${skipped} skipped, ${fail} failed — artifacts in ${TMP}`)
process.exit(fail ? 1 : 0)
