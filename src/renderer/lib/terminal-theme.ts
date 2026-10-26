/**
 * Terminal theme builder.
 *
 * ANSI 0-15 have no design-token counterparts, so the palette is hardcoded here
 * (same rationale as src/renderer/lib/codemirror-theme.ts).
 */

import type { ITheme } from '@xterm/xterm'

/**
 * Light palettes need dark ANSI values — bright yellow on white is ~1.2:1 (#267).
 * yellow/brightYellow and brightBlack/brightWhite are pre-darkened past 4.5:1 so
 * xterm's minimumContrastRatio lifting never fires and merges a pair into one
 * on-screen colour (#276); pre-darkening also covers DIM, which xterm checks
 * against the halved ratio 2.25.
 */
export const LIGHT_ANSI = {
  black: '#000000',
  red: '#cd3131',
  green: '#00bc00',
  yellow: '#7a5e00',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#616161',
  brightRed: '#f14c4c',
  brightGreen: '#14ce14',
  brightYellow: '#856f00',
  brightBlue: '#3b8eea',
  brightMagenta: '#d670d6',
  brightCyan: '#29b8db',
  brightWhite: '#6f6f6f',
} as const

/** Byte-identical to xterm's DEFAULT_ANSI_COLORS (Tango) — asserted in tests. */
export const DARK_ANSI = {
  black: '#2e3436',
  red: '#cc0000',
  green: '#4e9a06',
  yellow: '#c4a000',
  blue: '#3465a4',
  magenta: '#75507b',
  cyan: '#06989a',
  white: '#d3d7cf',
  brightBlack: '#555753',
  brightRed: '#ef2929',
  brightGreen: '#8ae234',
  brightYellow: '#fce94f',
  brightBlue: '#729fcf',
  brightMagenta: '#ad7fa8',
  brightCyan: '#34e2e2',
  brightWhite: '#eeeeec',
} as const

export function isLightTheme(): boolean {
  return document.documentElement.classList.contains('light')
}

/** Read a theme HSL triplet CSS var and wrap it as a canvas-parseable color. */
function themeColor(styles: CSSStyleDeclaration, varName: string, fallback: string): string {
  const raw = styles.getPropertyValue(varName).trim()
  return raw ? `hsl(${raw})` : fallback
}

export interface TerminalThemeOptions {
  theme: ITheme
  /** 4.5 in light theme only, so dark palettes render as authored. */
  minimumContrastRatio: number
}

/**
 * The theme object and the contrast ratio must be applied together: xterm
 * clears only its non-dim contrast cache on a ratio change, so a ratio-only
 * update would leave DIM cells with stale adjusted colours.
 */
export function getTerminalThemeOptions(): TerminalThemeOptions {
  const isLight = isLightTheme()
  const styles = getComputedStyle(document.documentElement)
  return {
    theme: {
      background: themeColor(styles, '--card', '#1e1e1e'),
      foreground: themeColor(styles, '--card-foreground', '#d4d4d4'),
      cursor: themeColor(styles, '--primary', '#ffffff'),
      cursorAccent: themeColor(styles, '--card', '#1e1e1e'),
      selectionBackground: themeColor(styles, '--primary', '#264f78'),
      ...(isLight ? LIGHT_ANSI : DARK_ANSI),
    },
    minimumContrastRatio: isLight ? 4.5 : 1,
  }
}
