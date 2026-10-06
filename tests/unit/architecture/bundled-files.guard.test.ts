/**
 * The main process never streams files out of the app bundle. `express.static`,
 * `res.sendFile` and `res.download` open each file as a stream; inside app.asar
 * that makes Electron extract it to a hidden temp file and keep that path, and
 * macOS deletes such files after a few days — the remote web UI then failed
 * until Halo restarted. Bundled files go out through `http/renderer-assets.ts`,
 * which reads them whole.
 */

import { describe, expect, it } from 'vitest'
import { findMatches, formatMatches, listSourceFiles } from './lib/source-scan'

describe('bundled files guard', () => {
  it('no main-process module serves files with express.static, res.sendFile or res.download', () => {
    const streamed = /\bexpress\.static\s*\(|\bserveStatic\s*\(|\b(?:res|response)\.(?:sendFile|download)\s*\(/
    expect(formatMatches(findMatches(listSourceFiles('src/main'), streamed))).toBe('')
  })
})
