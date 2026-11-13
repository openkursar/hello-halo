import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const root = process.argv[2];
if (!root) throw new Error('Pass the compiled reference SDK directory.');
const reference = await import(pathToFileURL(resolve(root, 'index.js')).href);
const { splitAtBoundary } = await import(pathToFileURL(resolve(root, 'prompt/system-prompt.js')).href);
const { PROMPT_CACHE_BOUNDARY: boundary } = await import(pathToFileURL(resolve(root, 'prompt/constants.js')).href);
const output = process.argv[3] ?? fileURLToPath(new URL('../native/crates/halo-core/src/core/fixtures/text-helpers.json', import.meta.url));
const units = text => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
const texts = ['', '\0', 'tail\0', 'ASCII text', '中文かな한글', '😀', '\ud800', '\udfff', 'A\ud800中\udfffZ',
  '\ud800\ud800\udfff\udfff', '\0😀\0\ud800\0', 'x'.repeat(999), '😀'.repeat(500), '\ud800x\udfff中😀'.repeat(150)];
let seed = 0x261111;
for (let index = 0; index < 32; index++) {
  const values = [];
  for (let unit = 0; unit < 17 + index; unit++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    values.push(seed & 0xffff);
  }
  texts.push(String.fromCharCode(...values));
}
const budgets = [-Infinity, -1, -0, 0, 0.5, 1, 2, 3, 10, 11, 12, 39, 40, 41, 42, 43, 99, 100, 101, 159, 160, 161, 499, 999,
  Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN];
const number = value => Object.is(value, -0) ? '-0' : Number.isFinite(value) ? value : String(value);
const truncations = [];
for (const [text, source] of texts.entries()) {
  for (const budget of budgets) {
    const fixture = { text, budget: number(budget) };
    try { fixture.units = units(reference.truncateToolResult(source, budget)); }
    catch (error) { fixture.error = { name: error.name, message: error.message }; }
    truncations.push(fixture);
  }
}
const whitespace = '\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
const splitInputs = [...texts, boundary, `${boundary}${boundary}`, `left${whitespace}${boundary}${whitespace}right`,
  `\ud800${whitespace}${boundary}${whitespace}\udfff`, `left\0${boundary}\0right`, `\ud83d${boundary}\ude00`,
  `\u0085\u180e\u200b\u2060${boundary}\u0085\u180e\u200b\u2060`, `A${boundary}B${boundary}C`];
const fixture = {
  node: process.versions.node,
  texts: texts.map(units),
  estimates: texts.map(reference.estimateTokens),
  truncations,
  defaultTruncation: createHash('sha256').update(Buffer.from(reference.truncateToolResult('\ud800'.repeat(50_001)), 'utf16le')).digest('hex'),
  splits: splitInputs.map(input => ({ input: units(input), output: splitAtBoundary(input).map(units) })),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(fixture) + '\n');
console.log(JSON.stringify({ texts: texts.length, truncations: truncations.length, splits: splitInputs.length, output }));
