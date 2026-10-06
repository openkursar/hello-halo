/**
 * IM channel types are named and colored from one place in the renderer. Every
 * channel Halo connects shows its name — a chat over a WeChat iLink bot used to
 * show the raw "weixin-ilink-bot" in the chat header and on the bot and
 * session cards, whose map had fallen behind the others — and no component
 * keeps a map of its own.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { fileURLToPath } from 'url'
import { IM_CHANNEL_TYPES } from '../../../src/shared/types/im-channel'
import { CHANNEL_LABELS, getImChannelDisplay } from '../../../src/renderer/components/apps/im-channel-labels'

const RENDERER = fileURLToPath(new URL('../../../src/renderer', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return name === 'locales' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('IM channel names', () => {
  it.each(IM_CHANNEL_TYPES)('names %s instead of showing its type, in its own color', (type) => {
    const display = getImChannelDisplay(type)

    expect(display.label).not.toBe(type)
    expect(display.color).not.toBe('text-muted-foreground')
    expect(CHANNEL_LABELS[type]).toBe(display.label)
  })

  it('names a WeChat iLink bot where only the name is shown', () => {
    expect(CHANNEL_LABELS['weixin-ilink-bot']).toBe('WeChat iLink')
  })

  it('shows a type it does not know as itself, muted', () => {
    expect(getImChannelDisplay('future-bot')).toEqual({ label: 'future-bot', color: 'text-muted-foreground' })
  })

  it('is the only channel map in the renderer', () => {
    const entry = new RegExp(`['"](${IM_CHANNEL_TYPES.join('|')})['"]\\s*:`)
    const ownMaps = sourceFiles(RENDERER)
      .filter(path => !path.endsWith('im-channel-labels.ts') && entry.test(readFileSync(path, 'utf8')))
      .map(path => relative(RENDERER, path))

    expect(ownMaps).toEqual([])
  })
})
