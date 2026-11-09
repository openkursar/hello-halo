import type { ToolDiscoveryOptions } from '@hello-halo/agent-sdk'
import type { InstalledApp } from '../../../shared/apps/app-types'

type ServiceContext = ToolDiscoveryOptions['services'][string]

// Transport records are also consumed by external engines; host policy stays out of them.
const installedContexts = new WeakMap<object, { appId: string; policy: ServiceContext }>()

const deferredBuiltins = new Map([
  ['halo-apps', 'Create and manage digital humans, their settings and installed capabilities.'],
  ['halo-email', 'Read, search and send email through the configured email account.'],
])

function summaryText(value: string | undefined): string | undefined {
  const text = value?.trim()
  if (!text) return undefined
  let result = ''
  let count = 0
  for (const character of text) {
    if (count++ === 512) break
    result += character
  }
  return result
}

/** Preserve an installed service's identity and preferences without changing its transport. */
export function markInstalledMcpContext<T extends object>(server: T, app: InstalledApp): T {
  const preferences = app.userOverrides?.mcpContext
  const summary = summaryText(preferences?.summary) ?? summaryText(app.spec.description)
  installedContexts.set(server, Object.freeze({
    appId: app.id,
    policy: Object.freeze({
      identity: `app:${app.id}`,
      loading: preferences?.loading ?? 'deferred',
      ...(summary ? { summary } : {}),
    }),
  }))
  return server
}

/** The final mounted server set is the boundary; a stored preference never adds a server. */
export function buildToolDiscoveryOptions(
  servers: Record<string, unknown> | null | undefined,
): ToolDiscoveryOptions | undefined {
  const services: ToolDiscoveryOptions['services'] = Object.create(null)
  for (const name of Object.keys(servers ?? {}).sort()) {
    const server = servers![name]
    if (!server || typeof server !== 'object') continue
    const installed = installedContexts.get(server)
    if (installed) {
      services[name] = { ...installed.policy }
      continue
    }
    const summary = deferredBuiltins.get(name)
    if (summary && (server as { type?: unknown }).type === 'sdk') {
      services[name] = { identity: `builtin:${name}`, loading: 'deferred', summary }
    }
  }
  // Unclassified servers retain the SDK's eager default.
  return Object.keys(servers ?? {}).length > 0 ? { services } : undefined
}

/** Installed dependencies of this prepared pool; server names are not installation identities. */
export function getMcpContextAppIds(servers: Record<string, unknown> | null | undefined): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const server of Object.values(servers ?? {})) {
    if (server && typeof server === 'object') {
      const context = installedContexts.get(server)
      if (context) ids.add(context.appId)
    }
  }
  return ids
}

export function toolDiscoveryFingerprint(options: Record<string, any>): string {
  if (options.engineId !== 'halo' || (options.toolCallingMode && options.toolCallingMode !== 'native')) return ''
  return JSON.stringify(buildToolDiscoveryOptions(options.mcpServers) ?? null)
}
