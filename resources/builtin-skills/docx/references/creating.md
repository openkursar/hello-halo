# Creating .docx with the `docx` library

Verified patterns. All snippets: `const docx = require('docx')` with destructured classes, then `Packer.toBuffer(doc)` to write.

## Document skeleton

```js
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');

async function main() {
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } }, // 11pt base
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 },            // US Letter
                            margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children: [ /* Paragraphs and Tables */ ],
    }],
  });
  require('fs').writeFileSync('out.docx', await Packer.toBuffer(doc));
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Units: page/margins/indents/table widths are **DXA** (1440 = 1 inch); run `size` is **half-points** (24 = 12pt). Landscape: keep portrait width/height and add `orientation: docx.PageOrientation.LANDSCAPE`.

## Text and headings

```js
new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('Section')] });
new Paragraph({
  alignment: docx.AlignmentType.JUSTIFIED,
  spacing: { after: 200 },              // twentieths of a point
  children: [
    new TextRun({ text: 'Bold lead. ', bold: true }),
    new TextRun({ text: 'Regular continuation, ', }),
    new TextRun({ text: 'italic emphasis.', italics: true }),
  ],
});
```

One `Paragraph` per line — never `\n`. Empty spacer paragraphs are legitimate: `new Paragraph({})`. A manual page break is `new Paragraph({ children: [new docx.PageBreak()] })`.

## Bullets and numbered lists

Declare once on the Document, reference per paragraph. Never type `•` yourself.

```js
const doc = new Document({
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: docx.LevelFormat.BULLET, text: '\u2022',
        alignment: docx.AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
    { reference: 'nums', levels: [{ level: 0, format: docx.LevelFormat.DECIMAL, text: '%1.',
        alignment: docx.AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
  ]},
  sections: [{ children: [
    new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun('Item one')] }),
    new Paragraph({ numbering: { reference: 'nums', level: 0 }, children: [new TextRun('Step one')] }),
  ]}],
});
```

Each `reference` of a DECIMAL list keeps its own counter; reuse the same reference to continue numbering, define a new one to restart.

## Tables

```js
const { Table, TableRow, TableCell, WidthType, BorderStyle } = require('docx');
const cell = (text, opts = {}) => new TableCell({
  width: { size: opts.w || 4680, type: WidthType.DXA },
  shading: opts.head ? { type: docx.ShadingType.CLEAR, fill: '1F4E79' } : undefined,
  margins: { top: 80, bottom: 80, left: 120, right: 120 },
  children: [new Paragraph({ children: [new TextRun({ text, bold: !!opts.head, color: opts.head ? 'FFFFFF' : undefined })] })],
});
new Table({
  columnWidths: [4680, 4680],           // must sum to intended table width
  rows: [
    new TableRow({ tableHeader: true, children: [cell('Metric', { head: true }), cell('Value', { head: true })] }),
    new TableRow({ children: [cell('Revenue'), cell('$42m')] }),
  ],
});
```

- Set `columnWidths` on the Table **and** a DXA `width` on every cell; percentage widths render inconsistently across viewers.
- Shading type must be `ShadingType.CLEAR` (with `fill` as the color) — `SOLID` renders black in some viewers.
- Colors are 6-hex strings without `#`.

## Images

```js
new Paragraph({ children: [new docx.ImageRun({
  type: 'png',                                   // required; 'jpg', 'gif', 'bmp' also valid
  data: require('fs').readFileSync('chart.png'),
  transformation: { width: 480, height: 270 },   // pixels at 96 DPI
})]});
```

Compute height from the image's real aspect ratio — a wrong pair stretches the image.

## Headers, footers, page numbers

```js
sections: [{
  headers: { default: new docx.Header({ children: [new Paragraph('Confidential')] }) },
  footers: { default: new docx.Footer({ children: [new Paragraph({
    alignment: docx.AlignmentType.CENTER,
    children: [new TextRun({ children: [docx.PageNumber.CURRENT] })],
  })]})},
  children: [...],
}]
```

## Table of contents

```js
new docx.TableOfContents('Table of Contents', { hyperlink: true, headingStyleRange: '1-3' });
```

Only paragraphs using built-in `HeadingLevel.*` appear. The TOC field is computed by Word when the user opens the file and confirms the update prompt — the generated file itself shows an empty/stale TOC until then; tell the user to accept Word's "update fields" prompt.

## Professional document checklist

- One base font via document `styles.default`, sizes consistent (11pt body, headings via HeadingLevel).
- Margins 1" unless specified; `spacing: { after: 200 }` on body paragraphs rather than empty-paragraph gaps.
- Headings used hierarchically (H1 once, then H2/H3) so navigation and TOC work.
- Tables carry header rows (`tableHeader: true` repeats them across page breaks).
- Verify per the SKILL.md loop after writing.
