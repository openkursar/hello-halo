// Verifies the bundled Office runtime: requires each guaranteed library and
// prints its version. Run via `halo-node check.cjs` (CommonJS only).
'use strict'

const libs = [
  'exceljs',
  'docx',
  'pptxgenjs',
  'jszip',
  'mammoth',
  'pdf-lib',
  'fast-xml-parser',
  'unpdf',
  '@pdf-lib/fontkit',
]

let failed = false
for (const name of libs) {
  try {
    const mod = require(name)
    let version = mod && mod.version
    if (!version) {
      // Exports maps may block subpath requires — version is best-effort.
      try {
        version = require(`${name}/package.json`).version
      } catch {
        version = 'unknown'
      }
    }
    console.log(`ok ${name} ${version}`)
  } catch (err) {
    failed = true
    console.error(`FAIL ${name}: ${err && err.message}`)
  }
}

if (failed) {
  console.error('office-runtime-check: FAILED')
  process.exit(1)
}
console.log('office-runtime-check: OK')
