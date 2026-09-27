#!/usr/bin/env node
/*
 * pdf-info.cjs — show a PDF's structure: page count/sizes, metadata, and form fields.
 *
 * Usage:
 *   halo-node pdf-info.cjs <file.pdf>            # summary
 *   halo-node pdf-info.cjs <file.pdf> --json     # machine-readable
 *
 * Form fields are listed with name, type, and current value — exactly what a
 * form-filling script needs (see references/forms.md).
 */

const fs = require('fs');

function usage() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n');
  console.log(lines.slice(1, lines.indexOf(' */')).join('\n').replace(/^ \* ?/gm, ''));
}

function fieldInfo(f) {
  const type = f.constructor.name.replace(/^PDF/, '');
  const info = { name: f.getName(), type };
  try {
    if (type === 'TextField') info.value = f.getText() || '';
    else if (type === 'CheckBox') info.value = f.isChecked();
    else if (type === 'RadioGroup') { info.value = f.getSelected(); info.options = f.getOptions(); }
    else if (type === 'Dropdown' || type === 'OptionList') { info.value = f.getSelected(); info.options = f.getOptions(); }
  } catch { /* value unreadable — leave undefined */ }
  return info;
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { usage(); process.exit(argv.length ? 0 : 1); }
  const asJson = argv.includes('--json');
  const file = argv.filter((a) => !a.startsWith('--'))[0];

  const { PDFDocument } = require('pdf-lib');
  const doc = await PDFDocument.load(fs.readFileSync(file), { updateMetadata: false });
  const pages = doc.getPages().map((p, i) => {
    const { width, height } = p.getSize();
    return { page: i + 1, width: Math.round(width), height: Math.round(height) };
  });
  const meta = {
    title: doc.getTitle(), author: doc.getAuthor(), subject: doc.getSubject(),
    creator: doc.getCreator(), producer: doc.getProducer(),
  };
  let fields = [];
  try { fields = doc.getForm().getFields().map(fieldInfo); } catch { /* no AcroForm */ }

  if (asJson) { console.log(JSON.stringify({ pageCount: pages.length, pages, metadata: meta, formFields: fields }, null, 2)); return; }
  console.log(`${file}`);
  console.log(`Pages: ${pages.length}`);
  const sizes = [...new Set(pages.map((p) => `${p.width}x${p.height}`))];
  console.log(`Page size(s): ${sizes.join(', ')} pt${sizes.length > 1 ? ' (mixed)' : ''}`);
  for (const [k, v] of Object.entries(meta)) if (v) console.log(`${k[0].toUpperCase()}${k.slice(1)}: ${v}`);
  if (fields.length) {
    console.log(`\nForm fields (${fields.length}):`);
    for (const f of fields) {
      const extra = f.options ? `  options=${JSON.stringify(f.options)}` : '';
      console.log(`  ${f.type.padEnd(11)} ${JSON.stringify(f.name)}  value=${JSON.stringify(f.value)}${extra}`);
    }
  } else {
    console.log('\nNo form fields (not a fillable form).');
  }
}

main().catch((err) => {
  const msg = String(err && err.message || err);
  if (/password|encrypted/i.test(msg)) console.error('Error: this PDF is encrypted — ask the user for the password or a decrypted copy.');
  else console.error(`Error: ${msg}`);
  process.exit(1);
});
