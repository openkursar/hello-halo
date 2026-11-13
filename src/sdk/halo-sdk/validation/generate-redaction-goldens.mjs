import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const referencePath = process.argv[2];
const wirePath = process.argv[3];
if (!referencePath || !wirePath) throw new Error('Pass the compiled reference redaction module and compiled wire module.');
const reference = await import(pathToFileURL(resolve(referencePath)).href);
const { encodeWire } = await import(pathToFileURL(resolve(wirePath)).href);
const output = process.argv[4] ?? fileURLToPath(new URL('../native/crates/halo-core/src/redaction/fixtures/golden.json', import.meta.url));
const cases = [];
function add(method, name, input) {
  const expected = method === 'headers' ? reference.redactHeaders(input)
    : method === 'secrets' ? reference.redactSecrets(input) : reference.truncateField(...input);
  cases.push({ method, name, input: encodeWire(input), expected: encodeWire(expected) });
}

const texts = ['', 'ordinary log text', 'sk-short', 'a'.repeat(40), '[REDACTED]', '中😀\ud800x\udfff'];
for (const length of [0, 1, 19, 20, 21, 64]) {
  for (const prefix of ['sk-ant-', 'sk-', 'Bearer ', 'bEaReR ', 'prefixBearer\t']) {
    for (const character of ['A', '9', '_', '-', '.', '/', '+', 'é', 'ſ', 'K', '\ud800']) {
      texts.push(`${prefix}${character.repeat(length)}!`);
    }
  }
}
for (const whitespace of ['\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2000', '\u2001', '\u2002', '\u2003',
  '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
  '\u0085', '\u180e', '\u200b', '\u2060']) {
  texts.push(`Bearer${whitespace}${'A'.repeat(20)}`, `\ud800Bearer${whitespace}${'A'.repeat(20)}\udfff`);
}
for (const prefix of ['', '😀', '\ud800', '\udfff', 'a\ud800😀']) {
  texts.push(`${prefix}sk-${'A'.repeat(20)}😀tail`, `${prefix}Bearer sk-${'A'.repeat(21)}`, `${prefix}sk-ant-${'_A-'.repeat(12)} sk-${'B'.repeat(20)}`);
}
texts.forEach((text, index) => add('secrets', `secret-${index}`, text));

const lengths = [NaN, -Infinity, -5000, -4.5, -2, -1, -0, 0, 0.5, 1, 1.5, 2, 3, 4, 2048, 2049, Infinity];
for (const [index, text] of ['', 'abc', 'A😀Z', '\ud800x\udfff', '😀\ud800😀', 'x'.repeat(2049), 'x'.repeat(2047) + '😀'].entries()) {
  for (const length of lengths) add('truncate', `truncate-${index}-${String(length)}`, [text, length]);
}
add('headers', 'header-casing', { Authorization: 'a', 'X-Api-Key': 'b', COOKIE: 'c', 'Set-Cookie': 'd', 'Proxy-Authorization': 'e', 'X-Session-Token': 'f', 'Content-Type': 'g' });
add('headers', 'unicode-header-casing', { 'X-API-KEY': 'kelvin', 'cooKie': 'kelvin-cookie', 'Authorİzation': 'dotted', 'x-ſession-token': 'long-s', '\ud800cookie': 'high', 'cookie\udfff': 'low', '中😀': 'text\ud800' });
add('headers', 'data-properties', { '10': 'ten', '2': 'two', untouched: { __haloSdkNativeUndefined: true, __haloSdkNativeNumber: 'NaN' }, missing: undefined, nan: NaN, negativeZero: -0 });
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(cases, null, 2) + '\n');
console.log(JSON.stringify({ cases: cases.length, output }));
