export const ENGINE_IDS = ['anthropic', 'halo', 'codex', 'dsh'] as const

export type EngineId = typeof ENGINE_IDS[number]

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value)
}
