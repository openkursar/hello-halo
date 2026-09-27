#!/usr/bin/env node
/*
 * pptx-outline.cjs — extract the text content of a .pptx, slide by slide, in deck order.
 *
 * Usage:
 *   halo-node pptx-outline.cjs <deck.pptx>            # outline: one block per slide
 *   halo-node pptx-outline.cjs <deck.pptx> --notes    # include speaker notes
 *   halo-node pptx-outline.cjs <deck.pptx> --json     # machine-readable
 *
 * Slides are listed in presentation order (resolved via <p:sldIdLst>), with the slide
 * part name shown so targeted edits know which slideN.xml to touch.
 */

const fs = require('fs');
const JSZip = require('jszip');

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// One text line per <a:p>; runs concatenated
function extractParagraphs(xml) {
  const paras = [];
  const pRe = /<a:p>[\s\S]*?<\/a:p>|<a:p\s[^>]*>[\s\S]*?<\/a:p>/g;
  let pm;
  while ((pm = pRe.exec(xml)) !== null) {
    const tRe = /<a:t>([\s\S]*?)<\/a:t>|<a:t\s[^>]*>([\s\S]*?)<\/a:t>/g;
    let tm;
    const parts = [];
    while ((tm = tRe.exec(pm[0])) !== null) parts.push(decode(tm[1] !== undefined ? tm[1] : tm[2]));
    const text = parts.join('');
    if (text.trim()) paras.push(text);
  }
  return paras;
}

async function slideOrder(zip) {
  const pres = await zip.file('ppt/presentation.xml').async('string');
  const rels = await zip.file('ppt/_rels/presentation.xml.rels').async('string');
  const relMap = {};
  const rRe = /<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g;
  let m;
  while ((m = rRe.exec(rels)) !== null) relMap[m[1]] = m[2].replace(/^\//, '').replace(/^(?!ppt\/)/, 'ppt/');
  const order = [];
  const sRe = /<p:sldId\s[^>]*r:id="([^"]+)"/g;
  while ((m = sRe.exec(pres)) !== null) if (relMap[m[1]]) order.push(relMap[m[1]]);
  return order;
}

async function notesFor(zip, slidePart) {
  const relPath = slidePart.replace(/slides\/(slide\d+\.xml)$/, 'slides/_rels/$1.rels');
  const relFile = zip.file(relPath);
  if (!relFile) return [];
  const rels = await relFile.async('string');
  const m = /Target="([^"]*notesSlide\d+\.xml)"/.exec(rels);
  if (!m) return [];
  const notesPath = 'ppt/' + m[1].replace(/^(\.\.\/)+/, '');
  const nf = zip.file(notesPath);
  if (!nf) return [];
  return extractParagraphs(await nf.async('string'));
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(argv.length ? 0 : 1); }
  const withNotes = argv.includes('--notes');
  const asJson = argv.includes('--json');
  const file = argv.filter((a) => !a.startsWith('--'))[0];

  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const order = await slideOrder(zip);
  const slides = [];
  for (let i = 0; i < order.length; i++) {
    const part = order[i];
    const xml = await zip.file(part).async('string');
    const entry = { index: i + 1, part, paragraphs: extractParagraphs(xml) };
    if (withNotes) entry.notes = await notesFor(zip, part);
    slides.push(entry);
  }

  if (asJson) { console.log(JSON.stringify({ slideCount: slides.length, slides }, null, 2)); return; }
  console.log(`${file} — ${slides.length} slide(s)\n`);
  for (const s of slides) {
    console.log(`--- Slide ${s.index} (${s.part}) ---`);
    s.paragraphs.forEach((p) => console.log(p));
    if (withNotes && s.notes && s.notes.length) {
      console.log('[notes]');
      s.notes.forEach((n) => console.log(n));
    }
    console.log('');
  }
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
