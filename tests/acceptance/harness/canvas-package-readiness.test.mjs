import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { canvasInventoryFailure } from '../../../scripts/acceptance/lib/canvas-package-readiness.mjs'
const require = createRequire(import.meta.url)
const asar = require('@electron/asar')

async function artifact(context, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'halo-canvas-inventory-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), resources = path.join(root, 'resources')
  await fs.mkdir(resources, { recursive: true })
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true })
    await fs.writeFile(path.join(source, file), 'inert artifact fixture')
  }
  await asar.createPackage(source, path.join(resources, 'app.asar'))
  return resources
}

test('an actual archive with native canvas is inapplicable to pruning-only journeys', async context => {
  const resources = await artifact(context, ['package.json', 'node_modules/pdfjs-dist/node_modules/@napi-rs/canvas-darwin-arm64/canvas.node'])
  assert.equal(await canvasInventoryFailure(resources), 'Canvas pruning was not accepted; this controlled package retains native canvas')
})

test('an actual archive without native canvas satisfies the pruning inventory', async context => {
  const resources = await artifact(context, ['package.json', 'node_modules/pdfjs-dist/build/pdf.mjs', 'node_modules/@napi-rs/unrelated/index.js'])
  assert.equal(await canvasInventoryFailure(resources), null)
})
