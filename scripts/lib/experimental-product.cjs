'use strict'

const EXPERIMENTAL_IDENTITY = Object.freeze({
  name: 'Halo Experimental',
  appId: 'com.halo.experimental',
  dataFolderName: 'halo-experimental',
  deepLinkScheme: 'halo-experimental',
})

function createExperimentalProduct(source, packageVersion) {
  const baseVersion = packageVersion.split('-')[0]
  if (!/^\d+\.\d+\.\d+$/.test(baseVersion)) throw new Error('Invalid package version')
  const chosenVersion = typeof source.version === 'string'
    && source.version.startsWith(`${baseVersion}-experimental.`)
    && /^\d+\.\d+\.\d+-experimental\.\d+$/.test(source.version)
    ? source.version : `${baseVersion}-experimental.1`
  const product = {
    ...source,
    ...EXPERIMENTAL_IDENTITY,
    version: chosenVersion,
    updateConfig: { provider: 'disabled', channel: 'experience' },
  }
  // Release announcements must not send an isolated experiment back to the stable installer.
  delete product.announcementsUrl
  return product
}

function validateExperimentalProduct(product) {
  for (const [key, expected] of Object.entries(EXPERIMENTAL_IDENTITY)) {
    if (product[key] !== expected) throw new Error(`Experimental product ${key} must be ${expected}`)
  }
  if (product.updateConfig?.provider !== 'disabled') throw new Error('Experimental updates must be disabled')
  if (Object.keys(product.updateConfig).some(key => !['provider', 'channel'].includes(key))) {
    throw new Error('Experimental product must not carry update feed coordinates')
  }
  if (!/^\d+\.\d+\.\d+-experimental\.\d+$/.test(product.version)) {
    throw new Error('Experimental product requires an experimental version')
  }
}

module.exports = { EXPERIMENTAL_IDENTITY, createExperimentalProduct, validateExperimentalProduct }
