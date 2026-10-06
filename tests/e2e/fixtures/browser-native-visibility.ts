import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { StringDecoder } from 'node:string_decoder'
import { createTestConfigDir, cleanupTestConfigDir, getAppEntryPath } from './electron'

const PREFIX = 'HALO_BROWSER_NATIVE_VISIBILITY '
const LOG_LIMIT = 500000
const require = createRequire(import.meta.url)

export interface NativeVisibilityState {
  visible: boolean
  minimized: boolean
  focused: boolean
}

export interface NativeVisibilityHostState {
  draft: string
  start: number
  end: number
  direction: string
  active: boolean
  marked: boolean
  documentFocus: boolean
  visibility: string
}

export interface NativeFocusTime {
  atMs: number
  sinceStartMs: number
}

export interface NativeFocusSnapshot extends NativeFocusTime {
  stage: string
  native: NativeVisibilityState
  eventSequence: number
  host: NativeVisibilityHostState
  hostSampledAt: NativeFocusTime
  frontmost?: { source: string; pid: number | null; started?: NativeFocusTime; finished?: NativeFocusTime; error?: string }
}

export interface NativeVisibilityFrame {
  width: number
  height: number
  currentPixels: number
  pngBytes: number
  pngSha256: string
  decoder: { name: string; version: string; modulePath: string; nativePath: string; nativeSha256: string; versions: Record<string, string>; colorSpace: string }
  png: { bitDepth: number; colorType: number; gamma: number; chunks: string[]; icc?: { name: string; compressedBytes: number }; iccSha256: string | null; rawCurrentPixels: number; dominantRgba: Array<{ rgba: number[]; pixels: number }>; managedDominantRgba: Array<{ rgba: number[]; pixels: number }> }
  artifact?: string
}

export interface NativeVisibilityResult {
  ok: boolean
  runtime: { electron: string; chromium: string; node: string; mainBundleSha256: string }
  identity?: { mainWindowId: number; mainContentsId: number; guestContentsId: number; mainPid: number; guestPid: number; guestType: string; url: string }
  captureBaseline?: { host: boolean; guest: boolean }
  focusTrace?: { mainProcessPid: number; startedAtMs: number; droppedEvents: number; events: Array<NativeFocusTime & { event: 'focus' | 'blur'; sequence: number; stage: string; native: NativeVisibilityState | null }> }
  states: Array<{
    state: 'parked' | 'minimized' | 'hidden'
    rgb: number[]
    ok?: boolean
    error?: string
    nativeBefore: NativeVisibilityState
    nativeAfter?: NativeVisibilityState
    hostPrepared: NativeVisibilityHostState
    hostBefore: NativeVisibilityHostState
    hostAfter?: NativeVisibilityHostState
    focusTimeline?: NativeFocusSnapshot[]
    captureBoundary?: { started: NativeFocusTime; finished: NativeFocusTime; nativeBefore: NativeVisibilityState; nativeAfter: NativeVisibilityState; eventSequenceBefore: number; eventSequenceAfter: number; hostBefore: NativeVisibilityHostState; hostAfter: NativeVisibilityHostState; rendererStartedAtMs: number; rendererFinishedAtMs: number }
    guestBefore: { url: string; nonce: string; draft: string; scroll: number; ticks: number; visibility: string }
    guestAfter?: { url: string; nonce: string; draft: string; scroll: number; ticks: number; visibility: string }
    ax?: { nodes: number; draft: boolean }
    nativePNG?: NativeVisibilityFrame
    captureBefore: { host: boolean; guest: boolean }
    captureAfter?: { host: boolean; guest: boolean }
    throttlingAfter?: { host: boolean; guest: boolean }
  }>
  cleanup?: { guestReleased: boolean; viewState: unknown; nativeRestored: NativeVisibilityState; throttlingRestored: boolean }
  error?: string
  cleanupError?: string
  diagnostics: string
  exitCode: number | null
}

export async function runNativeBrowserVisibility(url: string): Promise<NativeVisibilityResult> {
  const mainEntry = getAppEntryPath()
  const profile = createTestConfigDir(mainEntry)
  const bootstrap = path.join(path.dirname(mainEntry), `.native-visibility-${randomUUID()}.cjs`)
  const artifactDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '../results', `native-visibility-${randomUUID()}`)
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env
  let child: ReturnType<typeof spawn> | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let killTimeout: ReturnType<typeof setTimeout> | undefined
  let logs = Buffer.alloc(0)
  const terminate = (signal: NodeJS.Signals) => {
    if (!child?.pid) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') logs = Buffer.concat([logs, Buffer.from(`Native child termination failed: ${String(error)}\n`)]).subarray(-LOG_LIMIT)
    }
  }
  try {
    fs.mkdirSync(path.join(profile, 'electron-data', 'user'), { recursive: true })
    fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'browser-native-visibility-main.cjs'), bootstrap)
    const electronPath = require('electron') as string
    return await new Promise<NativeVisibilityResult>((resolve, reject) => {
      let parsed: Omit<NativeVisibilityResult, 'diagnostics' | 'exitCode'> | undefined
      let parseError: Error | undefined
      let timedOut = false
      let partial = ''
      const decoder = new StringDecoder('utf8')
      const diagnose = (chunk: Buffer) => { logs = Buffer.concat([logs, chunk]).subarray(-LOG_LIMIT) }
      const readLine = (line: string) => {
        if (!line.startsWith(PREFIX)) return
        try {
          if (parsed) throw new Error('Native visibility child emitted more than one result')
          parsed = JSON.parse(line.slice(PREFIX.length)) as typeof parsed
        } catch (error) { parseError = error instanceof Error ? error : new Error(String(error)) }
      }
      child = spawn(electronPath, [...(process.env.HALO_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), bootstrap, JSON.stringify({ mainEntry, profile, url })], {
        env: { ...environment, HALO_DATA_DIR: path.join(profile, '.halo'), HALO_E2E_TEST: '1', HALO_SERVER_MODE: '0', ELECTRON_DISABLE_GPU: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
      child.stdout!.on('data', (chunk: Buffer) => {
        diagnose(chunk)
        partial += decoder.write(chunk)
        const lines = partial.split('\n')
        partial = lines.pop() ?? ''
        for (const line of lines) readLine(line)
        if (Buffer.byteLength(partial) > LOG_LIMIT) { parseError = new Error('Native visibility stdout line exceeded the diagnostic bound'); partial = '' }
      })
      child.stderr!.on('data', diagnose)
      child.once('error', error => reject(error))
      child.once('close', (exitCode, signal) => {
        clearTimeout(timeout)
        clearTimeout(killTimeout)
        partial += decoder.end()
        if (partial) readLine(partial)
        const diagnostics = logs.toString('utf8')
        if (timedOut || parseError || !parsed) {
          reject(new Error(`${timedOut ? 'Native visibility child exceeded 60 seconds' : parseError?.message ?? `Native visibility child exited ${exitCode ?? signal} without a result`}\n${diagnostics}`))
          return
        }
        try {
          for (const record of parsed.states) {
            const source = record.nativePNG?.artifact
            if (!source) continue
            const relative = path.relative(profile, source)
            if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Native PNG artifact escaped its isolated profile')
            fs.mkdirSync(artifactDirectory, { recursive: true })
            const destination = path.join(artifactDirectory, `${record.state}.png`)
            fs.copyFileSync(source, destination)
            record.nativePNG!.artifact = destination
          }
        } catch (error) {
          reject(new Error(`Native visibility PNG artifact extraction failed: ${String(error)}\n${diagnostics}`))
          return
        }
        resolve({ ...parsed, diagnostics, exitCode })
      })
      timeout = setTimeout(() => {
        timedOut = true
        terminate('SIGTERM')
        killTimeout = setTimeout(() => terminate('SIGKILL'), 1000)
      }, 60000)
    })
  } finally {
    clearTimeout(timeout)
    clearTimeout(killTimeout)
    if (child && child.exitCode === null && child.signalCode === null) terminate('SIGKILL')
    fs.rmSync(bootstrap, { force: true })
    cleanupTestConfigDir(profile)
  }
}
