import {
  app,
  dialog,
  type BaseWindow,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
} from 'electron'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

type DialogKind = 'open' | 'save'
type DialogDirectories = Partial<Record<DialogKind, string>>

const directories: DialogDirectories = {}
let loaded: Promise<void> | undefined
let pendingWrite = Promise.resolve()

function statePath(): string {
  return join(app.getPath('userData'), 'native-dialog-state.json')
}

async function loadDirectories(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const file = statePath()
        if ((await stat(file)).size > 64 * 1024) throw new Error('Dialog directory state exceeds its size limit')
        const saved: unknown = JSON.parse(await readFile(file, 'utf8'))
        if (!saved || typeof saved !== 'object') throw new Error('Invalid dialog directory state')
        for (const kind of ['open', 'save'] as const) {
          const value = (saved as DialogDirectories)[kind]
          if (typeof value === 'string' && isAbsolute(value)) {
            directories[kind] = value
          } else if (value !== undefined) {
            console.warn(`[FileDialog] Invalid saved ${kind} directory was ignored`)
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn('[FileDialog] Last-used directory state could not be read:', error)
        }
      }
    })()
  }
  await loaded
}

async function defaultDirectory(kind: DialogKind): Promise<string | undefined> {
  await loadDirectories()
  const directory = directories[kind]
  if (!directory) return undefined
  try {
    if ((await stat(directory)).isDirectory()) return directory
    console.warn(`[FileDialog] Saved ${kind} directory is no longer a directory; using the system default`)
  } catch (error) {
    console.warn(`[FileDialog] Saved ${kind} directory is unavailable; using the system default:`, error)
  }
  delete directories[kind]
  return undefined
}

async function rememberDirectory(kind: DialogKind, selectedPath: string | undefined): Promise<void> {
  if (!selectedPath || !isAbsolute(selectedPath)) {
    console.warn(`[FileDialog] Native ${kind} selection has no absolute path; directory memory was not updated`)
    return
  }
  await loadDirectories()
  const directory = dirname(selectedPath)
  if (directories[kind] === directory) return
  directories[kind] = directory
  // Serialize writes so concurrent dialogs cannot overwrite a newer selection.
  pendingWrite = pendingWrite.then(async () => {
    try {
      const file = statePath()
      await mkdir(dirname(file), { recursive: true })
      await writeFile(`${file}.tmp`, JSON.stringify(directories), { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    } catch (error) {
      console.warn(`[FileDialog] Last-used ${kind} directory could not be saved:`, error)
    }
  })
  await pendingWrite
}

export function showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
export function showOpenDialog(window: BaseWindow, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
export async function showOpenDialog(
  windowOrOptions: BaseWindow | OpenDialogOptions,
  suppliedOptions?: OpenDialogOptions,
): Promise<OpenDialogReturnValue> {
  const options = suppliedOptions ?? windowOrOptions as OpenDialogOptions
  const defaultPath = options.defaultPath ?? await defaultDirectory('open')
  const resolved = defaultPath === undefined ? options : { ...options, defaultPath }
  const result = suppliedOptions
    ? await dialog.showOpenDialog(windowOrOptions as BaseWindow, resolved)
    : await dialog.showOpenDialog(resolved)
  if (!result.canceled) await rememberDirectory('open', result.filePaths[0])
  return result
}

export function showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
export function showSaveDialog(window: BaseWindow, options: SaveDialogOptions): Promise<SaveDialogReturnValue>
export async function showSaveDialog(
  windowOrOptions: BaseWindow | SaveDialogOptions,
  suppliedOptions?: SaveDialogOptions,
): Promise<SaveDialogReturnValue> {
  const options = suppliedOptions ?? windowOrOptions as SaveDialogOptions
  const defaultPath = options.defaultPath ?? await defaultDirectory('save')
  const resolved = defaultPath === undefined ? options : { ...options, defaultPath }
  const result = suppliedOptions
    ? await dialog.showSaveDialog(windowOrOptions as BaseWindow, resolved)
    : await dialog.showSaveDialog(resolved)
  if (!result.canceled) await rememberDirectory('save', result.filePath)
  return result
}
