/** User preferences for how Halo SDK presents an installed MCP service. */
export interface McpContextPreferences {
  loading?: 'eager' | 'deferred'
  summary?: string
}

export const MCP_CONTEXT_SUMMARY_LIMIT = 512

/** Merge only supplied fields; null clears an override without changing its siblings. */
export function mergeMcpContextPreferences(
  current: McpContextPreferences | undefined,
  patch: unknown
): McpContextPreferences | undefined {
  if (patch == null) return undefined
  if (typeof patch !== 'object' || Array.isArray(patch) ||
    (Object.getPrototypeOf(patch) !== Object.prototype && Object.getPrototypeOf(patch) !== null)) {
    throw new Error('mcpContext must be an object')
  }
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'loading' && key !== 'summary') throw new Error('Unknown mcpContext field')
    if (value == null) {
      delete next[key]
    } else if (key === 'loading') {
      if (value !== 'eager' && value !== 'deferred') {
        throw new Error('mcpContext.loading must be eager or deferred')
      }
      next.loading = value
    } else {
      if (typeof value !== 'string') throw new Error('mcpContext.summary must be text')
      const summary = value.trim()
      let length = 0
      for (const _character of summary) {
        length += 1
        if (length > MCP_CONTEXT_SUMMARY_LIMIT) {
          throw new Error(`mcpContext.summary must be at most ${MCP_CONTEXT_SUMMARY_LIMIT} characters`)
        }
      }
      if (summary) next.summary = summary
      else delete next.summary
    }
  }
  return Object.keys(next).length ? next : undefined
}

/** Missing loading has the same behavior as an explicit on-demand preference. */
export function mcpContextPreferencesKey(value: McpContextPreferences | undefined): string {
  return JSON.stringify([value?.loading ?? 'deferred', value?.summary ?? ''])
}
