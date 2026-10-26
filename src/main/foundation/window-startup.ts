/** Native window colors before the page applies its theme. */

export type ThemeSetting = 'light' | 'dark' | 'system'

/**
 * globals.css `--background` (window and caption-button strip) and
 * `--foreground` (caption-button glyphs) per theme, as the literal colors the
 * native window needs. A unit test holds them to the tokens.
 */
export const THEME_WINDOW_COLORS = {
  dark: { background: '#181b20', symbol: '#e7e9ee' },
  light: { background: '#ffffff', symbol: '#181a21' },
} as const

export function startupWindowColors(
  theme: ThemeSetting | undefined,
  systemPrefersDark: boolean,
): { background: string; symbol: string } {
  const dark = theme === 'dark' || (theme !== 'light' && systemPrefersDark)
  return THEME_WINDOW_COLORS[dark ? 'dark' : 'light']
}
