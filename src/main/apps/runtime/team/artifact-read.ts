/**
 * Location-transparent published-artifact reading — the logic behind the
 * `team_read_artifact` tool. Resolves the producing member from the team board
 * (a publishing finding's author, or the assignee of a task delivering the ref
 * as resultRef), then reads the bytes wherever they live: from this node's
 * disk for a same-machine producer, or pulled on demand from the owner node for
 * a remote one (via the injected remote fetch). Text is decoded with a size
 * ceiling and a binary guard so a huge or binary file never floods the model
 * context. Every failure returns calm, actionable guidance for the agent —
 * never a raw technical code.
 *
 * Kernel-clean: transport is injected. Bootstrap supplies the space lookup and
 * the federation-backed remote fetch; absent a remote fetch, cross-machine
 * reads degrade to an honest "unavailable" message instead of a fake not-found.
 */

import { readFile as fsReadFile } from 'fs/promises'
import type { TeamStore } from '../../team'
import { resolvePublishedArtifact } from '../../team/artifact-refs'
import { isRemoteMember } from '../../../../shared/apps/team-types'
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

/**
 * Resolve a published team artifact's bytes from THIS node's disk: the ref's
 * publishing finding/task names the producing app → its working directory → the
 * file (`resolveArtifactRef`, the same rule publishing enforces). Only a
 * published ref is servable, never an arbitrary path. Returns null when the
 * producer is not a local app (a remote member's file lives on its owner), the
 * ref is claimed by two members, the ref escapes the work dir, or the file is
 * gone. Shared by the federation owner-serve path and the team reader below.
 */
export function createLocalArtifactResolver(deps: LocalArtifactResolverDeps): ResolveLocalArtifactBytes {
  const readFile = deps.readFile ?? ((absPath: string) => fsReadFile(absPath))
  return async ({ teamId, epochId, ref }) => {
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
    try {
      return await readFile(resolved.absPath)
    } catch (err) {
      console.warn(`${LOG_TAG} read failed for "${resolved.absPath}":`, (err as Error).message)
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
