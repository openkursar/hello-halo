# Filling PDF forms with pdf-lib

## Workflow

1. **List the fields first** — never guess names:

```
halo-node scripts/pdf-info.cjs form.pdf
```

Output shows each field's exact name, type (`TextField`, `CheckBox`, `RadioGroup`, `Dropdown`, `OptionList`), current value, and options.

2. **Fill by exact name**:

```js
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function main() {
  const doc = await PDFDocument.load(fs.readFileSync('form.pdf'));
  const form = doc.getForm();

  form.getTextField('applicant.name').setText('Ada Lovelace');
  form.getCheckBox('applicant.agree').check();          // .uncheck() to clear
  form.getRadioGroup('contact.method').select('Email'); // must be one of getOptions()
  form.getDropdown('state').select('CA');

  fs.writeFileSync('filled.pdf', await doc.save());
}
main().catch((e) => { console.error(e); process.exit(1); });
```

3. **Verify**: `pdf-info.cjs filled.pdf` — every value you set should read back.

## Rules

- `getTextField`/`getCheckBox` etc. **throw if the name doesn't match the field's type or doesn't exist** — that error means re-check step 1, not retry.
- `select()` values must exactly match an entry from the field's `options` list (case-sensitive).
- Multiline text fields wrap automatically; long text in a single-line field is clipped when displayed — shorten or report the limit to the user.
- Dates go in as strings in whatever format the form expects — copy the format from a placeholder or ask the user.
- Field appearance quirks: after `setText` on fields with odd fonts, `form.updateFieldAppearances()` before save fixes blank-looking values (pass an embedded Unicode font as the argument when filling CJK text into fields — see creating.md §Unicode).

## Flattening

`form.flatten()` converts all fields into static page content — the result is no longer editable. Only flatten when the user asks for a final/locked copy; keep an unflattened version otherwise. Flattening is also the fix when a recipient's viewer shows empty fields (some viewers ignore field values without appearance streams).

## Flat forms (no AcroForm fields)

If `pdf-info.cjs` reports no fields but the page visually is a form (a scan or print-to-PDF), fill it by overlaying text:

1. Get page size from `pdf-info.cjs`.
2. Estimate each blank's coordinates (remember: origin bottom-left, points). Extraction output plus the user's description usually locates labels; place values right of labels.
3. `page.drawText(value, { x, y, size: 10, font })` per blank.
4. Iterate with the user: deliver a draft, ask them to check positions, adjust coordinates. Say explicitly this is coordinate-based overlay and may need one or two rounds of adjustment.
