/**
 * Local command-line tool management: file pickers, the preview → confirm
 * handshake, and translating store refusals into codes. The rules themselves
 * live in services/cli-tools.
 *
 * A picked file is remembered here under a random id for a few minutes, so
 * the renderer confirms "the file I previewed" without ever sending a path:
 * nothing outside the native dialog can name a file to import or register.
 */

import { randomUUID } from 'crypto'
import { basename } from 'path'
import { showOpenDialog } from '../foundation/file-dialog'
import {
  getCliToolsOverview,
  importUserPackage,
  isCliToolError,
  previewUserPackage,
  reconfirmExternalProgram,
  registerExternalProgram,
  removeCliTool,
  removeCliToolVersion,
  setCliToolCurrent,
  setCliToolDisabled,
} from '../services/cli-tools'
import type {
  CliExternalPick, CliPackagePreviewView, CliRegisterExternalInput, CliToolsErrorCode, CliToolsOverview, CliToolsResult,
} from '../../shared/types/cli-tools'

const PICK_TTL_MS = 10 * 60 * 1000

interface PendingPick {
  kind: 'package' | 'external'
  path: string
  archiveSha256?: string
  interpreter?: 'halo-node' | null
  expires: number
}

const picks = new Map<string, PendingPick>()

function remember(pick: Omit<PendingPick, 'expires'>): string {
  const now = Date.now()
  for (const [id, p] of picks) if (p.expires < now) picks.delete(id)
  const id = randomUUID()
  picks.set(id, { ...pick, expires: now + PICK_TTL_MS })
  return id
}

function take(id: string, kind: PendingPick['kind']): PendingPick | null {
  const pick = picks.get(id)
  picks.delete(id)
  return pick && pick.kind === kind && pick.expires >= Date.now() ? pick : null
}

function fail(err: unknown): { ok: false; code: CliToolsErrorCode; message: string } {
  if (isCliToolError(err)) return { ok: false, code: err.code, message: err.message }
  console.error('[CliTools] Management action failed', err)
  return { ok: false, code: 'UNEXPECTED', message: err instanceof Error ? err.message : String(err) }
}

async function withOverview(action: () => Promise<unknown>): Promise<CliToolsResult<CliToolsOverview>> {
  try {
    await action()
    return { ok: true, data: await getCliToolsOverview() }
  } catch (err) {
    return fail(err)
  }
}

export function overview(): Promise<CliToolsOverview> {
  return getCliToolsOverview()
}

export const setCurrent = (input: { id: string; version: string }) =>
  withOverview(() => setCliToolCurrent(String(input.id), String(input.version)))

export const setDisabled = (input: { id: string; disabled: boolean }) =>
  withOverview(() => setCliToolDisabled(String(input.id), input.disabled === true))

export const removeVersion = (input: { id: string; version: string }) =>
  withOverview(() => removeCliToolVersion(String(input.id), String(input.version)))

export const removeTool = (input: { id: string }) => withOverview(() => removeCliTool(String(input.id)))

export const reconfirmExternal = (input: { id: string }) => withOverview(() => reconfirmExternalProgram(String(input.id)))

/** Pick a `.hcli`, validate it in staging and describe it. Null when the user cancels. */
export async function pickPackage(): Promise<CliToolsResult<CliPackagePreviewView | null>> {
  const result = await showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Halo CLI package', extensions: ['hcli'] }],
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null }
  const path = result.filePaths[0]
  try {
    const preview = await previewUserPackage(path)
    const previewId = remember({ kind: 'package', path, archiveSha256: preview.archiveSha256 })
    return {
      ok: true,
      data: {
        previewId,
        fileName: basename(path),
        id: preview.id,
        name: preview.name ?? preview.id,
        ...(preview.description ? { description: preview.description } : {}),
        version: preview.version,
        commands: preview.commands.map(name => ({ name, clash: preview.clashes[name] ?? null })),
        platforms: preview.platforms,
        ...(preview.minNode ? { minNode: preview.minNode } : {}),
        ...(preview.sideEffects ? { sideEffects: preview.sideEffects } : {}),
        ...(preview.auth ? { auth: preview.auth } : {}),
        archiveBytes: preview.archiveBytes,
        payloadBytes: preview.payloadBytes,
        files: preview.files,
        skill: preview.skill,
        existing: preview.existing,
        sameVersion: preview.sameVersion,
      },
    }
  } catch (err) {
    return fail(err)
  }
}

/** Import the previewed file; the archive must still have the previewed digest. */
export async function confirmImport(input: { previewId: string; makeCurrent: boolean }): Promise<CliToolsResult<CliToolsOverview>> {
  const pick = take(String(input.previewId), 'package')
  if (!pick?.archiveSha256) return { ok: false, code: 'EXPIRED', message: 'the preview expired; choose the file again' }
  return withOverview(() => importUserPackage(pick.path, { archiveSha256: pick.archiveSha256!, makeCurrent: input.makeCurrent === true }))
}

export async function cancelImport(input: { previewId: string }): Promise<void> {
  picks.delete(String(input.previewId))
}

function suggestCommand(fileName: string): string {
  const stem = fileName.replace(/\.(c|m)?js$/i, '').replace(/\.(exe|cmd|bat|com)$/i, '')
  const cleaned = stem.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').replace(/^halo-/, '').slice(0, 64)
  return cleaned || 'tool'
}

/** Pick an existing program. Nothing is read beyond the file name until registration. */
export async function pickExternal(): Promise<CliToolsResult<CliExternalPick | null>> {
  const result = await showOpenDialog({ properties: ['openFile'] })
  if (result.canceled || result.filePaths.length === 0) return { ok: true, data: null }
  const path = result.filePaths[0]
  const fileName = basename(path)
  const interpreter = /\.(c|m)?js$/i.test(fileName) ? 'halo-node' as const : null
  const pickId = remember({ kind: 'external', path, interpreter })
  return { ok: true, data: { pickId, path, fileName, interpreter, suggestedCommand: suggestCommand(fileName) } }
}

export async function registerExternal(input: CliRegisterExternalInput): Promise<CliToolsResult<CliToolsOverview>> {
  const pick = take(String(input.pickId), 'external')
  if (!pick) return { ok: false, code: 'EXPIRED', message: 'the selection expired; choose the program again' }
  const result = await withOverview(() => registerExternalProgram({
    path: pick.path,
    interpreter: pick.interpreter ?? null,
    command: String(input.command ?? ''),
    name: String(input.name ?? ''),
    ...(input.description ? { description: String(input.description) } : {}),
  }))
  // A rejected form keeps the selection so the user can fix a field and retry.
  if (!result.ok) picks.set(String(input.pickId), { ...pick, expires: Date.now() + PICK_TTL_MS })
  return result
}
