import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPackageWithOptions, statFile } from '@electron/asar'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { build } = require('../../../package.json') as { build: { asarUnpack: string[] } }

describe('SDK executable resources', () => {
  it('unpacks executable resources using the product packaging rules', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'halo-sdk-package-rules-'))
    const source = join(temp, 'source')
    const resources = [
      'node_modules/@hello-halo/agent-sdk/dist/worker/entry.js',
      'node_modules/@hello-halo/agent-sdk/dist/search/worker.js',
      'node_modules/@hello-halo/agent-sdk/dist/search/supervisor.js',
      'out/main/worker/halo-setup.cjs',
    ]
    try {
      for (const resource of resources) {
        const file = join(source, resource)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, 'export {}\n')
      }
      const archive = join(temp, 'app.asar')
      await createPackageWithOptions(source, archive, {
        unpack: `{${build.asarUnpack.map(pattern => `**/${pattern}`).join(',')}}`,
      })
      for (const resource of resources) expect(statFile(archive, resource).unpacked).toBe(true)
    } finally {
      // Electron's patched fs traverses .asar as a virtual directory instead of deleting the file.
      const filesystem = process.versions.electron ? require('original-fs') : require('node:fs')
      await filesystem.promises.rm(temp, { recursive: true, force: true })
    }
  })
})
