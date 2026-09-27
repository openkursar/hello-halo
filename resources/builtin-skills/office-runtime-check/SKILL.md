---
name: office-runtime-check
description: Verify that the bundled Office library runtime (halo-node shim + pure-JS office libraries) is working. Use when the user asks to check or debug Office document capabilities, or when an Office skill fails with module-resolution errors.
version: 1.0.2
author: Halo
---

# Office Runtime Check

Halo ships a bundled set of pure-JS Office libraries (exceljs, docx, pptxgenjs,
jszip, mammoth, pdf-lib, fast-xml-parser, unpdf, @pdf-lib/fontkit) plus a
`halo-node` command that runs
scripts with those libraries available — no Node.js installation required.

## How to run the check

Run the companion script with `halo-node` (already on PATH in this session):

```
halo-node "<this-skill-dir>/scripts/check.cjs"
```

It prints one line per library with its resolved version, or an error naming
the missing library.

## Rules for scripts using the bundled runtime

- Always invoke scripts via `halo-node`, never `node`.
- Use CommonJS `require()` only — ESM `import` does not resolve through the
  bundled NODE_PATH. Name scripts `*.cjs` so Node never misreads them as ESM.
- Only the libraries listed above are guaranteed; do not `require` anything
  else without checking availability first.
