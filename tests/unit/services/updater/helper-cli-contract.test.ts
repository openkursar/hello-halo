/**
 * The Electron side must pass every flag the helper requires.
 *
 * These are two programs in two languages joined by a command line, so nothing
 * type-checks the join. When `--version` was added to the helper's `apply`
 * command and the caller was not updated, the helper exited on a usage error
 * before it had even opened its log — the app quit, nothing was swapped, and
 * the only evidence was an update that silently never happened.
 *
 * The Go source is the source of truth for what is required.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const HELPER_MAIN = join(__dirname, '../../../../win-update-helper/cmd/halo-update-helper/main.go')
const CALLER = join(__dirname, '../../../../src/main/services/updater/staged/helper.ts')

/**
 * Extract the flags a helper subcommand rejects the invocation without.
 *
 * Matches the `required(map[string]string{ "a": *a, ... })` block that follows
 * the named command's flag set.
 */
function requiredFlagsFor(source: string, command: string): string[] {
  const start = source.indexOf(`flag.NewFlagSet("${command}"`)
  expect(start, `helper defines a "${command}" command`).toBeGreaterThan(-1)

  const region = source.slice(start)
  const required = /required\(map\[string\]string\{([\s\S]*?)\}\)/.exec(region)
  if (!required) return []

  return [...required[1].matchAll(/"([a-z0-9-]+)"\s*:/g)].map((m) => m[1])
}

/** Flags the TypeScript caller passes for a given subcommand. */
function passedFlagsFor(source: string, command: string): string[] {
  const start = source.indexOf(`'${command}',`)
  expect(start, `caller invokes "${command}"`).toBeGreaterThan(-1)

  // The argument array ends at the closing bracket of the spawn call.
  const region = source.slice(start, source.indexOf(']', start))
  return [...region.matchAll(/'--([a-z0-9-]+)'/g)].map((m) => m[1])
}

describe('helper CLI contract', () => {
  const helperSource = existsSync(HELPER_MAIN) ? readFileSync(HELPER_MAIN, 'utf8') : ''
  const callerSource = readFileSync(CALLER, 'utf8')

  it('has the helper source available to check against', () => {
    expect(existsSync(HELPER_MAIN), `helper source not found at ${HELPER_MAIN}`).toBe(true)
  })

  for (const command of ['stage', 'apply', 'rollback']) {
    it(`passes every flag "${command}" requires`, () => {
      const required = requiredFlagsFor(helperSource, command)
      expect(required.length, `"${command}" declares required flags`).toBeGreaterThan(0)

      const passed = passedFlagsFor(callerSource, command)
      const missing = required.filter((flag) => !passed.includes(flag))

      expect(
        missing,
        `caller omits required flag(s) for "${command}": ${missing.map((f) => `--${f}`).join(', ')}`
      ).toEqual([])
    })
  }
})
