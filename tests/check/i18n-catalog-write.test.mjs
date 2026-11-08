import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeJson } from '../../scripts/translate-i18n.mjs'

function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'halo-i18n-'))
  const file = join(directory, 'locale.json')
  const catalog = { apple: 'translated', Banana: '', item_one: 'one', item_other: 'many' }
  writeFileSync(file, JSON.stringify(catalog, null, 2) + '\n')
  try { run(file, catalog) } finally { rmSync(directory, { recursive: true, force: true }) }
}

test('real extraction and translation stay byte-identical on the second pass', () => {
  const directory = mkdtempSync(join(tmpdir(), 'halo-i18n-pipeline-'))
  try {
    const source = join(directory, 'source.ts')
    const config = join(directory, 'parser.mjs')
    writeFileSync(source, "t('apple'); t('Banana'); t('item', { count: 2 })\n")
    const projectConfig = new URL('../../i18next-parser.config.mjs', import.meta.url).href
    writeFileSync(config, `import config from ${JSON.stringify(projectConfig)}; export default { ...config, input: [${JSON.stringify(source)}], output: ${JSON.stringify(join(directory, '$LOCALE.json'))}, locales: ['en', 'fr'], verbose: false };\n`)
    const cli = fileURLToPath(new URL('../../node_modules/i18next-parser/bin/cli.js', import.meta.url))
    const extract = () => execFileSync(process.execPath, [cli, '--config', config], { stdio: 'pipe' })
    extract()
    const file = join(directory, 'fr.json')
    const catalog = JSON.parse(readFileSync(file, 'utf8'))
    catalog.Banana = 'translated banana'
    writeJson(file, catalog)
    const first = readFileSync(file, 'utf8')
    extract()
    writeJson(file, JSON.parse(readFileSync(file, 'utf8')))
    assert.equal(readFileSync(file, 'utf8'), first)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('translation preserves extraction order, including case and plural forms', () => {
  fixture((file, catalog) => {
    writeJson(file, { ...catalog, Banana: 'translated banana' })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(saved), Object.keys(catalog))
    assert.equal(saved.Banana, 'translated banana')
    assert.equal(saved.apple, catalog.apple)
  })
})

test('no translated values means no write, even with missing translations', () => {
  fixture((file, catalog) => {
    const stamp = new Date('2000-01-01T00:00:00Z')
    utimesSync(file, stamp, stamp)
    const before = statSync(file).mtimeMs
    writeJson(file, catalog)
    assert.equal(statSync(file).mtimeMs, before)
    assert.equal(readFileSync(file, 'utf8'), JSON.stringify(catalog, null, 2) + '\n')
  })
})

test('repeating a successful translation leaves both bytes and modification time unchanged', () => {
  fixture((file, catalog) => {
    const translated = { ...catalog, Banana: 'translated banana' }
    writeJson(file, translated)
    const before = readFileSync(file, 'utf8')
    const stamp = new Date('2000-01-01T00:00:00Z')
    utimesSync(file, stamp, stamp)
    const time = statSync(file).mtimeMs
    writeJson(file, translated)
    assert.equal(readFileSync(file, 'utf8'), before)
    assert.equal(statSync(file).mtimeMs, time)
  })
})
