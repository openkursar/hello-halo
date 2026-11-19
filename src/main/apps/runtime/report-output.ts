import { access, realpath, stat } from 'fs/promises'
import { constants } from 'fs'
import { join, resolve } from 'path'
import { isCanonicalWithin } from '../../foundation/path-containment'

export const reportOutputDir = (workDir: string) => join(workDir, 'outputs')

export async function resolveReportFile(
  path: string,
  workDir?: string,
  refuse?: (realPath: string) => string | null,
): Promise<string> {
  if (!workDir) throw new Error('No workspace is available for this report. Provide the report inline instead.')
  const guidance = `Write your report under ${reportOutputDir(workDir)} and report its path, or provide it inline.`
  const [file, root] = await Promise.all([realpath(resolve(workDir, path)), realpath(workDir)]).catch(() => {
    throw new Error(`The report file could not be located. ${guidance}`)
  })
  if (!isCanonicalWithin(file, root)) throw new Error(`The report file is outside this workspace. ${guidance}`)
  const refusal = refuse?.(file)
  if (refusal) throw new Error(refusal)
  try {
    if (!(await stat(file)).isFile()) throw new Error('Not a file')
    await access(file, constants.R_OK)
  } catch {
    throw new Error(`The report path is not a readable file. ${guidance}`)
  }
  return file
}
