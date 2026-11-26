import { randomUUID } from 'crypto'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export function credentialFileOf(credentialDir: string, audience: string): string {
  return join(credentialDir, `${audience}.json`)
}

export function writeCredential(file: string, token: string, expiresAt: number): void {
  const temporary = `${file}.${randomUUID()}.tmp`
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(temporary, JSON.stringify({ token, expiresAt }), { mode: 0o600, flag: 'wx' })
    renameSync(temporary, file)
  } finally {
    try {
      rmSync(temporary, { force: true })
    } catch {
      console.warn('[EnterpriseIdentity] Could not remove a temporary credential file')
    }
  }
}

export function withdrawCredential(file: string): boolean {
  let replaced = false
  try {
    writeCredential(file, '', 0)
    replaced = true
  } catch {
    // Unlink can still succeed when a temporary file cannot be created or renamed.
  }
  try {
    rmSync(file, { force: true })
    return true
  } catch {
    return replaced
  }
}
