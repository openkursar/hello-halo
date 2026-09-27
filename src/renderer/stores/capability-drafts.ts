// Volatile drafts only: credentials and raw MCP configuration must never enter this cache.
const drafts = new Map<string, unknown>()
const limit = 20

export function getCapabilityDraft<T>(key: string): T | undefined {
  return drafts.get(key) as T | undefined
}

export function saveCapabilityDraft<T>(key: string, value: T): void {
  drafts.delete(key)
  drafts.set(key, value)
  if (drafts.size > limit) drafts.delete(drafts.keys().next().value!)
}

export function clearCapabilityDraft(key: string): void {
  drafts.delete(key)
}
