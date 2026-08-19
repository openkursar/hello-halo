/**
 * Terminal theme builder.
 *
 * ANSI 0-15 have no design-token counterparts, so the palette is hardcoded here
 * (same rationale as src/renderer/lib/codemirror-theme.ts).
 */

/** Read a theme HSL triplet CSS var and wrap it as a canvas-parseable color. */
function themeColor(varName: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  return raw ? `hsl(${raw})` : fallback
}

function isLightTheme(): boolean {
  return document.documentElement.classList.contains('light')
}

export function buildTheme(): Record<string, string> {
  const isLight = isLightTheme()

  // Light backgrounds need dark ANSI values — bright yellow on white is ~1.2:1 (#267).
  const ansi = isLight
    ? {
        black: '#000000',
        red: '#cd3131',
        green: '#00bc00',
        yellow: '#949800',
        blue: '#0451a5',
        magenta: '#bc05bc',
        cyan: '#0598bc',
        white: '#555555',
        brightBlack: '#767676',
        brightRed: '#f14c4c',
        brightGreen: '#14ce14',
        brightYellow: '#b5ba00',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#a5a5a5',
      }
    : {
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
      }

  return {
    background: themeColor('--card', '#1e1e1e'),
    foreground: themeColor('--card-foreground', '#d4d4d4'),
    cursor: themeColor('--primary', '#ffffff'),
    cursorAccent: themeColor('--card', '#1e1e1e'),
    selectionBackground: themeColor('--primary', '#264f78'),
    ...ansi,
  }
}

/** Contrast ratio used by xterm.js; scoped to light theme so dark mode stays untouched. */
export function getMinimumContrastRatio(): number {
  return isLightTheme() ? 4.5 : 1
}
