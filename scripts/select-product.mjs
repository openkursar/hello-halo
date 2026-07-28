#!/usr/bin/env node
/**
 * select-product.mjs — `npm run product`
 *
 * Interactive picker for the active product variant. Lists variants discovered
 * under halo-local/, writes the choice to the .product-source pointer, and
 * applies it to product.json immediately so the next dev/build uses it.
 */

import { applyVariant, discoverVariants, promptSelect, writePointer } from './product-source.mjs'

async function main() {
  const variants = discoverVariants()
  if (variants.length === 0) {
    console.log('\x1b[33m[product]\x1b[0m No product variants found under halo-local/.')
    console.log('\x1b[33m[product]\x1b[0m Add a product.<variant>.json there, then rerun `npm run product`.')
    process.exit(0)
  }

  const chosen = await promptSelect(variants)
  if (!chosen) return

  applyVariant(chosen.path)
  writePointer(chosen.path)
  console.log(`\x1b[32m[product]\x1b[0m Switched to ${chosen.rel} \x1b[2m[${chosen.dataFolderName}]\x1b[0m`)
  console.log('\x1b[2m[product]\x1b[0m product.json updated; dev/build will use this variant.')
}

main().catch((err) => {
  console.error(`\x1b[31m[product]\x1b[0m ${err.message}`)
  process.exit(1)
})
