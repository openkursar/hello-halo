'use strict'

/**
 * electron-builder config for every product built from this repo.
 *
 * Product identity — name, appId, update feed — is read from product.json and
 * from nowhere else, so a variant can never be half-applied: an artifact whose
 * brand says one product while its update feed points at another is not
 * expressible. product.json is a build input materialized from the active
 * variant by scripts/product-source.mjs, hence git-ignored; a vanilla checkout
 * has no variant and falls back to the committed product.example.json.
 *
 * package.json#build carries only the packaging mechanism shared by all
 * products (files, targets, icons, nsis, hooks) and declares no identity.
 *
 * Vendor overlays (electron-builder.<vendor>.cjs) spread this config and add
 * vendor-specific packaging on top; they must not restate identity.
 */

const fs = require('node:fs')
const path = require('node:path')

const ROOT = __dirname
const PRODUCT_FILE = path.join(ROOT, 'product.json')
const DEFAULT_PRODUCT_FILE = path.join(ROOT, 'product.example.json')

function loadBaseConfig() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))
  if (!pkg.build) throw new Error('[electron-builder] package.json has no "build" section')
  return pkg.build
}

function loadProduct() {
  const file = fs.existsSync(PRODUCT_FILE) ? PRODUCT_FILE : DEFAULT_PRODUCT_FILE
  const name = path.basename(file)
  let content
  try {
    content = JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    throw new Error(`[electron-builder] ${name} is not valid JSON: ${err.message}`)
  }
  return { name, content }
}

const product = loadProduct()

function field(key) {
  const value = product.content[key]
  if (value == null || value === '' || (typeof value === 'string' && !value.trim())) {
    throw new Error(
      `[electron-builder] ${product.name} has no "${key}". Product identity is ` +
        'read from this file only — add the field and rebuild.'
    )
  }
  return typeof value === 'string' ? value.trim() : value
}

/**
 * Update feed for the packaged app, derived from the same `updateConfig` the
 * runtime updater reads, so `resources/app-update.yml` and the runtime feed URL
 * cannot point at different servers.
 *
 * This must stay a real publish target. `publish: null` also expresses "do not
 * upload", but uploading is controlled by the `--publish` CLI flag, whereas the
 * config decides whether electron-builder writes `app-update.yml` at all.
 * Nulling it shipped builds that could detect an update and then fail to
 * download it with ENOENT.
 */
function resolvePublish() {
  const update = field('updateConfig')

  if (update.provider === 'generic') {
    if (!update.url) {
      throw new Error(
        `[electron-builder] ${product.name} updateConfig.provider is "generic" but ` +
          'updateConfig.url is empty — auto-update would ship broken.'
      )
    }
    return { provider: 'generic', url: update.url }
  }

  if (update.provider === 'github') {
    if (!update.owner || !update.repo) {
      throw new Error(
        `[electron-builder] ${product.name} updateConfig.provider is "github" but ` +
          'updateConfig.owner/repo are incomplete — auto-update would ship broken.'
      )
    }
    // electron-builder publishes drafts unless told otherwise; releases from
    // this repo are public the moment they are uploaded.
    return { provider: 'github', owner: update.owner, repo: update.repo, releaseType: 'release' }
  }

  throw new Error(
    `[electron-builder] ${product.name} has unknown updateConfig.provider ` +
      `"${update.provider}" — expected "github" or "generic".`
  )
}

module.exports = {
  ...loadBaseConfig(),
  productName: field('name'),
  appId: field('appId'),
  publish: resolvePublish()
}
