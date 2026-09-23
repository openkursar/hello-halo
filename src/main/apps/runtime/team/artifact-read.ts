/**
 * Location-transparent access to a published artifact.
 *
 * One rule finds the producing member on the team board (a publishing finding's
 * author, or the assignee of a task delivering the ref as resultRef); the bytes
 * then come from wherever that member lives — this node's disk for a
 * same-machine producer, pulled from the owner node for a remote one via the
 * injected remote fetch.
 *
 * Two consumers sit on that rule, because they answer to different audiences:
 *
 *  - the AGENT reader behind `team_read_artifact` decodes text under a size
 *    ceiling with a binary guard, so a huge or binary file never floods the
 *    model context, and turns every failure into actionable guidance rather
 *    than a raw technical code;
 *  - the PERSON opener behind clicking a shared file hands back a path the OS
 *    can open. A file produced on this machine is opened where it is; a
 *    teammate's is copied here first, read-only — someone editing a copy of
 *    another person's file must not believe they changed the original.
 *
 * They must stay on one resolution: a ref that names one member's file for the
 * agent and another's for the person is the worst kind of wrong.
 *
 * Kernel-clean: transport is injected. Bootstrap supplies the space lookup and
 * the federation-backed remote fetch; absent a remote fetch, cross-machine
 * access degrades to an honest "unavailable" instead of a fake not-found.
 */

import { createHash } from 'crypto'
import { readFile as fsReadFile, chmod, mkdir, readdir, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, extname, join } from 'path'
import type { TeamStore } from '../../team'
import { resolvePublishedArtifact } from '../../team/artifact-refs'
import { isRemoteMember } from '../../../../shared/apps/team-types'
import type { TeamArtifactOpenResult } from '../../../../shared/apps/team-types'
import { resolveArtifactRef } from './artifact-path'

const LOG_TAG = '[TeamArtifactRead]'

/** Default ceiling for text inlined into a turn (bytes before decoding). */
const DEFAULT_INLINE_CAP_BYTES = 256 * 1024

/**
 * Result of reading a published team artifact by reference, location-transparent
 * over the federation. `ok:false` carries a human-readable `message` the tool
 * surfaces to the agent (e.g. owner unreachable → ask them to share the content).
 */
export interface TeamArtifactReadResult {
  ok: boolean
  ref: string
  /** Owner display name for a remote artifact; null when produced on this machine. */
  owner?: string | null
  /**
   * Producing teammate's member name, local or remote. Always set on a successful
   * read: a ref alone cannot tell the reader whose file it opened.
   */
  producer?: string | null
  /** Decoded text content (present when ok). */
  content?: string
  /** Raw byte size of the artifact. */
  bytes?: number
  /** True when `content` was truncated to the inline size ceiling. */
  truncated?: boolean
  reason?: 'not-found' | 'ambiguous' | 'unreachable' | 'binary' | 'unavailable' | 'error'
  message?: string
}

/**
 * Read a published team artifact by its logical `ref` (a finding ref or a task
 * resultRef), fetching the bytes wherever the producing member lives — locally
 * resolved for a same-machine producer, pulled on demand from the owner for a
 * remote one. Injected by bootstrap; absent in non-federated test runtimes.
 */
export type ReadTeamArtifact = (params: {
  teamId: string
  epochId: string
  ref: string
}) => Promise<TeamArtifactReadResult>

/**
 * How a remote artifact fetch failed, as classified by the transport adapter.
 * The reader maps each failure to agent-facing guidance; raw transport codes
 * never reach the model.
 */
export type RemoteArtifactFailure = 'owner-unreachable' | 'not-published' | 'not-found' | 'error'

/**
 * Typed failure contract between the injected remote fetch and this reader.
 * The bootstrap adapter translates federation error codes into one of these, so
 * the kernel needs no knowledge of federation protocol strings.
 */
export class RemoteArtifactError extends Error {
  constructor(
    readonly failure: RemoteArtifactFailure,
    message: string
  ) {
    super(message)
    this.name = 'RemoteArtifactError'
  }
}

// ── Local byte resolution ──

export interface LocalArtifactResolverDeps {
  store: TeamStore
  /**
   * The directory an app's agent actually works in — NOT the space's internal
   * bookkeeping path. The two differ for a space pointed at a project folder,
   * and resolving a ref against the wrong one makes every artifact unreadable.
   * Null when unknown.
   */
  getWorkDirForApp: (appId: string) => string | null
  /** Injectable file read (tests); defaults to fs/promises readFile. */
  readFile?: (absPath: string) => Promise<Uint8Array>
}

export type ResolveLocalArtifactBytes = (params: {
  teamId: string
  epochId: string
  ref: string
}) => Promise<Uint8Array | null>

export type ResolveLocalArtifactPath = (params: {
  teamId: string
  epochId: string
  ref: string
}) => string | null

/**
 * Resolve a published team artifact to its absolute path on THIS node: the
 * ref's publishing finding/task names the producing app → its working directory
 * → the file (`resolveArtifactRef`, the same rule publishing enforces). Only a
 * published ref resolves, never an arbitrary path. Returns null when the
 * producer is not a local app (a remote member's file lives on its owner), the
 * ref is claimed by two members, or the ref escapes the work dir.
 */
export function createLocalArtifactPathResolver(
  deps: Pick<LocalArtifactResolverDeps, 'store' | 'getWorkDirForApp'>
): ResolveLocalArtifactPath {
  return ({ teamId, epochId, ref }) => {
    const resolution = resolvePublishedArtifact(deps.store, teamId, epochId, ref)
    if (resolution.kind !== 'unique') {
      if (resolution.kind === 'ambiguous') {
        console.warn(`${LOG_TAG} ref="${ref}" claimed by ${resolution.authorAppIds.length} members; not served`)
      }
      return null
    }
    const workDir = deps.getWorkDirForApp(resolution.authorAppId)
    if (!workDir) return null
    const resolved = resolveArtifactRef(workDir, ref)
    if (!resolved.ok) {
      console.warn(`${LOG_TAG} ref="${ref}" unresolvable in "${workDir}": ${resolved.reason}`)
      return null
    }
    return resolved.absPath
  }
}

/**
 * A published team artifact's bytes from THIS node's disk. Shared by the
 * federation owner-serve path and the team reader below.
 */
export function createLocalArtifactResolver(deps: LocalArtifactResolverDeps): ResolveLocalArtifactBytes {
  const readFile = deps.readFile ?? ((absPath: string) => fsReadFile(absPath))
  const resolvePath = createLocalArtifactPathResolver(deps)
  return async (params) => {
    const absPath = resolvePath(params)
    if (!absPath) return null
    try {
      return await readFile(absPath)
    } catch (err) {
      console.warn(`${LOG_TAG} read failed for "${absPath}":`, (err as Error).message)
      return null
    }
  }
}

// ── The reader ──

export interface TeamArtifactReaderDeps {
  store: TeamStore
  /** Local disk resolution (see {@link createLocalArtifactResolver}). */
  readLocalBytes: ResolveLocalArtifactBytes
  /**
   * Pull a remote producer's bytes from its owner node. Throws
   * {@link RemoteArtifactError} on a classified failure. Absent → cross-machine
   * reads report the capability as unavailable (non-federated runtime).
   */
  fetchRemote?: (params: {
    teamId: string
    epochId: string
    ref: string
    ownerNodeId: string
  }) => Promise<Uint8Array | null>
  /** Inline text ceiling override (tests); defaults to 256 KB. */
  inlineCapBytes?: number
}

/** Cut a UTF-8 byte slice at a character boundary so no split glyph decodes to U+FFFD. */
function utf8SafeEnd(bytes: Uint8Array, cap: number): number {
  let end = cap
  // If the first excluded byte is a continuation byte, the character spanning
  // the boundary started earlier — back off to its lead byte and exclude it.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return end
}

export function createTeamArtifactReader(deps: TeamArtifactReaderDeps): ReadTeamArtifact {
  const inlineCap = deps.inlineCapBytes ?? DEFAULT_INLINE_CAP_BYTES

  return async ({ teamId, epochId, ref }) => {
    const members = deps.store.listMembersByTeam(teamId)
    const nameOf = (appId: string): string =>
      members.find((m) => m.appId === appId)?.memberName ?? 'a teammate'

    const resolution = resolvePublishedArtifact(deps.store, teamId, epochId, ref)
    if (resolution.kind === 'none') {
      return {
        ok: false,
        ref,
        reason: 'not-found',
        message:
          'No published artifact matches that reference. Ask the teammate to publish it ' +
          'with team_post_finding(ref, ...) or attach it to their task as resultRef, then try again.',
      }
    }
    if (resolution.kind === 'ambiguous') {
      // Refused rather than picked: either choice hands back a file the reader
      // never asked for, with nothing in the result to reveal the swap.
      const names = resolution.authorAppIds.map(nameOf).join(', ')
      return {
        ok: false,
        ref,
        reason: 'ambiguous',
        message:
          `More than one teammate published "${ref}" (${names}), so there is no way to tell ` +
          'which file you mean. Ask one of them to publish theirs again under a name that is ' +
          'theirs alone, then read that reference.',
      }
    }

    const producerAppId = resolution.authorAppId
    const member = members.find((m) => m.appId === producerAppId)
    const producerName = member?.memberName ?? null
    const remote = member ? isRemoteMember(member) : false
    const ownerName = remote ? member?.ownerDisplayName ?? 'a teammate' : null

    let bytes: Uint8Array | null = null
    if (!remote) {
      bytes = await deps.readLocalBytes({ teamId, epochId, ref })
    } else if (!deps.fetchRemote) {
      return {
        ok: false,
        ref,
        owner: ownerName,
        reason: 'unavailable',
        message:
          `This file lives on ${ownerName ?? 'a teammate'}\u2019s machine and cross-machine ` +
          'fetch is not available right now. Ask them to paste the content (or a summary) in a message.',
      }
    } else {
      try {
        bytes = await deps.fetchRemote({
          teamId,
          epochId,
          ref,
          ownerNodeId: member?.ownerNodeId ?? '',
        })
      } catch (err) {
        return remoteFailureResult(ref, ownerName, err)
      }
    }

    if (!bytes) return goneResult(ref, ownerName)

    // Binary guard: a NUL byte in the head means this is not text worth inlining.
    const head = bytes.subarray(0, Math.min(bytes.length, 8000))
    if (head.includes(0)) {
      return {
        ok: false,
        ref,
        owner: ownerName,
        reason: 'binary',
        bytes: bytes.length,
        message:
          'This artifact is a binary file, not text — it cannot be shown inline. Reference it by ' +
          'path in your work, or ask the teammate to export a text form.',
      }
    }

    const truncated = bytes.length > inlineCap
    const content = Buffer.from(
      truncated ? bytes.subarray(0, utf8SafeEnd(bytes, inlineCap)) : bytes
    ).toString('utf8')
    return { ok: true, ref, owner: ownerName, producer: producerName, content, bytes: bytes.length, truncated }
  }
}

// ── The opener (a person clicking a shared file) ──

export type OpenTeamArtifact = (params: {
  teamId: string
  epochId: string
  ref: string
}) => Promise<TeamArtifactOpenResult>

export interface TeamArtifactOpenerDeps {
  store: TeamStore
  /** Local disk resolution (see {@link createLocalArtifactPathResolver}). */
  resolveLocalPath: ResolveLocalArtifactPath
  /** Same contract as the reader's — see {@link TeamArtifactReaderDeps.fetchRemote}. */
  fetchRemote?: TeamArtifactReaderDeps['fetchRemote']
  /** Where copies of teammates' files land. Defaults to the OS temp directory. */
  copyDir?: string
}

/** Where copies of teammates' files land unless a test says otherwise. */
export function defaultSharedCopyRoot(): string {
  return join(tmpdir(), 'halo-shared-files')
}

/**
 * Largest teammate file copied here to open.
 *
 * The office link already bounds a single frame below this; the check states
 * the limit where the bytes are written, so a transport that raises its own
 * does not quietly turn a click into an unbounded write.
 */
export const MAX_OPEN_COPY_BYTES = 100 * 1024 * 1024

/**
 * Extensions the operating system runs rather than displays.
 *
 * A teammate's file of one of these kinds is revealed in its folder instead of
 * opened: a click on "shared file" must never be what executes code someone
 * else's digital human produced.
 */
const RUNNABLE_EXTENSIONS = new Set([
  '.exe', '.com', '.scr', '.pif', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.msi', '.msp', '.cpl', '.lnk', '.url',
  '.reg', '.jar', '.app', '.command', '.sh', '.appimage',
])

export function isRunnableFileName(name: string): boolean {
  return RUNNABLE_EXTENSIONS.has(extname(name).toLowerCase())
}

/**
 * A file name safe to write, from a ref that may carry directories. The
 * extension has to survive — it is what decides which application opens.
 */
function copyFileName(ref: string): string {
  const name = basename(ref.trim())
  return !name || name === '.' || name === '..' ? 'file' : name
}

/**
 * A fetch failure as the opener reports it. "Not published over there" and
 * "gone over there" collapse into one: from a person's side both mean the file
 * they clicked is not on the teammate's machine, and separate wording would not
 * change what they can do about it.
 */
function openFailureFor(err: unknown): TeamArtifactOpenResult['reason'] {
  if (!(err instanceof RemoteArtifactError)) return 'error'
  if (err.failure === 'owner-unreachable') return 'unreachable'
  return err.failure === 'error' ? 'error' : 'not-found'
}

/**
 * Resolve a published ref to something the operating system can open, fetching
 * from the producer's owner when the producer is not on this machine.
 */
export function createTeamArtifactOpener(deps: TeamArtifactOpenerDeps): OpenTeamArtifact {
  const copyRoot = deps.copyDir ?? defaultSharedCopyRoot()

  return async ({ teamId, epochId, ref }) => {
    const resolution = resolvePublishedArtifact(deps.store, teamId, epochId, ref)
    if (resolution.kind === 'none') return { ok: false, ref, reason: 'not-found' }
    // Refused rather than picked, for the reason the agent reader refuses:
    // either choice opens a file nobody asked for, and the window that comes up
    // says nothing about the swap.
    if (resolution.kind === 'ambiguous') return { ok: false, ref, reason: 'ambiguous' }

    const member = deps.store.listMembersByTeam(teamId).find((m) => m.appId === resolution.authorAppId)
    if (!member || !isRemoteMember(member)) {
      const absPath = deps.resolveLocalPath({ teamId, epochId, ref })
      return absPath
        ? { ok: true, ref, path: absPath, owner: null, copied: false }
        : { ok: false, ref, reason: 'not-found' }
    }

    const owner = member.ownerDisplayName ?? null
    if (!deps.fetchRemote) return { ok: false, ref, owner, reason: 'unavailable' }

    let bytes: Uint8Array | null
    try {
      bytes = await deps.fetchRemote({ teamId, epochId, ref, ownerNodeId: member.ownerNodeId ?? '' })
    } catch (err) {
      const reason = openFailureFor(err)
      console.warn(`${LOG_TAG} open fetch failed ref="${ref}" reason=${reason}:`, (err as Error).message)
      return { ok: false, ref, owner, reason }
    }
    if (!bytes) return { ok: false, ref, owner, reason: 'not-found' }
    if (bytes.length > MAX_OPEN_COPY_BYTES) {
      console.warn(`${LOG_TAG} refusing to copy "${ref}": ${bytes.length} bytes exceeds ${MAX_OPEN_COPY_BYTES}`)
      return { ok: false, ref, owner, reason: 'too-large' }
    }

    // One directory per ref, so two teammates' same-named files never collide.
    const key = createHash('sha256').update(`${teamId}\u0000${epochId}\u0000${ref}`).digest('hex').slice(0, 16)
    const dir = join(copyRoot, key)
    const name = copyFileName(ref)
    let target: string
    try {
      await mkdir(dir, { recursive: true })
      target = await writeCopy(dir, name, bytes)
    } catch (err) {
      console.warn(`${LOG_TAG} could not write a local copy of "${ref}":`, (err as Error).message)
      return { ok: false, ref, owner, reason: 'error' }
    }
    await markFromElsewhere(target)
    return { ok: true, ref, path: target, owner, copied: true, revealOnly: isRunnableFileName(name) }
  }
}

/**
 * Write a fresh read-only copy, replacing the previous one when possible.
 *
 * The previous copy may still be open — Word holds a document it is showing,
 * and Windows then refuses to delete it. Opening the file again must not fail
 * over that, so the new copy takes a new name beside the old one instead.
 */
async function writeCopy(dir: string, name: string, bytes: Uint8Array): Promise<string> {
  const primary = join(dir, name)
  try {
    await rm(primary, { force: true })
    await writeFile(primary, bytes, { mode: 0o444 })
    return primary
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw err
    const ext = extname(name)
    const fallback = join(dir, `${name.slice(0, name.length - ext.length)}-${Date.now()}${ext}`)
    console.warn(`${LOG_TAG} previous copy of "${name}" is in use (${code}); writing ${fallback}`)
    await writeFile(fallback, bytes, { mode: 0o444 })
    return fallback
  }
}

/**
 * Tag a teammate's file as downloaded (Windows Mark of the Web), so Office's
 * Protected View and SmartScreen treat it as coming from elsewhere — which it
 * does. Best effort: other platforms and non-NTFS volumes have no such stream.
 */
async function markFromElsewhere(path: string): Promise<void> {
  if (process.platform !== 'win32') return
  try {
    await writeFile(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
  } catch (err) {
    console.warn(`${LOG_TAG} could not mark "${path}" as downloaded:`, (err as Error).message)
  }
}

/**
 * Remove copies older than `maxAgeMs`.
 *
 * Copies are only a means of opening a file; the original stays with its
 * owner and is fetched again on the next click. Without this the directory
 * grows with every file ever opened. A copy still open elsewhere cannot be
 * removed and is simply tried again next time.
 */
export async function pruneSharedFileCopies(root: string, maxAgeMs: number, now = Date.now()): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return
  }
  for (const entry of entries) {
    const dir = join(root, entry)
    try {
      if (now - (await stat(dir)).mtimeMs < maxAgeMs) continue
      // Read-only files block removal on Windows until their mode is lifted.
      for (const file of await readdir(dir)) {
        await chmod(join(dir, file), 0o644).catch(() => undefined)
      }
      await rm(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`${LOG_TAG} could not prune shared-file copy ${dir}:`, (err as Error).message)
    }
  }
}

/**
 * The file was published but is no longer there. Publication is validated at the
 * time it happens, so this means it moved or was deleted afterwards — asking for
 * a re-publish of the same vanished path only loops, so ask for the file's
 * current whereabouts instead.
 */
function goneResult(ref: string, ownerName: string | null): TeamArtifactReadResult {
  return {
    ok: false,
    ref,
    owner: ownerName,
    reason: 'not-found',
    message:
      `"${ref}" is no longer at the location it was published from — it was moved or deleted ` +
      'after publishing. Ask the teammate where it is now, or to share the content in a message.',
  }
}

/** Map a remote fetch failure to agent-facing guidance (never a raw code). */
function remoteFailureResult(
  ref: string,
  ownerName: string | null,
  err: unknown
): TeamArtifactReadResult {
  const failure = err instanceof RemoteArtifactError ? err.failure : 'error'
  console.warn(`${LOG_TAG} remote fetch failed ref="${ref}" failure=${failure}:`, (err as Error).message)
  const who = ownerName ?? 'that teammate'
  switch (failure) {
    case 'owner-unreachable':
      return {
        ok: false,
        ref,
        owner: ownerName,
        reason: 'unreachable',
        message:
          `${who}\u2019s machine can\u2019t be reached right now, so this file can\u2019t be fetched. ` +
          'Ask them to paste the content (or a summary) in a message, or try again shortly.',
      }
    case 'not-published':
      return {
        ok: false,
        ref,
        owner: ownerName,
        reason: 'not-found',
        message:
          `${who}\u2019s machine doesn\u2019t list this reference as published yet. Ask them to ` +
          'publish it with team_post_finding(ref, ...) or attach it to their task as resultRef, then try again.',
      }
    case 'not-found':
      return goneResult(ref, ownerName)
    default:
      return {
        ok: false,
        ref,
        owner: ownerName,
        reason: 'error',
        message:
          'Could not read this artifact right now. Ask the teammate to share the content ' +
          'directly in a message, or try again shortly.',
      }
  }
}
