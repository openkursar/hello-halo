/**
 * apps/runtime/federation/log -- Hybrid Logical Clock (HLC)
 *
 * A single, comparable timestamp that tracks physical time but is monotonically
 * advanced to respect causality. It replaces the naive "wall-clock primary +
 * logical secondary" ordering, which failed to hold the very guarantee it
 * claimed: with two separate keys the logical key was only consulted on a
 * physical-time TIE, so a reply authored on a slow clock (earlier wall time,
 * higher logical count) sorted BEFORE the message it replied to. HLC folds both
 * into one value so `a causally-after b  ⇒  hlc(a) > hlc(b)` always holds, while
 * `hlc.pt` stays within bounded drift of wall time for natural display order.
 *
 * Encoding: `<12 hex physical-ms><4 hex logical-counter>` — fixed width, so
 * lexicographic string comparison equals numeric comparison. 48 bits of ms
 * reach year ~10889; 16 bits of counter allow 65535 events inside one ms.
 */

const PT_HEX = 12 // 48-bit physical ms
const C_HEX = 4 // 16-bit logical counter
const C_MAX = 0xffff
const PT_MAX = 0xffffffffffff

/** Default guard: reject/clamp a remote physical time more than 5min ahead. */
export const DEFAULT_MAX_DRIFT_MS = 5 * 60 * 1000

export interface HlcParts {
  /** Physical time component (epoch ms). */
  pt: number
  /** Logical counter within the same pt. */
  c: number
}

export function encodeHlc(parts: HlcParts): string {
  const pt = Math.min(Math.max(0, Math.floor(parts.pt)), PT_MAX)
  const c = Math.min(Math.max(0, Math.floor(parts.c)), C_MAX)
  return pt.toString(16).padStart(PT_HEX, '0') + c.toString(16).padStart(C_HEX, '0')
}

export function decodeHlc(encoded: string): HlcParts {
  return {
    pt: parseInt(encoded.slice(0, PT_HEX), 16),
    c: parseInt(encoded.slice(PT_HEX, PT_HEX + C_HEX), 16),
  }
}

/** Numeric-equivalent comparison of two encoded HLCs (fixed width ⇒ string cmp). */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export interface HybridClockOptions {
  /** Wall-clock source (injectable for tests). */
  now?: () => number
  /** Seed from persisted high-water so a restart never regresses the clock. */
  seed?: string | null
  /** Max ms a remote pt may exceed local wall before it is clamped (anti-drift). */
  maxDriftMs?: number
  /** Called when a remote pt was clamped for exceeding maxDriftMs. */
  onDriftClamp?: (remotePt: number, wall: number) => void
  /** Called when the logical counter overflowed and pt was bumped instead. */
  onCounterOverflow?: (pt: number) => void
}

export interface HybridClock {
  /** Advance for a locally-authored event; returns the new encoded HLC. */
  tick(): string
  /** Merge a received HLC (before applying its entry); returns the new encoded HLC. */
  update(remoteEncoded: string): string
  /** Current encoded HLC without advancing. */
  peek(): string
}

/**
 * A per-(node, office) hybrid logical clock. Not shared across offices — each
 * office is an independent causal domain. Seed from the persisted `hlc_high` so
 * a process restart cannot move the clock backwards.
 */
export function createHybridClock(options: HybridClockOptions = {}): HybridClock {
  const now = options.now ?? Date.now
  const maxDriftMs = options.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS

  let last: HlcParts = options.seed ? decodeHlc(options.seed) : { pt: 0, c: 0 }

  function bumpCounter(pt: number, c: number): HlcParts {
    if (c > C_MAX) {
      // Exhausted the logical space inside one ms: step physical time forward.
      options.onCounterOverflow?.(pt)
      return { pt: pt + 1, c: 0 }
    }
    return { pt, c }
  }

  function tick(): string {
    const wall = now()
    const pt = Math.max(last.pt, wall)
    const next = pt === last.pt ? bumpCounter(pt, last.c + 1) : { pt, c: 0 }
    last = next
    return encodeHlc(next)
  }

  function update(remoteEncoded: string): string {
    const wall = now()
    const remote = decodeHlc(remoteEncoded)

    // Anti-drift: never let a peer's far-future clock drag ours arbitrarily
    // ahead of real time. Clamp the remote pt into [.., wall + maxDriftMs].
    let remotePt = remote.pt
    if (remotePt > wall + maxDriftMs) {
      options.onDriftClamp?.(remote.pt, wall)
      remotePt = wall + maxDriftMs
    }
    const remoteC = remotePt === remote.pt ? remote.c : 0

    const pt = Math.max(last.pt, remotePt, wall)
    let next: HlcParts
    if (pt === last.pt && pt === remotePt) {
      next = bumpCounter(pt, Math.max(last.c, remoteC) + 1)
    } else if (pt === last.pt) {
      next = bumpCounter(pt, last.c + 1)
    } else if (pt === remotePt) {
      next = bumpCounter(pt, remoteC + 1)
    } else {
      next = { pt, c: 0 }
    }
    last = next
    return encodeHlc(next)
  }

  function peek(): string {
    return encodeHlc(last)
  }

  return { tick, update, peek }
}
