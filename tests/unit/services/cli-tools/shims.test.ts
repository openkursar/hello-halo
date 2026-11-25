import { describe, expect, it } from 'vitest'
import { CliToolError } from '../../../../src/main/services/cli-tools'
import {
  launcherFiles,
  renderArgvPreload,
  renderCmdLauncher,
  renderShLauncher,
  shQuote,
} from '../../../../src/main/services/cli-tools/shims'

const posix = { runtimePath: '/rt/Electron Helper', preloadPath: '/v/k/argv-preload.cjs', entryPath: '/s/entry.js' }
const win = {
  runtimePath: 'C:\\Program Files\\Halo\\Halo.exe',
  preloadPath: 'C:\\Users\\a%b\\cli\\views\\k\\argv-preload.cjs',
  entryPath: 'C:\\Users\\a%b\\entry.js',
}

describe('cli-tools launchers', () => {
  it('single-quotes POSIX paths and loads the argv preload before the entry', () => {
    expect(shQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`)
    const sh = renderShLauncher(posix)
    expect(sh).toContain(`exec '/rt/Electron Helper' --require '/v/k/argv-preload.cjs' '/s/entry.js' "$@"`)
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true)
  })

  it('escapes % in cmd paths, loads the preload, and refuses quotes and line breaks', () => {
    const cmd = renderCmdLauncher(win)
    expect(cmd).toContain(
      '"C:\\Program Files\\Halo\\Halo.exe" --require "C:\\Users\\a%%b\\cli\\views\\k\\argv-preload.cjs" "C:\\Users\\a%%b\\entry.js" %*'
    )
    expect(() => renderCmdLauncher({ ...win, runtimePath: 'C:\\a"b' })).toThrow(CliToolError)
    expect(() => renderCmdLauncher({ ...win, preloadPath: 'C:\\a"b' })).toThrow(CliToolError)
    expect(() => renderShLauncher({ ...posix, runtimePath: '/a\nb' })).toThrow(CliToolError)
    expect(() => renderShLauncher({ ...posix, preloadPath: '/a\nb' })).toThrow(CliToolError)
  })

  it('names a non-ASCII path relative to the launcher, since cmd.exe may misread it', () => {
    const binDir = 'C:\\Users\\张三\\AppData\\Roaming\\halo\\cli\\views\\k\\bin'
    const cmd = renderCmdLauncher({
      runtimePath: 'C:\\Users\\张三\\AppData\\Roaming\\halo\\cli\\runtime\\r\\Halo.exe',
      preloadPath: 'C:\\Users\\张三\\AppData\\Roaming\\halo\\cli\\views\\k\\argv-preload.cjs',
      entryPath: 'C:\\Users\\张三\\AppData\\Roaming\\halo\\cli\\store\\t\\1%\\entry.js',
      binDir,
    })
    expect(cmd).toContain(
      '"%~dp0..\\..\\..\\runtime\\r\\Halo.exe" --require "%~dp0..\\argv-preload.cjs" "%~dp0..\\..\\..\\store\\t\\1%%\\entry.js" %*'
    )
    expect(/^[\x00-\x7f]*$/.test(cmd)).toBe(true)
  })

  it('keeps ASCII paths as they are, and a non-ASCII path with no ASCII relative form', () => {
    const binDir = 'C:\\Users\\a\\cli\\views\\k\\bin'
    expect(renderCmdLauncher({ ...win, binDir })).toBe(renderCmdLauncher(win))
    const other = renderCmdLauncher({ ...win, runtimePath: 'D:\\测试\\Halo.exe', binDir })
    expect(other).toContain('"D:\\测试\\Halo.exe" --require')
    const direct = (entryPath: string) =>
      launcherFiles('win32', 'tool', { ...win, entryPath, direct: true, binDir: 'C:\\Users\\张三\\cli\\views\\k\\bin' })[0].content
    expect(direct('C:\\Users\\张三\\tools\\t.exe')).toContain('"%~dp0..\\..\\..\\..\\tools\\t.exe" %*')
    expect(direct('C:\\Users\\张三\\工具\\t.exe')).toContain('"C:\\Users\\张三\\工具\\t.exe" %*')
  })

  it('preload marks the process as a script run, as Electron does for `electron script`', () => {
    const target: { defaultApp?: boolean } = {}
    new Function('process', renderArgvPreload())(target)
    expect(target.defaultApp).toBe(true)
  })

  it('writes one launcher on POSIX and two on Windows', () => {
    expect(launcherFiles('darwin', 'tool', posix).map(f => f.name)).toEqual(['tool'])
    expect(launcherFiles('win32', 'tool', win).map(f => f.name)).toEqual(['tool.cmd', 'tool'])
  })
})
