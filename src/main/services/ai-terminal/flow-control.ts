/**
 * AI Terminal - Flow control (policy; main process)
 *
 * A fast-producing pty (`yes`, `cat bigfile`) can emit output far faster than a
 * renderer can draw it; without backpressure the un-rendered backlog grows
 * without bound in IPC queues and xterm's write buffer until the UI (or a
 * remote link) chokes. Attached viewers acknowledge rendered chars; when any
 * viewer's unacknowledged backlog passes the high watermark the pty is PAUSED
 * (OS-level backpressure onto the child process), and resumed once every viewer
 * catches up below the low watermark.
 *
 * Our sessions can be headless (AI driving with no view open) — there is no
 * consumer to ack, and the headless xterm interpretation lives next to the pty
 * in the worker (which backpressures naturally). So flow control is engaged
 * only while ≥1 viewer is attached, and a viewer must detach (or its WS client
 * disconnect) to stop gating — otherwise a dead viewer would pause the pty
 * forever.
 */

const HIGH_WATERMARK_CHARS = 100_000
const LOW_WATERMARK_CHARS = 5_000

export class TerminalFlowController {
  /** sessionId → viewerId → unacknowledged chars */
  private viewers = new Map<string, Map<string, number>>()
  private paused = new Set<string>()

  constructor(
    private readonly pauseSession: (sessionId: string) => void,
    private readonly resumeSession: (sessionId: string) => void
  ) {}

  /** A viewer started consuming this session's data stream. */
  attach(sessionId: string, viewerId: string): void {
    let map = this.viewers.get(sessionId)
    if (!map) {
      map = new Map()
      this.viewers.set(sessionId, map)
    }
    map.set(viewerId, 0)
    // Re-attaching may have just reset this viewer's stale backlog (e.g. the
    // renderer reloaded mid-pause and re-opened the tab). A paused pty emits no
    // data, so no ack will ever arrive to trigger the resume — check now.
    this.maybeResume(sessionId)
  }

  /** A viewer stopped consuming (tab closed / unmounted). */
  detach(sessionId: string, viewerId: string): void {
    const map = this.viewers.get(sessionId)
    if (!map) return
    map.delete(viewerId)
    if (map.size === 0) this.viewers.delete(sessionId)
    this.maybeResume(sessionId)
  }

  /** Drop every attachment of a viewer (remote WS client disconnected). */
  detachViewer(viewerId: string): void {
    for (const sessionId of Array.from(this.viewers.keys())) {
      this.detach(sessionId, viewerId)
    }
  }

  /** Session ended or was removed — clear state and any standing pause. */
  drop(sessionId: string): void {
    this.viewers.delete(sessionId)
    this.paused.delete(sessionId)
  }

  /** Account a pty data chunk against every attached viewer. */
  onData(sessionId: string, charCount: number): void {
    const map = this.viewers.get(sessionId)
    if (!map || map.size === 0) return
    let max = 0
    for (const [viewerId, unacked] of map) {
      const next = unacked + charCount
      map.set(viewerId, next)
      if (next > max) max = next
    }
    if (!this.paused.has(sessionId) && max > HIGH_WATERMARK_CHARS) {
      this.paused.add(sessionId)
      this.pauseSession(sessionId)
    }
  }

  /** A viewer acknowledged `charCount` rendered chars. */
  ack(sessionId: string, viewerId: string, charCount: number): void {
    const map = this.viewers.get(sessionId)
    const unacked = map?.get(viewerId)
    if (map === undefined || unacked === undefined) return
    map.set(viewerId, Math.max(0, unacked - charCount))
    this.maybeResume(sessionId)
  }

  private maybeResume(sessionId: string): void {
    if (!this.paused.has(sessionId)) return
    const map = this.viewers.get(sessionId)
    if (map) {
      for (const unacked of map.values()) {
        if (unacked >= LOW_WATERMARK_CHARS) return
      }
    }
    this.paused.delete(sessionId)
    this.resumeSession(sessionId)
  }
}
