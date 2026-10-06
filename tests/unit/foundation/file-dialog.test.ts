import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const native = vi.hoisted(() => ({ open: vi.fn(), save: vi.fn() }))

vi.mock('electron', () => ({
  app: { getPath: () => join(globalThis.__HALO_TEST_DIR__, '.halo') },
  dialog: { showOpenDialog: native.open, showSaveDialog: native.save },
}))

const loadDialogs = () => import('../../../src/main/foundation/file-dialog')
const stateFile = () => join(globalThis.__HALO_TEST_DIR__, '.halo', 'native-dialog-state.json')

beforeEach(() => {
  vi.resetModules()
  native.open.mockReset()
  native.save.mockReset()
  native.open.mockResolvedValue({ canceled: true, filePaths: [] })
  native.save.mockResolvedValue({ canceled: true })
})

describe('native file dialog directory memory', () => {
  it('restores a successful selection after the facade is reloaded', async () => {
    const directory = join(globalThis.__HALO_TEST_DIR__, 'sources')
    await mkdir(directory)
    const selection = { canceled: false, filePaths: [join(directory, 'report.txt')] }
    native.open.mockResolvedValueOnce(selection)
    expect(await (await loadDialogs()).showOpenDialog({ properties: ['openFile'] })).toBe(selection)
    expect(JSON.parse(await readFile(stateFile(), 'utf8'))).toEqual({ open: directory })

    vi.resetModules()
    await (await loadDialogs()).showOpenDialog({ properties: ['openFile'] })
    expect(native.open).toHaveBeenLastCalledWith({ properties: ['openFile'], defaultPath: directory })
  })

  it('keeps canceled selections from changing saved state', async () => {
    const directory = join(globalThis.__HALO_TEST_DIR__, 'sources')
    await mkdir(directory)
    await mkdir(join(globalThis.__HALO_TEST_DIR__, '.halo'), { recursive: true })
    await writeFile(stateFile(), JSON.stringify({ open: directory }))
    await (await loadDialogs()).showOpenDialog({})
    expect(JSON.parse(await readFile(stateFile(), 'utf8'))).toEqual({ open: directory })
  })

  it('preserves explicit paths and the native window overload', async () => {
    const dialogs = await loadDialogs()
    const window = {} as import('electron').BaseWindow
    await dialogs.showOpenDialog(window, { defaultPath: '/explicit', properties: ['openDirectory'] })
    expect(native.open).toHaveBeenCalledWith(window, { defaultPath: '/explicit', properties: ['openDirectory'] })
    await dialogs.showSaveDialog({ defaultPath: 'report.dhpkg' })
    expect(native.save).toHaveBeenCalledWith({ defaultPath: 'report.dhpkg' })
  })

  it('falls back once when the previous directory has disappeared', async () => {
    const directory = join(globalThis.__HALO_TEST_DIR__, 'deleted')
    await mkdir(directory)
    native.open.mockResolvedValueOnce({ canceled: false, filePaths: [join(directory, 'report.txt')] })
    const dialogs = await loadDialogs()
    await dialogs.showOpenDialog({})
    await rm(directory, { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await dialogs.showOpenDialog({})
      await dialogs.showOpenDialog({})
      expect(native.open).toHaveBeenLastCalledWith({})
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('remembers open and save directories independently', async () => {
    const openDirectory = join(globalThis.__HALO_TEST_DIR__, 'sources')
    const saveDirectory = join(globalThis.__HALO_TEST_DIR__, 'exports')
    await Promise.all([mkdir(openDirectory), mkdir(saveDirectory)])
    const dialogs = await loadDialogs()
    native.open.mockResolvedValueOnce({ canceled: false, filePaths: [join(openDirectory, 'report.txt')] })
    native.save.mockResolvedValueOnce({ canceled: false, filePath: join(saveDirectory, 'report.dhpkg') })
    await Promise.all([dialogs.showOpenDialog({}), dialogs.showSaveDialog({})])
    expect(JSON.parse(await readFile(stateFile(), 'utf8'))).toEqual({ open: openDirectory, save: saveDirectory })
    await dialogs.showOpenDialog({})
    await dialogs.showSaveDialog({})
    expect(native.open).toHaveBeenLastCalledWith({ defaultPath: openDirectory })
    expect(native.save).toHaveBeenLastCalledWith({ defaultPath: saveDirectory })
  })

  it('returns the native selection when state cannot be persisted', async () => {
    await rm(join(globalThis.__HALO_TEST_DIR__, '.halo'), { recursive: true })
    await writeFile(join(globalThis.__HALO_TEST_DIR__, '.halo'), 'not a directory')
    const selection = { canceled: false, filePath: join(globalThis.__HALO_TEST_DIR__, 'report.dhpkg') }
    native.save.mockResolvedValueOnce(selection)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await (await loadDialogs()).showSaveDialog({})).toBe(selection)
      expect(warn).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })
})
