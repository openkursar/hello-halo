import { describe, expect, it } from 'vitest'
import { CliToolError } from '../../../../src/main/services/cli-tools'
import { launcherFiles, renderCmdLauncher, renderShLauncher, shQuote } from '../../../../src/main/services/cli-tools/shims'

describe('cli-tools launchers', () => {
  it('single-quotes POSIX paths', () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`)
    const sh = renderShLauncher('/rt/Electron Helper', '/s/entry.js')
    expect(sh).toContain(`exec '/rt/Electron Helper' '/s/entry.js' "$@"`)
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('escapes % in cmd paths and refuses quotes and line breaks', () => {
    const cmd = renderCmdLauncher('C:\\Program Files\\Halo\\Halo.exe', 'C:\\Users\\a%b\\entry.js')
    expect(cmd).toContain('"C:\\Program Files\\Halo\\Halo.exe" "C:\\Users\\a%%b\\entry.js" %*')
    expect(() => renderCmdLauncher('C:\\a"b', 'x')).toThrow(CliToolError)
    expect(() => renderShLauncher('/a\nb', 'x')).toThrow(CliToolError)
  })

  it('writes one launcher on POSIX and two on Windows', () => {
    expect(launcherFiles('darwin', 'tool', '/rt', '/e.js').map(f => f.name)).toEqual(['tool'])
    expect(launcherFiles('win32', 'tool', 'C:\\rt.exe', 'C:\\e.js').map(f => f.name)).toEqual(['tool.cmd', 'tool'])
  })
})
