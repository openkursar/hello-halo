/**
 * Registry of automation runs in flight, indexed by app.
 *
 * Status broadcasts ask "is this app running / how many runs" on every state
 * change; indexing by app keeps that O(1) instead of a prefix scan over every
 * run in the process. The first run of an app and the end of its last run are
 * reported so the caller can hold the process alive while work is in flight.
 */

export class RunningRuns {
  private readonly byApp = new Map<string, Map<string, AbortController>>()

  constructor(
    private readonly onAppBusyChange: (appId: string, busy: boolean) => void = () => {},
  ) {}

  add(appId: string, executionKey: string, controller: AbortController): void {
    let runs = this.byApp.get(appId)
    if (!runs) {
      runs = new Map()
      this.byApp.set(appId, runs)
      this.onAppBusyChange(appId, true)
    }
    runs.set(executionKey, controller)
  }

  remove(appId: string, executionKey: string): void {
    const runs = this.byApp.get(appId)
    if (!runs?.delete(executionKey)) return
    if (runs.size === 0) {
      this.byApp.delete(appId)
      this.onAppBusyChange(appId, false)
    }
  }

  count(appId: string): number {
    return this.byApp.get(appId)?.size ?? 0
  }

  has(appId: string): boolean {
    return this.byApp.has(appId)
  }

  abortApp(appId: string): void {
    for (const controller of this.byApp.get(appId)?.values() ?? []) controller.abort()
  }

  abortAll(): void {
    for (const runs of this.byApp.values()) for (const controller of runs.values()) controller.abort()
  }

  /** appId → number of runs in flight. */
  counts(): Map<string, number> {
    const out = new Map<string, number>()
    for (const [appId, runs] of this.byApp) out.set(appId, runs.size)
    return out
  }
}
