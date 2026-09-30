/**
 * Unit test: the composition and the bundle it boots on name the same plugins.
 *
 * `cordis-config.ts` writes plugin names as literal YAML; the bundle is built
 * from a list in `runtimes/dsh/manifest.cjs`. Neither can import the
 * other — one runs inside the packaged main process, the other is build
 * tooling — so nothing but this test stops them drifting apart.
 *
 * Drift is silent in the worst direction. A `cordis:` name with no builtin
 * behind it makes the loader resolve `undefined` as the plugin, and the engine
 * comes up serving a quietly smaller tool set instead of failing.
 */

import { createRequire } from 'module'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { materializeCordisConfig } from '../../../../../src/main/services/agent/dsh/runtime/cordis-config'
import type { ExternalMcpServer } from '../../../../../src/main/services/agent/mcp/types'

const require = createRequire(import.meta.url)
const { PLUGIN_PACKAGES, HALO_PLUGINS } = require('../../../../../runtimes/dsh/manifest.cjs')

/**
 * The widest composition Halo can produce: every tool permitted, and an MCP
 * server present so the row `mcp-plugins.ts` adds is covered too. A narrower
 * one would leave exactly the conditionally-mounted plugins unchecked.
 */
function widestComposition(): string {
  const mcpServers: Record<string, ExternalMcpServer> = {
    probe: {
      transport: 'stdio',
      command: 'node',
      args: [],
      env: {},
      cwd: '',
    } as ExternalMcpServer,
  }

  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-manifest-'))
  const { path: configPath } = materializeCordisConfig(dir, { mcpServers, workDir: dir })
  return require('fs').readFileSync(configPath, 'utf-8')
}

function composedPluginIds(): string[] {
  const ids = [...widestComposition().matchAll(/^\s*name:\s*'([^']+)'/gm)].map(m => m[1])
  expect(ids.length, 'composition produced no plugin rows').toBeGreaterThan(0)
  return ids
}

describe('dsh runtime manifest', () => {
  it('composes only plugins the bundle registers', () => {
    const registered = new Set([
      ...PLUGIN_PACKAGES.map((name: string) => name.slice(name.indexOf('/') + 1)),
      ...HALO_PLUGINS.map(({ id }: { id: string }) => id),
    ])

    const unregistered = composedPluginIds()
      .filter(id => id.startsWith('cordis:'))
      .map(id => id.slice('cordis:'.length))
      .filter(id => !registered.has(id))

    expect(
      [...new Set(unregistered)],
      'add these to PLUGIN_PACKAGES (or HALO_PLUGINS) in runtimes/dsh/manifest.cjs, then rebuild the bundle'
    ).toEqual([])
  })

  it('addresses every plugin through the bundle rather than by package', () => {
    // A leftover `@deepseek-ai/...` name resolves through Node instead of the
    // builtins map, and the packaged app has no such tree to resolve it in.
    const byPackage = composedPluginIds().filter(id => !id.startsWith('cordis:'))

    expect(byPackage, 'these must be written as cordis:<id>').toEqual([])
  })
})
