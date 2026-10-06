import { readFileSync } from 'node:fs'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags, type Tag } from '@lezer/highlight'
import { parse, type Root, type Rule } from 'postcss'
import { describe, expect, it } from 'vitest'
import { diffEditorTheme, diffHighlightStyle } from '../../../../../src/renderer/components/canvas/viewers/changes/diff/diff-theme'

type Rgb = [number, number, number]
type Tokens = Record<string, string>
interface Color { rgb: Rgb; alpha: number }
interface Surface { name: string; rgb: Rgb }

const globals = parse(readFileSync(new URL('../../../../../src/renderer/assets/styles/globals.css', import.meta.url), 'utf8'))
const editor = parse(EditorState.create({ extensions: diffEditorTheme }).facet(EditorView.styleModule).map(module => module.getRules()).join('\n'))
const syntax = parse(diffHighlightStyle.module!.getRules())
const editorSelector = (editor.nodes[0] as Rule).selector

function cssValue(css: Root, selector: string, property: string): { value: string; important: boolean } {
  let result: { value: string; important: boolean } | undefined
  css.walkRules(rule => {
    if (!rule.selectors.some(value => value.endsWith(selector))) return
    rule.walkDecls(property, decl => { result = { value: decl.value, important: !!decl.important } })
  })
  if (!result) throw new Error(`Missing ${property} for ${selector}`)
  return result
}

function themeTokens(theme: 'dark' | 'light'): Tokens {
  const tokens: Tokens = {}
  for (const selector of theme === 'light' ? [':root', '.light'] : [':root']) {
    globals.walkRules(selector, rule => {
      rule.walkDecls(/^--/, decl => { tokens[decl.prop] = decl.value })
    })
  }
  return tokens
}

function hslToRgb(value: string): Rgb {
  const match = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/.exec(value)
  if (!match) throw new Error(`Unsupported HSL token: ${value}`)
  const hue = Number(match[1]) / 30
  const saturation = Number(match[2]) / 100
  const lightness = Number(match[3]) / 100
  const amplitude = saturation * Math.min(lightness, 1 - lightness)
  return [0, 8, 4].map(offset => {
    const k = (hue + offset) % 12
    return lightness - amplitude * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }) as Rgb
}

function color(value: string, tokens: Tokens): Color {
  const match = /^hsl\(var\((--[\w-]+)\)(?:\s*\/\s*([\d.]+))?\)$/.exec(value)
  if (!match) throw new Error(`Expected a theme color, got ${value}`)
  return { rgb: hslToRgb(tokens[match[1]]), alpha: Number(match[2] ?? 1) }
}

function composite(overlay: Color, background: Rgb): Rgb {
  return overlay.rgb.map((channel, i) => channel * overlay.alpha + background[i] * (1 - overlay.alpha)) as Rgb
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrast(foreground: Color, background: Rgb): number {
  const a = luminance(composite(foreground, background))
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function syntaxColor(tag: Tag): string {
  let value = cssValue(editor, editorSelector, 'color').value
  for (const className of diffHighlightStyle.style([tag])?.split(' ') ?? []) {
    value = cssValue(syntax, `.${className}`, 'color').value
  }
  return value
}

const changes = [
  { name: 'split deletion', line: '.cm-merge-a .cm-changedLine', word: '.cm-merge-a .cm-changedText' },
  { name: 'split/unified insertion', line: '.cm-merge-b .cm-changedLine', word: '.cm-merge-b .cm-changedText' },
  { name: 'unified inserted text', line: '.cm-merge-b .cm-changedLine', word: '.cm-insertedText' },
  { name: 'unified deleted chunk', line: '.cm-deletedChunk', word: '.cm-deletedText' },
  { name: 'unified inline insertion', line: '.cm-inlineChangedLine', word: '.cm-inlineChangedLine .cm-changedText' },
  { name: 'unified inline deletion', line: '.cm-inlineChangedLine', word: '.cm-merge-b .cm-deletedText' },
]
const wholeLines = ['.cm-wholeInserted .cm-line', '.cm-wholeDeleted .cm-line']
const referencesSource = readFileSync(new URL('../../../../../src/renderer/components/references/adapters/codemirror.ts', import.meta.url), 'utf8')
/** The diff's own flash, and a reference's at the strength the diff theme asks for. */
function flashes(): Array<{ name: string; value: string }> {
  return [
    { name: 'changes flash', value: cssValue(editor, '.cm-line.cm-changesFlash', 'background').value },
    { name: 'reference reveal', value: `hsl(var(--halo-warning) / ${cssValue(editor, editorSelector, '--halo-reveal-alpha').value})` },
  ]
}
const textColors = [...new Set([
  cssValue(editor, editorSelector, 'color').value,
  ...diffHighlightStyle.specs.map(spec => String(spec.color)),
])]

function diffSurfaces(tokens: Tokens): Surface[] {
  const background = color(cssValue(editor, editorSelector, 'background-color').value, tokens).rgb
  const surfaces: Surface[] = [{ name: 'unchanged', rgb: background }]
  for (const change of changes) {
    const line = composite(color(cssValue(editor, change.line, 'background').value, tokens), background)
    const word = color(cssValue(editor, change.word, 'background').value, tokens)
    surfaces.push({ name: `${change.name} line`, rgb: line }, { name: `${change.name} word over line`, rgb: composite(word, line) })
  }
  for (const selector of wholeLines) {
    surfaces.push({ name: selector, rgb: composite(color(cssValue(editor, selector, 'background-color').value, tokens), background) })
  }
  for (const { name, value } of flashes()) {
    const flash = composite(color(value, tokens), background)
    surfaces.push({ name, rgb: flash })
    for (const change of changes) {
      surfaces.push({ name: `${name} with ${change.name} word`, rgb: composite(color(cssValue(editor, change.word, 'background').value, tokens), flash) })
    }
  }
  // Selection is behind CodeMirror's content; placing it on top is the stricter contrast check.
  const selection = color(cssValue(editor, '::selection', 'background-color').value, tokens)
  return [...surfaces, ...surfaces.map(surface => ({ name: `selected ${surface.name}`, rgb: composite(selection, surface.rgb) }))]
}

describe('diff theme contrast', () => {
  it('uses opaque foreground for comments and neutral syntax, with four scoped accents', () => {
    const foreground = cssValue(editor, editorSelector, 'color').value
    for (const tag of [tags.variableName, tags.propertyName, tags.typeName, tags.className, tags.operator, tags.punctuation, tags.lineComment, tags.blockComment, tags.docComment]) {
      expect(syntaxColor(tag)).toBe(foreground)
    }
    for (const [tag, token] of [
      [tags.controlKeyword, '--diff-syntax-keyword'],
      [tags.function(tags.variableName), '--diff-syntax-function'],
      [tags.function(tags.propertyName), '--diff-syntax-function'],
      [tags.special(tags.string), '--diff-syntax-string'],
      [tags.integer, '--diff-syntax-number'],
    ] as const) {
      expect(syntaxColor(tag)).toBe(`hsl(var(${token}))`)
    }
    for (const theme of ['dark', 'light'] as const) {
      for (const value of textColors) expect(color(value, themeTokens(theme)).alpha).toBe(1)
    }
    for (const spec of diffHighlightStyle.specs) expect(spec.opacity).toBeUndefined()
    const source = readFileSync(new URL('../../../../../src/renderer/components/canvas/viewers/changes/diff/diff-editor.ts', import.meta.url), 'utf8')
    expect(source).toContain('syntaxHighlighting(diffHighlightStyle)')
    expect(source).not.toContain('haloHighlightStyle')
  })

  it('replaces gradient underlines and text decorations with quiet line and word fills', () => {
    const tokens = themeTokens('dark')
    for (const change of changes) {
      const line = cssValue(editor, change.line, 'background')
      const word = cssValue(editor, change.word, 'background')
      expect(line.important).toBe(true)
      expect(word.important).toBe(true)
      expect(color(line.value, tokens).alpha).toBeGreaterThanOrEqual(0.06)
      expect(color(line.value, tokens).alpha).toBeLessThanOrEqual(0.08)
      expect(color(word.value, tokens).alpha).toBeGreaterThanOrEqual(0.12)
      expect(color(word.value, tokens).alpha).toBeLessThanOrEqual(0.16)
      expect(cssValue(editor, change.word, 'text-decoration')).toEqual({ value: 'none', important: true })
    }
    for (const selector of wholeLines) {
      const alpha = color(cssValue(editor, selector, 'background-color').value, tokens).alpha
      expect(alpha).toBeGreaterThanOrEqual(0.06)
      expect(alpha).toBeLessThanOrEqual(0.08)
    }
    for (const selector of ['.cm-merge-a .cm-changedLineGutter', '.cm-merge-b .cm-changedLineGutter', '.cm-deletedLineGutter', '.cm-inlineChangedLineGutter']) {
      expect(color(cssValue(editor, selector, 'background').value, tokens).alpha).toBe(1)
    }
    expect(cssValue(editor, '.cm-changeGutter', 'width').value).toBe('3px')
    expect(cssValue(editor, '.cm-line.cm-changesFocus', 'box-shadow').value).toContain('hsl(var(--primary))')
    expect(cssValue(editor, '.cm-line.cm-changesFlash', 'background').important).toBe(true)
    // References own the reveal flash and read its strength from the editor.
    expect(referencesSource).toContain("backgroundColor: 'hsl(var(--halo-warning) / var(--halo-reveal-alpha, 0.32)) !important'")
    expect(readFileSync(new URL('../../../../../src/renderer/components/canvas/viewers/changes/diff/diff-theme.ts', import.meta.url), 'utf8')).not.toContain('cm-haloRevealLine')
    for (const { value } of flashes()) expect(color(value, tokens).alpha).toBeGreaterThan(0.08)
  })

  for (const theme of ['dark', 'light'] as const) {
    it(`clears WCAG AA on ${theme} backgrounds, layered changes, selections and reveals`, () => {
      const tokens = themeTokens(theme)
      const results = diffSurfaces(tokens).flatMap(surface => textColors.map(value => ({
        name: `${theme} ${value} on ${surface.name}`,
        ratio: contrast(color(value, tokens), surface.rgb),
      })))
      for (const result of results) expect(result.ratio, result.name).toBeGreaterThanOrEqual(4.5)
      const worst = results.reduce((a, b) => a.ratio < b.ratio ? a : b)
      console.info(`Minimum diff contrast: ${worst.ratio.toFixed(3)}:1 (${worst.name})`)
    })

    it(`keeps ${theme} collapsed bars readable without package gradients`, () => {
      const tokens = themeTokens(theme)
      for (const selector of ['.cm-collapsedLines', '.cm-collapsedLines:hover']) {
        const background = cssValue(editor, selector, 'background')
        const foreground = cssValue(editor, selector, 'color')
        expect(background.important).toBe(true)
        expect(color(background.value, tokens).alpha).toBe(1)
        expect(contrast(color(foreground.value, tokens), color(background.value, tokens).rgb)).toBeGreaterThanOrEqual(4.5)
      }
    })
  }
})
