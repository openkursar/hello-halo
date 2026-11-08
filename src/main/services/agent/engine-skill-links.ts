/**
 * A directory of links that makes skills kept outside an engine's own folders visible to it.
 *
 * Claude Code discovers `.claude/skills` and `.claude/commands` inside every directory it is
 * given with `--add-dir`, and follows links there. The directory is a derived view, never the
 * home of a skill: it only names where each skill really lives, so editing a skill needs no
 * refresh and deleting the view loses nothing.
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { SkillCatalogEntry } from '../../../shared/types/skills'
import { validateSkillName } from '../skills'

const STALE_VIEW_MS = 14 * 24 * 60 * 60 * 1000
const BUILDING_PREFIX = '.building-'
const prunedRoots = new Set<string>()

interface SkillLink {
  /** Path of the link inside the view, relative to its root */
  relative: string
  target: string
  directory: boolean
}

function linksFor(entries: readonly SkillCatalogEntry[]): SkillLink[] {
  const links: SkillLink[] = []
  for (const entry of entries) {
    try {
      const name = validateSkillName(entry.name)
      const target = entry.source.path
      if (basename(target) === 'SKILL.md') links.push({ relative: join('.claude', 'skills', name), target: dirname(target), directory: true })
      else links.push({ relative: join('.claude', 'commands', `${name}.md`), target, directory: false })
    } catch {
      // The catalog already marks an unusable name invalid; there is nothing to link.
    }
  }
  return links.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0))
}

/** A copy cannot follow its original, so its identity includes the version it copied. */
function copiesFiles(): boolean {
  return process.platform === 'win32'
}

function viewKey(links: readonly SkillLink[]): string {
  const parts = links.map(link => [link.relative, link.target, !link.directory && copiesFiles() ? statSync(link.target).mtimeMs : 0])
  return createHash('sha256').update(JSON.stringify([process.platform, parts])).digest('hex').slice(0, 24)
}

function createLink(link: SkillLink, view: string): void {
  const path = join(view, link.relative)
  mkdirSync(dirname(path), { recursive: true })
  if (link.directory) symlinkSync(link.target, path, copiesFiles() ? 'junction' : 'dir')
  else if (copiesFiles()) copyFileSync(link.target, path)
  else symlinkSync(link.target, path, 'file')
}

/**
 * Removes views no session has used for two weeks, once per run and before this run hands any out:
 * a view in use by a live session is never older than the run, so long sessions keep their skills.
 */
function pruneStaleViews(root: string): void {
  if (prunedRoots.has(root)) return
  prunedRoots.add(root)
  const cutoff = Date.now() - STALE_VIEW_MS
  let names: string[]
  try { names = readdirSync(root) }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) console.warn('[Agent] Skill link directories could not be listed', { reason: (error as Error).message })
    return
  }
  for (const name of names) {
    try {
      if (statSync(join(root, name)).mtimeMs < cutoff) rmSync(join(root, name), { recursive: true, force: true })
    } catch (error) {
      console.warn('[Agent] A stale skill link directory could not be removed', { name, reason: (error as Error).message })
    }
  }
}

/**
 * Returns a directory to hand to Claude Code as an extra directory, or undefined when nothing
 * needs linking or the directory could not be built (the session then runs without these skills).
 * The same skills always map to the same directory, so sessions share it and it is built once.
 */
export function linkSkillsForClaudeCode(entries: readonly SkillCatalogEntry[], root: string): string | undefined {
  const links = linksFor(entries)
  if (links.length === 0) return undefined
  pruneStaleViews(root)
  let building: string | undefined
  try {
    const view = join(root, viewKey(links))
    const now = new Date()
    try {
      utimesSync(view, now, now)
      return view
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    mkdirSync(root, { recursive: true })
    building = join(root, `${BUILDING_PREFIX}${randomUUID()}`)
    mkdirSync(building)
    for (const link of links) createLink(link, building)
    try {
      renameSync(building, view)
      building = undefined
    } catch (error) {
      // A concurrent session built the same view first; its copy is identical.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    return view
  } catch (error) {
    console.warn('[Agent] Skills could not be linked for Claude Code; this session runs without them', { reason: (error as Error).message })
    return undefined
  } finally {
    if (building) rmSync(building, { recursive: true, force: true })
  }
}
