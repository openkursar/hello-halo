import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PROJECT_ROOT, PRODUCT_JSON, applyVariant, writePointer } from './product-source.mjs'
import experimental from './lib/experimental-product.cjs'

export function prepareExperimentalProduct(sourcePath) {
  const source = sourcePath ? resolve(PROJECT_ROOT, sourcePath)
    : existsSync(PRODUCT_JSON) ? PRODUCT_JSON : join(PROJECT_ROOT, 'product.example.json')
  const config = JSON.parse(readFileSync(source, 'utf8'))
  const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))
  const product = experimental.createExperimentalProduct(config, pkg.version)
  experimental.validateExperimentalProduct(product)
  const output = join(PROJECT_ROOT, 'halo-local', 'product.experimental.json')
  mkdirSync(join(PROJECT_ROOT, 'halo-local'), { recursive: true })
  writeFileSync(output, JSON.stringify(product, null, 2) + '\n', { mode: 0o600 })
  applyVariant(output)
  writePointer(output)
  console.log(`[experimental] ${product.name} ${product.version}; isolated data, protocol, and updates`)
  return { output, product }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: npm run product:experimental -- [source-product.json]')
    prepareExperimentalProduct(process.argv[2])
  } catch (error) {
    console.error(`[experimental] Product preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
