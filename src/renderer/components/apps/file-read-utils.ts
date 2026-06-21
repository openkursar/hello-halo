/**
 * file-read-utils.ts
 *
 * Generic browser File / Directory reading utilities.
 * Shared across skill-import-utils, zip-import-utils, and dialog-level
 * import handlers so none of them carry their own copy.
 */

/** Read a File as UTF-8 text via the FileReader API. */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = e => resolve(e.target!.result as string)
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`))
    reader.readAsText(file)
  })
}

/**
 * Read all entries from a FileSystemDirectoryReader,
 * handling the 100-entry batch limit imposed by the spec.
 */
export async function readAllEntries(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = []
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    )
    if (batch.length === 0) break
    all.push(...batch)
  }
  return all
}

/**
 * Recursively walk a FileSystemDirectoryEntry and return every file's
 * text content keyed by its path relative to the entry root.
 */
export async function readDirectoryEntryToMap(
  entry: FileSystemDirectoryEntry,
  prefix = ''
): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  const entries = await readAllEntries(entry.createReader())

  for (const child of entries) {
    if (child.isFile) {
      const fileEntry = child as FileSystemFileEntry
      const file = await new Promise<File>((resolve, reject) =>
        fileEntry.file(resolve, reject)
      )
      result[prefix + child.name] = await readFileText(file)
    } else if (child.isDirectory) {
      const sub = await readDirectoryEntryToMap(
        child as FileSystemDirectoryEntry,
        prefix + child.name + '/'
      )
      Object.assign(result, sub)
    }
  }
  return result
}

/**
 * Convert a FileList produced by `<input webkitdirectory>` into a flat
 * path → content map. Returns the top-level folder name and all files
 * keyed by paths relative to that folder.
 */
export async function readFileListToMap(
  fileList: FileList
): Promise<{ files: Record<string, string>; folderName: string }> {
  const files: Record<string, string> = {}
  let folderName = ''

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i]
    const relPath =
      (file as { webkitRelativePath?: string }).webkitRelativePath || file.name
    if (!folderName) {
      const slash = relPath.indexOf('/')
      folderName = slash > 0 ? relPath.slice(0, slash) : file.name
    }
    const slash = relPath.indexOf('/')
    const cleanPath = slash > 0 ? relPath.slice(slash + 1) : relPath
    if (cleanPath) {
      files[cleanPath] = await readFileText(file)
    }
  }
  return { files, folderName }
}
