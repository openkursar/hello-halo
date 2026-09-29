/**
 * Memory settings and status — shared by main and renderer.
 *
 * The same settings exist for a space (space preferences) and for a digital
 * human (its per-installation overrides). The thresholds each cadence stands
 * for are internal to platform/memory; only the cadence name crosses to the UI.
 */

/** How eagerly a memory is consolidated. */
export type MemoryCadence = 'diligent' | 'balanced' | 'economical'

export const MEMORY_CADENCES: readonly MemoryCadence[] = ['diligent', 'balanced', 'economical']

export interface MemorySettings {
  /** Absent = on. Off: the AI neither reads nor writes this memory; files stay. */
  enabled?: boolean
  /**
   * Absent = on. Off: no consolidation; once History has more entries than the
   * cadence allows (or the file passes its size limit), its oldest are archived.
   */
  autoConsolidate?: boolean
  /** Absent = 'diligent'. Also sets how far History grows while consolidation is off. */
  cadence?: MemoryCadence
}

export type ResolvedMemorySettings = Required<MemorySettings>

export function resolveMemorySettings(settings: MemorySettings | null | undefined): ResolvedMemorySettings {
  const cadence = settings?.cadence
  return {
    enabled: settings?.enabled !== false,
    autoConsolidate: settings?.autoConsolidate !== false,
    cadence: cadence && MEMORY_CADENCES.includes(cadence) ? cadence : 'diligent',
  }
}

/** What a settings screen shows about one memory. */
export interface MemoryStatus {
  /** Whether memory.md exists */
  exists: boolean
  /** Bytes of memory.md plus the topic files */
  totalBytes: number
  topicCount: number
  /** ISO time of the last committed consolidation, or null */
  lastConsolidatedAt: string | null
  /** Outcome of the last attempt, when there was one */
  lastAttempt: {
    at: string
    outcome: 'committed' | 'trimmed' | 'failed'
    /** Why it did not commit, in the system's words */
    reason?: string
  } | null
  /** A consolidation of this memory is running right now */
  consolidating: boolean
}

/** The recognised settings of an untrusted object (an IPC or HTTP body). */
export function sanitizeMemorySettings(input: unknown): MemorySettings {
  const out: MemorySettings = {}
  if (!input || typeof input !== 'object') return out
  const raw = input as Record<string, unknown>
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.autoConsolidate === 'boolean') out.autoConsolidate = raw.autoConsolidate
  if (typeof raw.cadence === 'string' && (MEMORY_CADENCES as readonly string[]).includes(raw.cadence)) {
    out.cadence = raw.cadence as MemoryCadence
  }
  return out
}
