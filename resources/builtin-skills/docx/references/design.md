# Default document design standard

Apply this whenever the user gives no styling requirements: the default output is a designed professional document, not the library default. All techniques below are verified against the bundled `docx` library. Sizes are half-points (`size: 22` = 11pt); spacing is twentieths of a point (`spacing: { after: 160 }` = 8pt).

## Document theme — define once, use everywhere

Put the design decisions in constants at the top of the build script and reference them in every helper. One accent color per document.

```js
const T = {
  accent: '1F4E79',      // headings, rules, table headers
  ink: '24292F',         // body text (never pure black 000000)
  muted: '6B7280',       // captions, meta
  zebra: 'F2F6FA',       // alternating table rows (a 4-6% tint of accent)
  border: 'D6DCE4',      // table/hairline gray
};
```

## Page setup

```js
sections: [{
  properties: {
    page: { margin: { top: 1440, bottom: 1440, left: 1620, right: 1620 } }, // 1" top/bottom, 1.125" sides (DXA)
  },
  children: [...],
}]
```

Slightly wider side margins than the 1" default make body lines ~90 characters — measurably more readable. Never go below 1" any side for formal documents.

## Heading hierarchy

Consistent accent color + asymmetric spacing (more before than after) is what separates a designed document from a default one:

| Level | Size | Color | spacing before/after |
|---|---|---|---|
| Title (cover or first page) | 32–40pt | ink | 0 / 240 |
| Heading 1 | 17–18pt bold | accent | 360 / 160 |
| Heading 2 | 14pt bold | accent | 280 / 120 |
| Heading 3 | 12pt bold | ink | 240 / 100 |
| Body | 11pt | ink | 0 / 160, `line: 360` (1.5-line) for formal docs, 276 (1.15) for memos |

```js
const h1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1, spacing: { before: 360, after: 160 },
  children: [new TextRun({ text, bold: true, size: 35, color: T.accent })],
});
const body = (text) => new Paragraph({
  spacing: { after: 160, line: 360 },
  children: [new TextRun({ text, size: 22, color: T.ink })],
});
```

Set run properties explicitly as above — heading styles alone render with Word's default blue/Calibri look.

## Styled tables — never the default black grid

Default tables read as "AI 做的表". The standard treatment: accent header row with white bold text, zebra body rows, light horizontal borders only, no vertical lines:

```js
const B = { style: BorderStyle.SINGLE, size: 4, color: T.border };
const NONE = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const cell = ({ text, head = false, i = 0, w = 3000 }) => new TableCell({
  width: { size: w, type: WidthType.DXA },
  shading: { type: ShadingType.CLEAR, fill: head ? T.accent : (i % 2 ? T.zebra : 'FFFFFF') },
  borders: { top: B, bottom: B, left: NONE, right: NONE },
  margins: { top: 80, bottom: 80, left: 120, right: 120 },
  children: [new Paragraph({ children: [new TextRun({ text, bold: head, size: head ? 21 : 20, color: head ? 'FFFFFF' : T.ink })] })],
});
```

Rules: zebra only for tables ≥ 5 data rows; right-align numeric columns (`alignment: AlignmentType.RIGHT` on the cell's Paragraph); cell padding via `margins` as above — cramped cells ruin any styling.

## Cover page (reports and formal deliverables)

Recipe — vertical composition on an otherwise empty page:

1. ~5 empty spacer paragraphs (or one with `spacing: { before: 4800 }`).
2. Accent rule: an empty paragraph with a strong bottom border — `border: { bottom: { style: BorderStyle.SINGLE, size: 24, color: T.accent } }`, width-limited via `indent: { right: 6000 }`.
3. Title 36–40pt bold ink, `spacing: { before: 200, after: 120 }`.
4. Subtitle 13pt muted.
5. Bottom block (after ~10 more spacer paragraphs): organization / author / date, 11pt muted, each its own paragraph.
6. `new Paragraph({ children: [new PageBreak()] })` to start content on page 2.

Skip the cover for memos and letters — there, the title block is Title + one muted meta line + accent rule, then body.

## CJK documents

- **Font pairing convention**: 黑体-class headings + body in 微软雅黑 (modern) or 宋体 (traditional/official documents). Set BOTH ascii and eastAsia or Latin fragments render in a different font: `new TextRun({ text, font: { ascii: 'Microsoft YaHei', eastAsia: '微软雅黑' } })`. For the 宋体 body convention: headings `{ ascii: 'SimHei', eastAsia: '黑体' }`, body `{ ascii: 'Times New Roman', eastAsia: '宋体' }` (the classic official pairing).
- **Sizes for official-style documents**: title 22pt (二号), H1 16pt (三号), body 12pt (小四); body line spacing `line: 480` (28pt fixed feel via 1.5 of 12pt works: `line: 360` also acceptable for modern docs).
- First-line indent for 宋体 body documents: `indent: { firstLine: 480 }` (2 characters at 12pt).
- Do not bold 宋体 body text for emphasis — use 黑体 runs instead (standard convention).

## Micro-details checklist

- One accent color total; muted gray for everything secondary.
- Numbers in tables: same decimal places per column, right-aligned.
- No empty-paragraph gaps between body paragraphs — spacing comes from `spacing.after` only (empty paragraphs make spacing inconsistent and un-editable).
- Captions ("表 1：…", "Source: …") 9pt muted, `spacing: { before: 60 }` directly under the table.
- Verify with `read-docx.cjs` (structure) + `ooxml.cjs validate`; for styling, spot-check the XML (`ooxml.cjs cat file.docx word/document.xml | head`) for your accent hex and eastAsia fonts.
