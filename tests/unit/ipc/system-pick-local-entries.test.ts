/**
 * The native picker behind "+" → Files and folders. The OS dialog and the
 * disk are stubbed; what is checked is how a pick becomes entries.
 */

import { beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  handlers: {} as Record<string, (...args: any[]) => Promise<any>>,
  showOpenDialog: vi.fn(),
  files: new Map<string, { dir?: boolean; size: number; bytes?: Buffer }>(),
}))

vi.mock('electron', () => ({ app: {}, shell: {}, dialog: { showOpenDialog: env.showOpenDialog } }))
vi.mock('fs/promises', () => ({
  stat: vi.fn(async (path: string) => {
    const f = env.files.get(path)
    if (!f) throw new Error('ENOENT')
    return { isDirectory: () => !!f.dir, size: f.size }
  }),
  readFile: vi.fn(async (path: string) => env.files.get(path)!.bytes ?? Buffer.alloc(0)),
}))
vi.mock('electron-log/main.js', () => ({ default: { transports: { file: { getFile: () => ({ path: '/logs/main.log' }) } } } }))
vi.mock('../../../src/main/foundation/config.service', () => ({ setAutoLaunch: vi.fn(), getAutoLaunch: vi.fn() }))
vi.mock('../../../src/main/foundation/window.service', () => ({ getMainWindow: () => null, onMainWindowChange: vi.fn() }))
vi.mock('../../../src/main/foundation/logging', () => ({ logFatal: vi.fn() }))
vi.mock('../../../src/main/services/lifecycle', () => ({ relaunchApp: vi.fn() }))
vi.mock('../../../src/main/services/perf', () => ({ countPendingCrashDumps: () => 0 }))
vi.mock('../../../src/main/ipc/rpc', () => ({ registerRawRpcHandlers: (_c: unknown, impl: any) => { env.handlers = impl } }))

import { registerSystemHandlers } from '../../../src/main/ipc/system'

const platform = process.platform
beforeEach(() => {
  env.files.clear()
  env.showOpenDialog.mockReset()
  Object.defineProperty(process, 'platform', { value: platform })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
  registerSystemHandlers()
})

const pick = () => env.handlers.pickLocalEntries()

it('a cancelled dialog attaches nothing', async () => {
  env.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  expect(await pick()).toEqual({ success: true, data: [] })
})

it('multiple files and folders come back in order, folders marked', async () => {
  env.files.set('/a/report final.pdf', { size: 100 })
  env.files.set('/a/site', { dir: true, size: 0 })
  env.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a/report final.pdf', '/a/site'] })
  expect(await pick()).toEqual({
    success: true,
    data: [
      { path: '/a/report final.pdf', isDirectory: false },
      { path: '/a/site', isDirectory: true },
    ],
  })
})

it('a supported image is sent inline; an oversized one falls back to its path', async () => {
  env.files.set('/a/shot.PNG', { size: 3, bytes: Buffer.from('abc') })
  env.files.set('/a/huge.jpg', { size: 21 * 1024 * 1024 })
  env.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a/shot.PNG', '/a/huge.jpg'] })
  const { data } = await pick()
  expect(data[0]).toEqual({ path: '/a/shot.PNG', isDirectory: false, image: { data: 'YWJj', mediaType: 'image/png', size: 3 } })
  expect(data[1]).toEqual({ path: '/a/huge.jpg', isDirectory: false })
})

it('an entry that cannot be read is skipped, the rest still attach', async () => {
  env.files.set('/a/ok.txt', { size: 1 })
  env.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/a/gone.txt', '/a/ok.txt'] })
  expect((await pick()).data).toEqual([{ path: '/a/ok.txt', isDirectory: false }])
})

it('macOS offers files and folders in one panel; other platforms offer files', async () => {
  env.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  await pick()
  expect(env.showOpenDialog.mock.calls.at(-1)![0].properties).toEqual(['openFile', 'openDirectory', 'multiSelections'])
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await pick()
  expect(env.showOpenDialog.mock.calls.at(-1)![0].properties).toEqual(['openFile', 'multiSelections'])
})

it('a dialog failure is reported, not thrown', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  env.showOpenDialog.mockRejectedValue(new Error('no window'))
  expect(await pick()).toEqual({ success: false, error: 'no window' })
})
