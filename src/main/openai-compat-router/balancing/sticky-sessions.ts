/**
 * Which member each conversation is stuck to, bounded in size and age.
 *
 * Entries are kept in recency order so the oldest go first when the table is
 * full; an entry nobody has touched for the time-to-live reads as absent and is
 * dropped when met.
 */

interface Entry {
  memberKey: string
  at: number
}

export class StickySessions {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly maxSessions: number, private readonly ttlMs: number) {}

  private static slot(groupId: string, sessionKey: string): string {
    return `${groupId}\u0000${sessionKey}`
  }

  get(groupId: string, sessionKey: string, now: number): string | null {
    const slot = StickySessions.slot(groupId, sessionKey)
    const entry = this.entries.get(slot)
    if (!entry) return null
    if (now - entry.at > this.ttlMs) {
      this.entries.delete(slot)
      return null
    }
    return entry.memberKey
  }

  set(groupId: string, sessionKey: string, memberKey: string, now: number): void {
    const slot = StickySessions.slot(groupId, sessionKey)
    this.entries.delete(slot)
    this.entries.set(slot, { memberKey, at: now })
    if (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  /** Live sessions per member of one group. */
  loadOf(groupId: string, now: number): Map<string, number> {
    const prefix = `${groupId}\u0000`
    const load = new Map<string, number>()
    for (const [slot, entry] of this.entries) {
      if (!slot.startsWith(prefix) || now - entry.at > this.ttlMs) continue
      load.set(entry.memberKey, (load.get(entry.memberKey) ?? 0) + 1)
    }
    return load
  }

  forgetGroup(groupId: string): void {
    const prefix = `${groupId}\u0000`
    for (const slot of [...this.entries.keys()]) {
      if (slot.startsWith(prefix)) this.entries.delete(slot)
    }
  }

  forgetAccount(sourceId: string): void {
    const prefix = `${sourceId}\u0000`
    for (const [slot, entry] of [...this.entries]) {
      if (entry.memberKey.startsWith(prefix)) this.entries.delete(slot)
    }
  }
}
