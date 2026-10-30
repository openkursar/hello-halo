const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createExperimentalProduct, validateExperimentalProduct } = require('../../scripts/lib/experimental-product.cjs')
const { ENGINE_RUNTIMES } = require('../../scripts/engine-runtimes.cjs')

test('experimental product preserves provider setup but separates installation and update identity', () => {
  const source = {
    name: 'Halo', appId: 'com.halo.app', dataFolderName: 'halo', deepLinkScheme: 'halo',
    authProviders: [{ type: 'custom', enabled: true }],
    updateConfig: { provider: 'generic', url: 'https://updates.example/stable', windowsMode: 'staged' },
    announcementsUrl: 'https://updates.example/announcements',
  }
  const product = createExperimentalProduct(source, '3.0.5-rc.15')
  validateExperimentalProduct(product)
  assert.equal(product.version, '3.0.5-experimental.1')
  for (const key of ['name', 'appId', 'dataFolderName', 'deepLinkScheme']) assert.notEqual(product[key], source[key])
  assert.deepEqual(product.updateConfig, { provider: 'disabled', channel: 'experience' })
  assert.equal(product.announcementsUrl, undefined)
  assert.deepEqual(product.authProviders, source.authProviders)
  assert.equal(source.updateConfig.url, 'https://updates.example/stable')
})

test('experimental validation rejects a stable feed or shared data directory before packaging', () => {
  const product = createExperimentalProduct({ authProviders: [] }, '3.0.5')
  assert.throws(() => validateExperimentalProduct({ ...product, dataFolderName: 'halo' }), /dataFolderName/)
  assert.throws(() => validateExperimentalProduct({ ...product, updateConfig: { provider: 'github' } }), /disabled/)
  assert.throws(() => validateExperimentalProduct({ ...product, updateConfig: { provider: 'disabled', url: 'https://stable.example' } }), /feed/)
})

test('Halo is mandatory and Claude Code is absent from dependency and packaging declarations', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'))
  assert.equal(pkg.dependencies['@hello-halo/agent-sdk'], 'file:src/sdk/halo-sdk')
  assert.equal(pkg.optionalDependencies['@hello-halo/agent-sdk'], undefined)
  assert.equal(ENGINE_RUNTIMES.halo.required, true)
  assert.equal(ENGINE_RUNTIMES.anthropic, undefined)
  for (const id of ['@anthropic-ai/claude-code', '@anthropic-ai/claude-agent-sdk']) {
    assert.equal(pkg.dependencies[id], undefined)
    assert.ok(pkg.build.files.includes(`!node_modules/${id}{,/**/*}`))
  }
})

test('rebuilding an explicitly versioned experiment retains its revision only for the same base release', () => {
  assert.equal(createExperimentalProduct({ version: '3.0.5-experimental.2' }, '3.0.5-rc.16').version, '3.0.5-experimental.2')
  assert.equal(createExperimentalProduct({ version: '3.0.4-experimental.9' }, '3.0.5-rc.16').version, '3.0.5-experimental.1')
  assert.equal(createExperimentalProduct({ version: '3.0.5-experimental.bad' }, '3.0.5-rc.16').version, '3.0.5-experimental.1')
})
