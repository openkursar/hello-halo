'use strict'

/**
 * Default electron-builder config for the public / open-source build.
 *
 * product.json is the single source of truth for a build's product identity.
 * Its `name` field therefore drives the installer/app brand (electron-builder's
 * productName), so a fork can rebrand by editing product.json alone instead of
 * also having to know that package.json#build carries a second, hidden name.
 *
 * package.json#build stays the shared base (icons, targets, files, nsis, …);
 * this overlay only replaces productName. When product.json is absent — a
 * vanilla checkout with no variant applied — the base productName is kept.
 *
 * Enterprise variants keep their own overlay (electron-builder.<vendor>.cjs)
 * that pins a fixed productName independent of product.json.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = __dirname

function loadBaseConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  if (!pkg.build) throw new Error('[electron-builder] package.json has no "build" section')
  return pkg.build
}

function resolveProductName(base) {
  const productPath = path.join(ROOT, 'product.json')
  if (fs.existsSync(productPath)) {
    try {
      const name = JSON.parse(fs.readFileSync(productPath, 'utf-8')).name
      if (typeof name === 'string' && name.trim()) return name.trim()
    } catch {
      // Malformed product.json falls through to the base name; loadProductConfig
      // reports the real error at runtime, and validateProductConfig gates the
      // packaged artifact.
    }
  }
  return base.productName ?? 'Halo'
}

const base = loadBaseConfig()

module.exports = {
  ...base,
  productName: resolveProductName(base)
}
