import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { isRendererFatal } from './renderer-fatal'

/** Copies a fixture file into the test space's artifacts folder so it shows up in the 产物 panel on boot. */
export function seedArtifact(testConfigDir: string, fixtureAbsPath: string): { name: string; destPath: string } {
  const name = path.basename(fixtureAbsPath)
  const destDir = path.join(testConfigDir, '.halo', 'temp', 'artifacts')
  fs.mkdirSync(destDir, { recursive: true })
  const destPath = path.join(destDir, name)
  fs.copyFileSync(fixtureAbsPath, destPath)
  return { name, destPath }
}

/**
 * Clicks the artifact card matching `name` in the 产物 panel — mirrors a real
 * user opening a file preview. `noWaitAfter` skips Playwright's own
 * post-click "wait for navigations" step: a huge file can block the renderer
 * main thread long enough that even that housekeeping round-trip stalls,
 * which would corrupt our own open-duration measurement (that stall itself
 * is exactly what the wait below is meant to time, not an artifact of how we
 * dispatched the click).
 */
export async function clickArtifactByName(window: Page, name: string): Promise<void> {
  const card = window.getByText(name, { exact: true }).first()
  await card.waitFor({ state: 'visible', timeout: 15000 })
  await card.click({ noWaitAfter: true })
}

const OBSERVATION_KEY = '__perfOpenObservation'

/**
 * Starts the clock for an open. Must be called immediately *before* the click
 * that opens the file, and paired with one of the waits below.
 *
 * Starting it after the click looks equivalent and is not: a viewer that has
 * already painted by the time the next round-trip lands leaves nothing left to
 * observe, and the open is reported as 0ms.
 */
export async function beginOpenObservation(window: Page): Promise<void> {
  await window.evaluate((key: string) => {
    const holder = window as unknown as Record<string, unknown>
    const previous = holder[key] as { stop?: () => void } | undefined
    previous?.stop?.()

    const observers: MutationObserver[] = []
    const state = {
      start: performance.now(),
      last: null as number | null,
      observers,
      bump: () => { state.last = performance.now() },
      stop: () => { for (const o of observers) o.disconnect(); observers.length = 0 }
    }
    const root = new MutationObserver(state.bump)
    root.observe(document.body, { childList: true, subtree: true, characterData: true })
    observers.push(root)
    holder[key] = state
  }, OBSERVATION_KEY)
}

/**
 * Returns how long the open actually took, measured from `beginOpenObservation`
 * to the last DOM change the open produced.
 *
 * Two earlier approaches both produced a number that was not the open
 * duration. Waiting for a `Loading...` indicator to appear, with the timeout
 * swallowed, charged a flat 3s to every fast open — the whole column read
 * 3,133-3,158ms regardless of content, which is the measurement floor rather
 * than the truth. Waiting only for the tab's spinner to clear went the other
 * way: `tab.isLoading` tracks reading the file's bytes, not painting them, so
 * a 2MB markdown resolved with 4 characters on screen and the real render
 * landing ~3s later.
 *
 * The quiet period spent confirming nothing else changed is not charged to the
 * result, which is what keeps this from becoming a new floor — `quietMs`
 * affects only how long the call blocks, never the number it returns. Mutation
 * counting is also content-agnostic: a virtualized list and a plain `<pre>`
 * both churn the DOM while they build and stop when they are done, so no
 * viewer needs a bespoke readiness signal.
 */
export async function waitForCanvasLoaded(window: Page, timeoutMs = 60000): Promise<number> {
  return waitForActiveTabReady(window, timeoutMs, false)
}

/**
 * pdf/browser tabs bypass ContentCanvas's `tab.isLoading` branch — they render
 * `BrowserViewer`, which keeps a full-area overlay up until its BrowserView (a
 * separate Electron renderer process) reports ready. The page-side DOM goes
 * quiet while that overlay is still up, so it has to be checked explicitly.
 */
export async function waitForPdfLoaded(window: Page, timeoutMs = 60000): Promise<number> {
  return waitForActiveTabReady(window, timeoutMs, true)
}

/** How long the content area must stay unchanged before the open counts as done. */
const QUIET_MS = 1500

async function waitForActiveTabReady(window: Page, timeoutMs: number, browserView: boolean): Promise<number> {
  const settle = window.evaluate(
    (args: { key: string; timeoutMs: number; quietMs: number; browserView: boolean }) =>
      new Promise<number>((resolve, reject) => {
        const holder = window as unknown as Record<string, unknown>
        const state = holder[args.key] as
          | { start: number; last: number | null; observers: MutationObserver[]; bump: () => void; stop: () => void }
          | undefined
        if (!state) {
          reject(new Error('No open observation in progress — beginOpenObservation() must run before the click that opens the file.'))
          return
        }
        const finish = (act: () => void) => { state.stop(); delete holder[args.key]; act() }

        const observedFrames = new Set<Node>()

        const tick = () => {
          const bar = document.querySelector('.canvas-tab-bar')
          const icon = bar?.querySelector('.canvas-tab.active .canvas-tab-icon')
          const content = bar?.nextElementSibling ?? null

          // An iframe viewer builds into a child document the page-level
          // observer cannot see, so its render would be charged as zero.
          let frameBusy = false
          for (const frame of Array.from(content?.querySelectorAll('iframe') ?? [])) {
            let doc: Document | null = null
            try { doc = (frame as HTMLIFrameElement).contentDocument } catch { doc = null }
            if (!doc) { frameBusy = true; continue }
            if (doc.readyState !== 'complete') frameBusy = true
            if (doc.body && !observedFrames.has(doc.body)) {
              observedFrames.add(doc.body)
              state.last = performance.now()
              const o = new MutationObserver(state.bump)
              o.observe(doc.body, { childList: true, subtree: true, characterData: true })
              state.observers.push(o)
            }
          }

          const now = performance.now()
          if (now - state.start > args.timeoutMs) {
            const why = state.last === null
              ? 'nothing in the DOM changed at all — the click does not look like it opened anything'
              : 'the content area never stopped changing'
            finish(() => reject(new Error(`Canvas did not settle within ${args.timeoutMs}ms: ${why}`)))
            return
          }

          // The tab spinner and the BrowserView overlay can both sit still
          // while work continues off the page's DOM, so neither may be up
          // when the quiet period is judged to have started.
          const busy = frameBusy || Boolean(icon?.querySelector('.animate-spin')) ||
            (args.browserView && Boolean(content?.querySelector('.absolute.inset-0 .animate-spin')))

          if (state.last !== null && !busy && now - state.last >= args.quietMs) {
            const openMs = state.last - state.start
            finish(() => resolve(openMs))
            return
          }
          setTimeout(tick, 50)
        }
        tick()
      }),
    { key: OBSERVATION_KEY, timeoutMs, quietMs: QUIET_MS, browserView }
  )

  // The in-page timer cannot fire while the renderer is blocked, so a hard
  // enough hang would leave the evaluate above pending forever.
  const openMs = await Promise.race([
    settle,
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout ${timeoutMs}ms exceeded waiting for the canvas to settle`)), timeoutMs + QUIET_MS + 5000)
    )
  ])

  await assertTabDidNotFail(window)
  // A zero would read as an instant open. It means the observation missed the
  // render, not that there was none — report nothing rather than that.
  if (!(openMs > 0)) {
    throw new Error(`Open measured as ${openMs}ms — no DOM change was attributed to the open, so this is a measurement failure, not a fast load.`)
  }
  return openMs
}

/**
 * A tab can settle into `tab.error` ("Failed to load"), which clears the
 * spinner without anything having rendered. Reporting that as a fast open is
 * the same failure mode as counting a white screen as an instant load.
 */
async function assertTabDidNotFail(window: Page): Promise<void> {
  if (await isRendererFatal(window)) {
    throw new Error('Renderer fell back to its root error boundary — the whole UI is gone, not just this tab.')
  }
  const failed = await window.evaluate(() => {
    const tab = document.querySelector('.canvas-tab-bar .canvas-tab.active')
    return Boolean(tab?.querySelector('.canvas-tab-icon .text-destructive'))
  })
  if (failed) {
    throw new Error('Canvas tab settled into its error state — the file failed to load, this is not a completed open.')
  }
  const emptyState = await window.getByText(/No files open/i).count()
  if (emptyState > 0) {
    throw new Error('Canvas still shows "No files open" — the file never actually opened (not a fast load).')
  }
}
