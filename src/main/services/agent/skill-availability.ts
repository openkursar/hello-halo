import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SkillCatalogEntry, SkillNotice } from '../../../shared/types/skills'
import { getEffectiveSkillCatalogForSession, waitForSkillCatalogProvider } from '../app-bridge'

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
    console.warn('[Agent] Skill compatibility notice omitted: ready catalog could not be read', { spaceId, error })
    return undefined
  }
}

function inside(file: string, root: string): boolean {
  const part = relative(resolve(root), resolve(file))
  return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/** Native discovery is not the Halo catalog; only the session's default roots are compared. */
export function unsupportedSkillNames(catalog: SkillCatalogEntry[], options: Record<string, any>, engineId: 'anthropic' | 'codex'): Set<string> {
  const roots: string[] = []
  if (engineId === 'anthropic') {
    const sources: string[] = options.settingSources ?? ['user', 'project']
    if (sources.includes('user')) {
      const configDir = options.env?.CLAUDE_CONFIG_DIR ?? join(options.env?.HOME ?? options.env?.USERPROFILE ?? homedir(), '.claude')
      roots.push(join(configDir, 'skills'), join(configDir, 'commands'))
    }
    if (sources.includes('project') && typeof options.cwd === 'string') {
      roots.push(join(options.cwd, '.claude', 'skills'), join(options.cwd, '.claude', 'commands'))
    }
  } else {
    roots.push(join(options.env?.HOME ?? options.env?.USERPROFILE ?? homedir(), '.agents', 'skills'))
    if (typeof options.cwd === 'string') roots.push(join(options.cwd, '.agents', 'skills'))
  }
  return new Set(catalog.filter(entry => !(roots.some(root => inside(entry.source.path, root))
    && (engineId === 'anthropic' || basename(entry.source.path) === 'SKILL.md')))
    .map(entry => entry.name.toLocaleLowerCase('en-US')))
}

/** Session advice is once; an explicitly repeated unsupported command gets its own feedback. */
export function withSkillNotice<T extends object>(session: T, notice?: SkillNotice, names?: Set<string>, initialInput?: unknown): T {
  if (!notice) return session
  let announced = false
  let pendingCommands = 0
  let closed = false
  const capturedNames = names ? new Set(names) : undefined
  const methods = new Map<PropertyKey, unknown>()
  const noteInput = (message: any) => {
    if (closed || !capturedNames?.size) return
    const content = typeof message === 'string' ? message : message?.message?.content
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : ''
    const command = text.trimStart().toLocaleLowerCase('en-US')
    if (command.startsWith('/') && [...capturedNames].some(name => command === `/${name}`
      || (command.startsWith(`/${name}`) && /\s/u.test(command[name.length + 1] ?? '')))) pendingCommands++
  }
  noteInput(initialInput)
  function* pending(includeSessionNotice: boolean) {
    if (closed) return
    if (pendingCommands > 0) {
      const count = pendingCommands
      pendingCommands = 0
      announced = true
      for (let index = 0; index < count; index++) {
        yield { type: 'system', subtype: 'skill_notice', skillNotice: 'skill-unsupported' }
      }
    } else if (includeSessionNotice && !announced) {
      announced = true
      yield { type: 'system', subtype: 'skill_notice', skillNotice: notice }
    }
  }
  const stream = async function* (...args: unknown[]) {
    for await (const frame of (session as any).stream(...args)) {
      const init = frame.type === 'system' && frame.subtype === 'init'
      if (!init) yield* pending(false)
      yield frame
      if (init) yield* pending(true)
    }
  }
  return new Proxy(session, {
    get(target, property) {
      if (property === 'stream') return stream
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      if (!methods.has(property)) {
        if (property === 'send' || property === 'sendIntoLiveTurn') {
          methods.set(property, (...args: unknown[]) => {
            const result = value.apply(target, args)
            if (result && typeof result.then === 'function') {
              return result.then((accepted: unknown) => { if (accepted !== false) noteInput(args[0]); return accepted })
            }
            if (result !== false) noteInput(args[0])
            return result
          })
        } else if (property === 'close' || property === Symbol.dispose || property === Symbol.asyncDispose) {
          methods.set(property, (...args: unknown[]) => {
            closed = true
            pendingCommands = 0
            capturedNames?.clear()
            return value.apply(target, args)
          })
        } else methods.set(property, value.bind(target))
      }
      return methods.get(property)
    },
  })
}
