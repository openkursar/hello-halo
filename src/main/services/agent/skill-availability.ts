import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SkillCatalogEntry, SkillNotice } from '../../../shared/types/skills'
import { getHaloDir } from '../../foundation/config.service'
import { getEffectiveSkillCatalogForSession, waitForSkillCatalogProvider } from '../app-bridge'
import { linkSkillsForClaudeCode } from './engine-skill-links'

interface SessionSkills {
  catalog: SkillCatalogEntry[]
  notice?: SkillNotice
}

/** The host always supplies a catalog; an unavailable provider must not reopen disk discovery. */
export async function prepareSessionSkills(options: Record<string, any>): Promise<SessionSkills> {
  const spaceId = options.workerGroup
  if (typeof spaceId !== 'string' || !spaceId) return { catalog: [] }
  const signal = options.abortController?.signal as AbortSignal | undefined
  signal?.throwIfAborted()
  try {
    let catalog = getEffectiveSkillCatalogForSession(spaceId, options.cwd)
    if (catalog === undefined && await waitForSkillCatalogProvider(signal)) {
      catalog = getEffectiveSkillCatalogForSession(spaceId, options.cwd)
    }
    signal?.throwIfAborted()
    if (catalog !== undefined) return { catalog }
    console.warn('[Agent] Skills omitted for this session: catalog provider did not become ready within 10s', { spaceId })
  } catch (error) {
    if (signal?.aborted) throw error
    console.warn('[Agent] Skills omitted for this session: catalog could not be read', { spaceId, error })
  }
  return { catalog: [], notice: 'catalog-unavailable' }
}

/** Optional engines do not depend on Halo's catalog and must never wait for it. */
export function readReadySessionSkills(options: Record<string, any>): SkillCatalogEntry[] | undefined {
  const spaceId = options.workerGroup
  if (typeof spaceId !== 'string' || !spaceId) return undefined
  const signal = options.abortController?.signal as AbortSignal | undefined
  signal?.throwIfAborted()
  try {
    return getEffectiveSkillCatalogForSession(spaceId, options.cwd)
  } catch (error) {
    if (signal?.aborted) throw error
    console.warn('[Agent] Skills not offered to the engine: ready catalog could not be read', { spaceId, error })
    return undefined
  }
}

function inside(file: string, root: string): boolean {
  const part = relative(resolve(root), resolve(file))
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** The skills Claude Code would not find on its own with this session's setting sources. */
export function skillsOutsideClaudeRoots(catalog: readonly SkillCatalogEntry[], options: Record<string, any>): SkillCatalogEntry[] {
  const roots: string[] = []
  const sources: string[] = options.settingSources ?? ['user', 'project']
  if (sources.includes('user')) {
    const configDir = options.env?.CLAUDE_CONFIG_DIR ?? join(options.env?.HOME ?? options.env?.USERPROFILE ?? homedir(), '.claude')
    roots.push(join(configDir, 'skills'), join(configDir, 'commands'))
  }
  if (sources.includes('project') && typeof options.cwd === 'string') {
    roots.push(join(options.cwd, '.claude', 'skills'), join(options.cwd, '.claude', 'commands'))
  }
  return catalog.filter(entry => !roots.some(root => inside(entry.source.path, root)))
}

/**
 * Claude Code finds skills by itself, but only in its own folders. The skills Halo lists from
 * anywhere else are added as one extra directory of links, so every skill works on every engine.
 */
export function withClaudeCodeSkills(options: Record<string, any>): Record<string, any> {
  const catalog = readReadySessionSkills(options)
  if (!catalog?.length) return options
  const outside = skillsOutsideClaudeRoots(catalog, options)
  const directory = outside.length ? linkSkillsForClaudeCode(outside, join(getHaloDir(), 'skill-links')) : undefined
  return directory ? { ...options, additionalDirectories: [...(options.additionalDirectories ?? []), directory] } : options
}

/** The notice is shown once per session, right after the engine reports it is ready. */
export function withSkillNotice<T extends object>(session: T, notice?: SkillNotice): T {
  if (!notice) return session
  let announced = false
  let closed = false
  const methods = new Map<PropertyKey, unknown>()
  const stream = async function* (...args: unknown[]) {
    for await (const frame of (session as any).stream(...args)) {
      yield frame
      if (!announced && !closed && frame.type === 'system' && frame.subtype === 'init') {
        announced = true
        yield { type: 'system', subtype: 'skill_notice', skillNotice: notice }
      }
    }
  }
  return new Proxy(session, {
    get(target, property) {
      if (property === 'stream') return stream
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (!methods.has(property)) {
        if (property === 'close' || property === Symbol.dispose || property === Symbol.asyncDispose) {
          methods.set(property, (...args: unknown[]) => {
            closed = true
            return value.apply(target, args)
          })
        } else methods.set(property, value.bind(target))
      }
      return methods.get(property)
    },
  })
}
