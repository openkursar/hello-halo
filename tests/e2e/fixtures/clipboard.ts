import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { ElectronApplication } from '@playwright/test'

let macHelper: string | undefined

function macClipboardHelper(): string {
  if (macHelper) return macHelper
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'halo-e2e-clipboard-'))
  const executable = path.join(directory, 'clipboard')
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), 'clipboard-macos.swift')
  try {
    execFileSync('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', executable], { stdio: 'ignore' })
  } catch {
    fs.rmSync(directory, { recursive: true, force: true })
    throw new Error('Could not compile the public macOS clipboard test helper')
  }
  macHelper = executable
  process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }))
  return executable
}

/** Electron 43 cannot batch custom formats; AppKit preserves the original raw items without logging them. */
export async function preserveSystemClipboard(app: ElectronApplication, rawFormats: string[] = []): Promise<() => Promise<void>> {
  if (process.platform === 'darwin') {
    const helper = macClipboardHelper()
    let snapshot: Buffer
    try { snapshot = execFileSync(helper, ['capture'], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch { throw new Error('Could not preserve every original clipboard item and format') }
    return async () => {
      try { execFileSync(helper, ['restore'], { input: snapshot, stdio: ['pipe', 'ignore', 'ignore'] }) }
      catch { throw new Error('Could not restore the original clipboard items and formats') }
    }
  }
  const key = randomUUID()
  await app.evaluate(({ clipboard }, { key, rawFormats }) => {
    const formats = clipboard.availableFormats()
    const standard = ['text/plain', 'text/html', 'text/rtf', 'image/png', 'image/jpeg', 'image/bmp', 'image/tiff']
    if (formats.some(format => !standard.includes(format) && !rawFormats.includes(format))) {
      throw new Error('Complete restoration of the original custom clipboard formats is unavailable on this platform')
    }
    if (rawFormats.length > 1 || (rawFormats.length && formats.some(format => standard.includes(format)))) {
      throw new Error('This clipboard snapshot requires unavailable batch raw-format restoration')
    }
    type SavedClipboard = { data: Electron.Data; raw?: { format: string; data: Buffer } }
    const state = globalThis as unknown as { carrierClipboardSnapshots?: Map<string, SavedClipboard> }
    const snapshots = state.carrierClipboardSnapshots ??= new Map()
    snapshots.set(key, {
      data: { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF(), image: clipboard.readImage() },
      raw: rawFormats.length ? { format: rawFormats[0], data: clipboard.readBuffer(rawFormats[0]) } : undefined,
    })
  }, { key, rawFormats })
  return async () => app.evaluate(({ clipboard }, key) => {
    type SavedClipboard = { data: Electron.Data; raw?: { format: string; data: Buffer } }
    const state = globalThis as unknown as { carrierClipboardSnapshots?: Map<string, SavedClipboard> }
    const saved = state.carrierClipboardSnapshots?.get(key)
    if (!saved) throw new Error('Original clipboard snapshot is missing')
    if (saved.raw) clipboard.writeBuffer(saved.raw.format, saved.raw.data)
    else clipboard.write(saved.data)
    state.carrierClipboardSnapshots!.delete(key)
    if (!state.carrierClipboardSnapshots!.size) delete state.carrierClipboardSnapshots
  }, key)
}
