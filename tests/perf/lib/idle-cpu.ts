import type { ElectronApplication } from '@playwright/test'

export interface IdleCpuResult {
  avgPercent: number
  maxPercent: number
  /** Average of the first 15 samples — per Lead, the "rendering tail" signal (e.g. markdown's post-open CPU burn) lives here, and gets diluted into invisibility by a 60s-window avgPercent. */
  first15AvgPercent: number
  samples: number[]
  failedTicks: number
  totalTicks: number
}

/**
 * Samples total CPU (sum of `percentCPUUsage` across every process) once a
 * second for `durationMs`, while the caller does nothing else. Required by
 * Lead for S4/S5/S6, same cadence VS Code is measured with (WP2), so the two
 * sides are comparable: "a normal editor should fall back near 0 once a file
 * is done rendering — if it doesn't, that's the smoking gun for 打开预览后
 * CPU 起不来 that stays up once you start chatting."
 *
 * Per WP7 harness audit P0-3: if the app is genuinely hung for the whole
 * window — exactly the case this sampler exists to catch — every tick fails
 * and an empty `samples` array used to report `avgPercent: 0`, i.e. "idled
 * perfectly", which is the opposite of what happened. `failedTicks` /
 * `totalTicks` make that distinguishable from a real, low, healthy reading.
 */
export async function sampleIdleCpu(
  app: ElectronApplication,
  durationMs = 60000,
  intervalMs = 1000
): Promise<IdleCpuResult> {
  const samples: number[] = []
  const ticks = Math.floor(durationMs / intervalMs)
  let failedTicks = 0

  for (let i = 0; i < ticks; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
    try {
      const total = await app.evaluate(({ app }) =>
        app.getAppMetrics().reduce((sum, m) => sum + m.cpu.percentCPUUsage, 0)
      )
      samples.push(total)
    } catch {
      // App unreachable this tick — counted, not silently dropped (see failedTicks).
      failedTicks++
    }
  }

  const first15 = samples.slice(0, 15)

  return {
    avgPercent: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0,
    maxPercent: samples.length ? Math.max(...samples) : 0,
    first15AvgPercent: first15.length ? first15.reduce((a, b) => a + b, 0) / first15.length : 0,
    samples,
    failedTicks,
    totalTicks: ticks
  }
}
