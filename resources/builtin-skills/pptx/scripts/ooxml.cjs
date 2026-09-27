#!/usr/bin/env node
/*
 * ooxml.cjs — inspect, unpack, repack, and validate OOXML packages (.docx/.pptx/.xlsx).
 *
 * Usage:
 *   halo-node ooxml.cjs list <file>                 # list parts in the package
 *   halo-node ooxml.cjs cat <file> <part>           # print one part's XML (pretty-printed)
 *   halo-node ooxml.cjs unpack <file> <dir>         # extract all parts to a directory
 *   halo-node ooxml.cjs pack <dir> <out>            # zip a directory back into a package
 *   halo-node ooxml.cjs validate <file>             # well-formedness + relationship checks
 *
 * `cat` accepts --raw to skip pretty-printing (exact bytes).
 * After editing unpacked XML, always run `validate` on the packed result.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

async function loadZip(file) {
  return JSZip.loadAsync(fs.readFileSync(file));
}

function partNames(zip) {
  return Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
}

// Minimal indent-based pretty printer that never rewrites content, only inter-tag whitespace
function prettyXml(xml) {
  return xml.replace(/></g, '>\n<');
}

async function cmdList(file) {
  const zip = await loadZip(file);
  for (const n of partNames(zip)) {
    const size = zip.files[n]._data ? zip.files[n]._data.uncompressedSize : 0;
    console.log(`${String(size).padStart(9)}  ${n}`);
  }
}

async function cmdCat(file, part, raw) {
  const zip = await loadZip(file);
  const f = zip.file(part);
  if (!f) {
    console.error(`Part not found: ${part}\nAvailable parts:\n${partNames(zip).join('\n')}`);
    process.exit(1);
  }
  const xml = await f.async('string');
  process.stdout.write(raw ? xml : prettyXml(xml));
  process.stdout.write('\n');
}

/*
 * Resolve a zip entry name to a path under `dir`, refusing anything that would
 * write outside it. Packages handed to `unpack` are untrusted input — a .docx is
 * just a zip, and they arrive as attachments, downloads and third-party
 * templates — so entry names are attacker-controlled. Do not lean on JSZip
 * collapsing `..` for you: it only understands `/`, so a backslash-separated
 * name escapes once Windows treats `\` as a separator.
 */
function resolveEntryPath(dir, name) {
  if (path.isAbsolute(name) || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name)) {
    throw new Error(`refusing absolute zip entry "${name}" (malformed or malicious package)`);
  }
  const root = path.resolve(dir);
  const dest = path.resolve(root, ...name.split('/'));
  if (dest !== root && !dest.startsWith(root + path.sep)) {
    throw new Error(`refusing zip entry "${name}" that escapes the target directory (malformed or malicious package)`);
  }
  return dest;
}

async function cmdUnpack(file, dir) {
  const zip = await loadZip(file);
  const names = partNames(zip);
  // Validate every entry before writing anything: a package that tries to
  // escape is rejected whole rather than half-extracted.
  const dests = names.map((n) => resolveEntryPath(dir, n));
  for (let i = 0; i < names.length; i++) {
    fs.mkdirSync(path.dirname(dests[i]), { recursive: true });
    fs.writeFileSync(dests[i], await zip.files[names[i]].async('nodebuffer'));
  }
  console.log(`Unpacked ${names.length} parts to ${dir}`);
}

function walk(dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue; // never pack symlinks
    if (e.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

async function cmdPack(dir, out) {
  const zip = new JSZip();
  const files = walk(dir, dir);
  if (!files.includes('[Content_Types].xml')) {
    console.error(`${dir} has no [Content_Types].xml — not an unpacked OOXML directory`);
    process.exit(1);
  }
  for (const rel of files) {
    zip.file(rel, fs.readFileSync(path.join(dir, ...rel.split('/'))));
  }
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  fs.writeFileSync(out, buf);
  console.log(`Packed ${files.length} parts into ${out}`);
}

async function cmdValidate(file) {
  const { XMLValidator } = require('fast-xml-parser');
  const zip = await loadZip(file);
  const names = partNames(zip);
  const problems = [];

  if (!names.includes('[Content_Types].xml')) problems.push('missing [Content_Types].xml');
  if (!names.includes('_rels/.rels')) problems.push('missing _rels/.rels');

  for (const n of names) {
    if (!/\.(xml|rels)$/i.test(n)) continue;
    const xml = await zip.files[n].async('string');
    const res = XMLValidator.validate(xml);
    if (res !== true) problems.push(`${n}: malformed XML — ${res.err.msg} (line ${res.err.line})`);
  }

  // every relationship target must resolve to a part (skip external/absolute targets)
  for (const n of names.filter((x) => x.endsWith('.rels'))) {
    const xml = await zip.files[n].async('string');
    const baseDir = path.posix.dirname(path.posix.dirname(n)); // _rels dir's parent
    const re = /Target="([^"]+)"(?![^<>]*TargetMode="External")/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const t = m[1];
      if (/^(https?:|mailto:|file:|\/)/i.test(t)) continue;
      if (xml.slice(m.index, m.index + 300).includes('TargetMode="External"')) continue;
      const resolved = path.posix.normalize(path.posix.join(baseDir === '.' ? '' : baseDir, t));
      if (!names.includes(resolved)) problems.push(`${n}: relationship target missing: ${t} (resolved ${resolved})`);
    }
  }

  if (problems.length) {
    console.log(`INVALID — ${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`  - ${p}`));
    process.exit(1);
  }
  console.log(`VALID — ${names.length} parts, all XML well-formed, all relationships resolve.`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const raw = rest.includes('--raw');
  const args = rest.filter((a) => a !== '--raw');
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); process.exit(cmd ? 0 : 1); }
  if (cmd === 'list' && args[0]) return cmdList(args[0]);
  if (cmd === 'cat' && args[1]) return cmdCat(args[0], args[1], raw);
  if (cmd === 'unpack' && args[1]) return cmdUnpack(args[0], args[1]);
  if (cmd === 'pack' && args[1]) return cmdPack(args[0], args[1]);
  if (cmd === 'validate' && args[0]) return cmdValidate(args[0]);
  usage();
  process.exit(1);
}

main().catch((err) => { console.error(`Error: ${err.message}`); process.exit(1); });
