/**
 * Guard: crash and relaunch paths never erase the evidence of why the process
 * went away.
 *
 * A session is marked clean in exactly one place — the graceful shutdown in the
 * main entry. Every relaunch goes through services/lifecycle `relaunchApp`,
 * which records its reason instead; nothing else may call `app.relaunch()`.
 */

import { describe, it, expect } from 'vitest'
import { findMatches, formatMatches, listSourceFiles, readSource } from './lib/source-scan'

const MAIN_FILES = listSourceFiles('src/main')

describe('crash evidence guard', () => {
  it('marks the session clean only from the graceful shutdown path', () => {
    const calls = findMatches(MAIN_FILES, /\bmarkSessionCleanExit\(\)/)
      .filter((m) => !m.text.startsWith('export function'))
    expect(calls.map((m) => m.file), formatMatches(calls)).toEqual(['src/main/index.ts'])

    const index = readSource('src/main/index.ts')
    const shutdownStart = index.indexOf('function shutdownServices(')
    const shutdownEnd = index.indexOf('function shutdownServicesWithTimeout(')
    expect(shutdownStart).toBeGreaterThan(-1)
    expect(shutdownEnd).toBeGreaterThan(shutdownStart)
    expect(index.slice(shutdownStart, shutdownEnd)).toContain('markSessionCleanExit()')
  })

  it('marks the health registry clean only from the health shutdown', () => {
    const calls = findMatches(MAIN_FILES, /\bmarkCleanExit\(\)/)
      .filter((m) => !m.text.startsWith('export function'))
    expect(calls.map((m) => m.file)).toEqual(['src/main/services/health/orchestrator.ts'])
  })

  it('relaunches only through relaunchApp, which records the reason first', () => {
    const relaunches = findMatches(MAIN_FILES, /\bapp\.relaunch\(/)
    expect(formatMatches(relaunches)).toMatch(/^src\/main\/services\/lifecycle\.ts:\d+ {2}app\.relaunch\(\)$/)

    const lifecycle = readSource('src/main/services/lifecycle.ts')
    const body = lifecycle.slice(lifecycle.indexOf('export function relaunchApp'))
    const recordAt = body.indexOf('recordSessionExitReason(')
    expect(recordAt).toBeGreaterThan(-1)
    expect(recordAt).toBeLessThan(body.indexOf('app.relaunch()'))
    expect(lifecycle).not.toMatch(/markSessionCleanExit|markCleanExit/)
  })

  it('renderer recovery never relaunches on its own', () => {
    const index = readSource('src/main/index.ts')
    const recover = index.slice(
      index.indexOf('function recoverRenderer'),
      index.indexOf('function createAppMenu'),
    )
    expect(recover).not.toMatch(/relaunchApp\(|app\.relaunch\(|app\.exit\(/)
  })
})
