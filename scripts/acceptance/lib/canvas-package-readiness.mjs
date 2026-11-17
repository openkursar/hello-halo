import fs from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { verifyPackagedApplication } from './package.mjs'

const require = createRequire(import.meta.url)
const canvas = /(?:^|\/)node_modules\/@napi-rs\/canvas(?:-[^/]+)?(?:\/|$)/

export async function canvasInventoryFailure(resources) {
  const asar = require('@electron/asar')
  const archive = path.join(resources, 'app.asar')
  asar.uncache(archive)
  for (const entry of asar.listPackage(archive)) {
    const name = entry.replaceAll('\\', '/').replace(/^\//, '')
    if (!canvas.test(name)) continue
    const item = asar.statFile(archive, name, false)
    if (item.files || item.link) continue
    if (item.unpacked) await fs.access(path.join(resources, 'app.asar.unpacked', ...name.split('/')))
    else asar.extractFile(archive, name)
    return 'Canvas pruning was not accepted; this controlled package retains native canvas'
  }
  return null
}

export async function canvasPrunedPackageFailure(root, executable) {
  if (!executable) return 'A controlled packaged application is required to inspect native canvas applicability'
  try {
    const record = await verifyPackagedApplication(root, executable)
    const resources = await fs.realpath(path.resolve(root, record.resources))
    const directory = await fs.realpath(path.resolve(root, record.directory))
    const relative = path.relative(directory, resources)
    if (relative.startsWith('..') || path.isAbsolute(relative)) return 'The controlled package resources leave its recorded directory'
    return await canvasInventoryFailure(resources)
  } catch {
    return 'The controlled package identity or native canvas inventory could not be verified'
  }
}
