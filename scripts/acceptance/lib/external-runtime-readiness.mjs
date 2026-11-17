import fs from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

export async function externalRuntimeFailure(runtimeId, { environment = process.env, digest = fileDigest } = {}) {
  const codex = runtimeId === 'codex'
  const variable = codex ? 'HALO_ACCEPTANCE_CODEX_CLI' : 'HALO_ACCEPTANCE_CLAUDE_CLI'
  const executable = environment[variable]
  if (!executable || !path.isAbsolute(executable)) return `${variable} must name an explicit absolute external runtime path; personal PATH is not searched`
  try {
    const stat = await fs.stat(executable)
    if (!stat.isFile()) return `${variable} must name a regular executable file`
    await fs.access(executable, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    if (!codex) return null
    const receiptPath = environment.HALO_ACCEPTANCE_CODEX_PROVENANCE
    if (!receiptPath || !path.isAbsolute(receiptPath)) return 'HALO_ACCEPTANCE_CODEX_PROVENANCE must name an explicit artifact identity receipt'
    const receiptStat = await fs.stat(receiptPath)
    if (receiptStat.size > 65536) return 'The external Codex artifact identity receipt exceeds its size limit'
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'))
    if (receipt.version !== '0.128.0' || receipt.platform !== process.platform || receipt.arch !== process.arch || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')) return 'The external Codex receipt must identify version 0.128.0 and this platform with a SHA-256 digest'
    if (await fs.realpath(executable) !== await fs.realpath(receipt.executable)) return 'The external Codex receipt identifies a different executable'
    if (await digest(executable) !== receipt.sha256) return 'The external Codex bytes do not match the recorded SHA-256 identity'
    if (receipt.execution?.state === 'blocked') return 'The fixed external Codex artifact cannot execute on this host; its recorded OS execution prerequisite is blocked'
    return null
  } catch {
    return `The configured external ${codex ? 'Codex' : 'Claude Code'} artifact or identity receipt is unavailable or invalid`
  }
}

async function fileDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
