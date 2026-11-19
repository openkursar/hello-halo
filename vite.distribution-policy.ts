import { createRequire } from 'node:module'
import { extname } from 'node:path'
import type { Plugin } from 'vite'

const require = createRequire(import.meta.url)
const { stripSourceMapComments } = require('./scripts/lib/distribution-policy.cjs') as {
  stripSourceMapComments: (source: string, extension: string) => string
}

export function productionDistribution(): Plugin {
  return {
    name: 'halo-production-distribution',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const [name, artifact] of Object.entries(bundle)) {
        if (/\.(?:[cm]?js|css)\.map$/.test(name)) {
          delete bundle[name]
        } else if (artifact.type === 'chunk') {
          artifact.code = stripSourceMapComments(artifact.code, '.js')
          artifact.map = null
        } else if (name.endsWith('.css') && typeof artifact.source === 'string') {
          artifact.source = stripSourceMapComments(artifact.source, extname(name))
        }
      }
    }
  }
}
