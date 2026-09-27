# Creating decks with pptxgenjs

Verified against pptxgenjs 4.x. Skeleton:

```js
const pptxgen = require('pptxgenjs');

async function main() {
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_WIDE';                 // 13.33 x 7.5 in — set BEFORE addSlide
  const slide = pres.addSlide();
  slide.background = { color: 'FFFFFF' };
  slide.addText('Title', { x: 0.6, y: 0.4, w: 12.1, h: 1.0, fontSize: 40, bold: true, color: '1F2937' });
  await pres.writeFile({ fileName: 'deck.pptx' });
}
main().catch((e) => { console.error(e); process.exit(1); });
```

## Coordinate system

- Everything is **inches** from top-left; `w`/`h` are box dimensions. `LAYOUT_WIDE` canvas: x ∈ [0, 13.33], y ∈ [0, 7.5]. Default (`LAYOUT_16x9`) is only 10 × 5.625 — always set `LAYOUT_WIDE` unless matching an existing 10" deck.
- **Out-of-canvas coordinates are written as-is, never clamped** (verified): the shape exists but is invisible on the slide. Off-slide content is the most common generation bug — keep a running y-cursor and assert `y + h <= 7.0` before adding.
- Text does not auto-flow or resize. Budget roughly: at 16pt, a 4"-wide box fits ~45 characters per line; add one line's height (0.25–0.3") per expected wrap. When unsure, make boxes taller and set `valign: 'top'`.

## Pitfalls (each one verified or version-checked)

- **Colors**: 6-hex uppercase without `#` (`'1F4E79'`). A leading `#` is tolerated in 4.x, but an 8-digit hex is **replaced by black** with only a console warning. For translucency use `transparency: 0–100` on fills, never alpha in the hex.
- **Never share an options object between two `add*` calls** — pptxgenjs mutates the object (converts inches to EMU) on first use; the second call gets garbage geometry.
- **One `new pptxgen()` instance per file.** Reuse duplicates slides.
- **Bullets**: pass an array of `{ text, options: { bullet: true, breakLine: true } }` items (`breakLine` on all but the last is required — without it items concatenate onto one line). Never type `•`. Space list items with `paraSpaceAfter: 6`, not `lineSpacing`.
- **Text box padding**: boxes have built-in inset; set `margin: 0` when text must align flush with a shape or another box's edge.
- **`slide.addNotes('...')`** for speaker notes — one call per slide, plain text.
- **Shapes**: `pres.ShapeType.roundRect` with `rectRadius: 0.08` (radius only affects rounded rectangles). Line: `line: { color: 'DDDDDD', width: 1 }`.
- **Images**: `slide.addImage({ path, x, y, w, h })` — compute w/h from the actual pixel aspect ratio or the image distorts. Base64 also works: `data: 'image/png;base64,...'` (prefix required).
- **Tables**: `slide.addTable(rows, { x, y, w, colW: [3, 2, 2], fontSize: 12, border: { pt: 0.5, color: 'DDDDDD' } })` where each cell is a string or `{ text, options }`. Give every column an explicit `colW`; the sum must equal `w`.

## Charts

`addChart(type, dataArray, options)` works for the standard types. Structurally-valid envelope:

```js
slide.addChart(pres.ChartType.bar, [{ name: 'Revenue', labels: ['Q1', 'Q2', 'Q3'], values: [10, 14, 18] }], {
  x: 0.6, y: 1.2, w: 8, h: 4.5,
  showTitle: true, title: 'Revenue by Quarter',
  showValue: true, dataLabelPosition: 'outEnd',
  chartColors: ['1F4E79', '6B93B5'], showLegend: false,
  catGridLine: { style: 'none' }, valGridLine: { color: 'E5E7EB', size: 0.5 },
});
```

Hard constraints — violating either produces a file PowerPoint reports as corrupt:

1. **Stacked bar/column charts must not use `dataLabelPosition: 'outEnd'`** — only `ctr`, `inEnd`, or `inBase`.
2. **A combo/secondary-axis chart (`secondaryValAxis`) requires explicit `valAxes` AND `catAxes` arrays (two entries each)** on the options. Prefer avoiding secondary axes entirely.

Defaults render bare and dated — always set title, data labels, `chartColors` from your palette, and quiet the gridlines as above. Chart types with no PowerPoint-native form (Sankey, network) cannot be charted — use shapes or an image.

## Reliable fonts

Font names are rendered by the user's PowerPoint, not here. Stick to fonts that ship with Office on both Windows and macOS: **Arial, Calibri, Cambria, Times New Roman, Courier New, Georgia, Verdana**. Do not use niche or post-2023 fonts (e.g. Aptos) — missing fonts silently substitute and shift every line length.

## Self-check before delivering

1. Run your generator; watch stderr for pptxgenjs warnings (a color warning means a wrong color shipped).
2. `halo-node scripts/ooxml.cjs validate deck.pptx` — must be VALID.
3. `halo-node scripts/pptx-outline.cjs deck.pptx --notes` — confirm every slide's text, order, and notes.
4. Re-check your y-math for any slide whose content count changed late in the build — overflow is silent.
