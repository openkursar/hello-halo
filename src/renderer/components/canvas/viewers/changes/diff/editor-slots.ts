/**
 * A cap on how many diff editors live at once. Cards near the viewport ask for
 * a slot; past the cap the least recently used holder that is off screen gives
 * its editor up (an on-screen one only when every holder is on screen), and
 * shows a placeholder of the same height until it scrolls back into view.
 */

export const MAX_LIVE_EDITORS = 12

interface Holder {
  onEvict: () => void
  visible: boolean
  used: number
}

export class EditorSlots {
  private holders = new Map<string, Holder>()
  private clock = 0

  constructor(private readonly capacity: number = MAX_LIVE_EDITORS) {}

  get size(): number {
    return this.holders.size
  }

  has(key: string): boolean {
    return this.holders.has(key)
  }

  /** Takes a slot for `key`, evicting others past the cap; `onEvict` is called if this one is taken back later. */
  acquire(key: string, onEvict: () => void, visible = false): void {
    const existing = this.holders.get(key)
    if (existing) {
      existing.onEvict = onEvict
      existing.used = ++this.clock
      existing.visible = existing.visible || visible
      return
    }
    this.holders.set(key, { onEvict, visible, used: ++this.clock })
    while (this.holders.size > this.capacity) {
      const victim = this.pickVictim(key)
      if (!victim) break
      const holder = this.holders.get(victim)!
      this.holders.delete(victim)
      holder.onEvict()
    }
  }

  release(key: string): void {
    this.holders.delete(key)
  }

  /** Reports a card entering or leaving the viewport. */
  setVisible(key: string, visible: boolean): void {
    const holder = this.holders.get(key)
    if (!holder) return
    holder.visible = visible
    if (visible) holder.used = ++this.clock
  }

  private pickVictim(except: string): string | null {
    let offscreen: [string, number] | null = null
    let onscreen: [string, number] | null = null
    for (const [key, holder] of this.holders) {
      if (key === except) continue
      if (!holder.visible) {
        if (!offscreen || holder.used < offscreen[1]) offscreen = [key, holder.used]
      } else if (!onscreen || holder.used < onscreen[1]) {
        onscreen = [key, holder.used]
      }
    }
    return (offscreen ?? onscreen)?.[0] ?? null
  }
}
