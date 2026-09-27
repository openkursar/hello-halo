/**
 * The Electron side and the Windows update helper must agree on exit codes.
 *
 * They are separate programs in separate languages, so nothing but this test
 * couples them. An inserted code shifts every later value by one, and the
 * damage is silent and specific: a swap that failed and cleanly put the old
 * version back would be reported to the user as an install that needs
 * reinstalling. That happened once during development, which is why it is
 * pinned here.
 *
 * The Go file is the source of truth; the TypeScript table mirrors it.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { HelperExit } from '../../../../src/main/services/updater/staged/helper'

const GO_SOURCE = join(__dirname, '../../../../win-update-helper/internal/exitcode/exitcode.go')

/** Map the Go constant names onto the TypeScript ones. */
const NAME_MAP: Record<string, keyof typeof HelperExit> = {
  OK: 'OK',
  Usage: 'USAGE',
  BadHash: 'BAD_HASH',
  StageFailed: 'STAGE_FAILED',
  StagedIncomplete: 'STAGED_INCOMPLETE',
  AppStillRunning: 'APP_STILL_RUNNING',
  SwapReversed: 'SWAP_REVERSED',
  SwapNotReversed: 'SWAP_NOT_REVERSED',
  ConfirmTimeout: 'CONFIRM_TIMEOUT',
  RollbackFailed: 'ROLLBACK_FAILED',
}

function parseGoExitCodes(source: string): Record<string, number> {
  const codes: Record<string, number> = {}
  for (const line of source.split('\n')) {
    const match = /^\s*([A-Za-z]+)\s*=\s*(\d+)\s*$/.exec(line)
    if (match) codes[match[1]] = Number(match[2])
  }
  return codes
}

describe('helper exit codes', () => {
  it('match the helper implementation exactly', () => {
    // The helper source is part of this repo; if it is gone, the mirror below
    // is describing a program that no longer exists.
    expect(existsSync(GO_SOURCE), `helper exit codes not found at ${GO_SOURCE}`).toBe(true)

    const goCodes = parseGoExitCodes(readFileSync(GO_SOURCE, 'utf8'))
    expect(Object.keys(goCodes).length).toBeGreaterThan(0)

    for (const [goName, tsName] of Object.entries(NAME_MAP)) {
      expect(goCodes[goName], `helper defines ${goName}`).toBeDefined()
      expect(HelperExit[tsName], `${tsName} must equal Go ${goName}`).toBe(goCodes[goName])
    }
  })

  it('covers every code the helper defines', () => {
    const goCodes = parseGoExitCodes(readFileSync(GO_SOURCE, 'utf8'))
    const unmapped = Object.keys(goCodes).filter((name) => !(name in NAME_MAP))
    // A new helper outcome the app cannot name gets lumped into "some failure",
    // which is how a recoverable state ends up presented as an unrecoverable one.
    expect(unmapped, `helper codes with no TypeScript counterpart: ${unmapped.join(', ')}`).toEqual([])
  })
})
