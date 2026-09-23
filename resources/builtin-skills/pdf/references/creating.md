# Creating and composing PDFs with pdf-lib

pdf-lib draws primitives at absolute positions. **Origin is bottom-left; y grows upward.** Units are points (72/inch). US Letter is `[612, 792]`, A4 is `[595.28, 841.89]`.

## Skeleton

```js
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');

async function main() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  page.drawText('Report Title', { x: 72, y: 720, size: 24, font: bold, color: rgb(0.12, 0.16, 0.22) });
  fs.writeFileSync('out.pdf', await doc.save());
}
main().catch((e) => { console.error(e); process.exit(1); });
```

Standard fonts: Helvetica, TimesRoman, Courier (+ Bold/Oblique/Italic variants). They encode **Latin-1 only** — any other character throws `WinAnsi cannot encode`.

## Text wrapping and pagination (there is no layout engine)

`drawText` renders exactly one line unless you wrap yourself. Measure with the font:

```js
function wrap(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const probe = line ? line + ' ' + w : w;
    if (font.widthOfTextAtSize(probe, size) > maxWidth && line) { lines.push(line); line = w; }
    else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

// paginate with a y-cursor; new page when you run out of room
let page = doc.addPage([612, 792]);
let y = 720;
const lineHeight = 14;
for (const line of wrap(longText, font, 11, 612 - 144)) {
  if (y < 72) { page = doc.addPage([612, 792]); y = 720; }
  page.drawText(line, { x: 72, y, size: 11, font });
  y -= lineHeight;
}
```

CJK text has no spaces — wrap per character instead of per word (same width-probe loop over `[...text]`).

## Shapes, lines, images

```js
page.drawRectangle({ x: 72, y: 600, width: 200, height: 40, color: rgb(0.95, 0.96, 0.97), borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 0.5 });
page.drawLine({ start: { x: 72, y: 590 }, end: { x: 540, y: 590 }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });

const png = await doc.embedPng(fs.readFileSync('chart.png'));   // embedJpg for JPEG
const dims = png.scale(0.5);                                     // keep aspect ratio
page.drawImage(png, { x: 72, y: 400, width: dims.width, height: dims.height });
```

Only PNG and JPEG can be embedded — convert other formats first.

## Unicode / CJK text (verified)

Standard fonts throw on non-Latin-1 text. Embed a real font with fontkit:

```js
const path = require('path');
const fontkit = require('@pdf-lib/fontkit');

function findUnicodeFont() {
  const candidates = [
    // 1. Bundled font — always usable when this env var is set
    process.env.HALO_OFFICE_FONTS_DIR && path.join(process.env.HALO_OFFICE_FONTS_DIR, 'NotoSansSC-Regular.otf'),
    // 2. System fallbacks (single-font .ttf/.otf only)
    '/Library/Fonts/Arial Unicode.ttf',                          // macOS (verified)
    'C:\\Windows\\Fonts\\simhei.ttf',                            // Windows
    'C:\\Windows\\Fonts\\simfang.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-SC-Regular.otf', // Linux
  ].filter(Boolean);
  return candidates.find((f) => fs.existsSync(f));
}

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const fontPath = findUnicodeFont();
if (!fontPath) throw new Error('no Unicode font found');
const font = await doc.embedFont(fs.readFileSync(fontPath), { subset: true });  // subset keeps the file small
page.drawText('中文内容', { x: 72, y: 700, size: 14, font });
```

- **Bundled font first**: the session env sets `HALO_OFFICE_FONTS_DIR` pointing at a dir containing `NotoSansSC-Regular.otf` (Noto Sans SC Regular; its OFL license ships beside it). When set, that path always works — no system hunting needed. Treat an unset var as "no bundled fonts": fall through to system candidates.
- **`.ttc` collections do NOT work** (macOS PingFang/STHeiti, Windows msyh.ttc will fail) — only single-font `.ttf`/`.otf`. More macOS candidates live under `/System/Library/Fonts/Supplemental/`; Linux Noto CJK under `/usr/share/fonts`.
- Report which font was used. If nothing is found, say so and offer alternatives: deliver as .docx (full Unicode support), or ask the user to point at a `.ttf`/`.otf` file.
- Noto Sans SC targets Simplified Chinese (plus Latin); its coverage of Traditional Chinese / Japanese / Korean is partial. For those, prefer a matching system font and tell the user if only the SC font was available.

## Composing from existing PDFs

```js
const src = await PDFDocument.load(fs.readFileSync('src.pdf'));
const out = await PDFDocument.create();
const pages = await out.copyPages(src, [0, 2, 3]);     // 0-based page indices
pages.forEach((p) => out.addPage(p));
```

- `copyPages` is the only correct way to move pages between documents — never `addPage(srcPage)` directly.
- Reorder within one doc: `copyPages(doc, order)` into a fresh document.
- Stamp page A onto page B (letterhead, overlay): `const [emb] = await out.embedPdf(srcBytes, [0])`, then `page.drawPage(emb, { x: 0, y: 0 })`.
- `page.setRotation(degrees(n))` — n must be a multiple of 90; read the current value first and add.

## Metadata and protection

```js
doc.setTitle('Q3 Report'); doc.setAuthor('...'); doc.setSubject('...');
```

pdf-lib **cannot encrypt or password-protect** output, and cannot decrypt without the password. Say so; suggest the user apply a password in a PDF viewer, or (for decryption) provide the password to `PDFDocument.load(bytes, { password })`.

## Verify every output

Re-read what you wrote: `pdf-info.cjs out.pdf` (page count/size) and `pdf-extract-text.cjs out.pdf` (text landed, in order, nothing missing). A coordinate mistake usually shows up as text on the wrong page or missing entirely (drawn off-page, e.g. negative y) — both are visible in extraction.
