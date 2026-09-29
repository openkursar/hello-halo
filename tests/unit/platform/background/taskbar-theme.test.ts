/**
 * The Windows taskbar theme is parsed from `reg query` on the Personalize key.
 */

import { describe, expect, it } from 'vitest'
import { parseTaskbarIsDark } from '../../../../src/main/platform/background/taskbar-theme'

const key = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'

function regOutput(values: string[]): string {
  return ['', key, ...values.map(v => `    ${v}`), '', ''].join('\r\n')
}

describe('parseTaskbarIsDark', () => {
  it('reads a light taskbar', () => {
    expect(parseTaskbarIsDark(regOutput([
      'AppsUseLightTheme    REG_DWORD    0x0',
      'SystemUsesLightTheme    REG_DWORD    0x1',
    ]))).toBe(false)
  })

  it('reads a dark taskbar, independent of the app mode', () => {
    expect(parseTaskbarIsDark(regOutput([
      'AppsUseLightTheme    REG_DWORD    0x1',
      'SystemUsesLightTheme    REG_DWORD    0x0',
    ]))).toBe(true)
  })

  it('treats a key without the value as the always-dark taskbar of older Windows', () => {
    expect(parseTaskbarIsDark(regOutput(['ColorPrevalence    REG_DWORD    0x0']))).toBe(true)
  })
})
