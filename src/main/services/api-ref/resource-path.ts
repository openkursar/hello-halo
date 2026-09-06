/**
 * Resolves `resources/api-ref/` — the manual pages, index, and the two JSON
 * tables the self-API loopback server uses to tell "not exposed" apart from
 * "does not exist". Both `services/api-ref` (manual/MCP tool) and
 * `http/self-api` (scope check) read from this same bundled tree, so its
 * location is resolved once here rather than duplicated.
 *
 * Same two-candidate resolution as `official-docs.service.ts`: `app.getAppPath()`
 * covers the asar-packaged case, `process.resourcesPath` covers builds that
 * ship this tree as an extra resource instead.
 *
 * A leaf shared across layers, not an internal of the MCP tool it sits beside —
 * `http/self-api` imports it directly and deliberately, because the barrel next
 * door pulls in zod and the agent SDK. Keep it to fs/path/electron so that
 * stays a cheap edge.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { app } from 'electron'

let bundledRoot: string | null | undefined

function getBundledRoot(): string | null {
  if (bundledRoot !== undefined) return bundledRoot

  const candidates = [join(app.getAppPath(), 'resources', 'api-ref'), join(process.resourcesPath ?? '', 'api-ref')]
  bundledRoot = candidates.find((dir) => dir && existsSync(dir)) ?? null

  if (!bundledRoot) console.warn('[ApiRef] No bundled resources/api-ref found')
  return bundledRoot
}

/** Absolute path to a file under `resources/api-ref/`, or null if the tree or file is missing. */
export function getApiRefPath(relFile: string): string | null {
  const root = getBundledRoot()
  if (!root) return null
  const file = resolve(root, relFile)
  if (file !== root && !file.startsWith(root + sep)) return null
  return existsSync(file) && statSync(file).isFile() ? file : null
}

export function readApiRefFile(relFile: string): string | null {
  const file = getApiRefPath(relFile)
  if (!file) return null
  try {
    return readFileSync(file, 'utf-8')
  } catch (error) {
    console.error(`[ApiRef] Read failed for ${relFile}:`, error)
    return null
  }
}

export function readApiRefJson<T>(relFile: string): T | null {
  const content = readApiRefFile(relFile)
  if (content === null) return null
  try {
    return JSON.parse(content) as T
  } catch (error) {
    console.error(`[ApiRef] Invalid JSON in ${relFile}:`, error)
    return null
  }
}
