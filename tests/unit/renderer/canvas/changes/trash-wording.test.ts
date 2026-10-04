/**
 * The trash a discarded new file goes to is the one on the computer Halo runs
 * on: the desktop app names it as that system does; a remote client, on
 * another device, names none rather than its own.
 */

import { describe, it, expect } from 'vitest'
import { trashWording } from '../../../../../src/renderer/components/canvas/viewers/changes/model/trash-wording'

const t = (key: string, options?: Record<string, unknown>) =>
  key.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''))

describe('naming the trash a new file goes to', () => {
  it('uses the Recycle Bin on a Windows computer and the Trash elsewhere', () => {
    expect(trashWording('notes.md', { isWindows: true }, t)).toEqual({
      title: 'Move notes.md to the Recycle Bin?',
      message: 'Git has no copy of this new file. You can restore it from the Recycle Bin.',
      confirmLabel: 'Move to Recycle Bin',
    })
    expect(trashWording('notes.md', { isWindows: false }, t)).toEqual({
      title: 'Move notes.md to the Trash?',
      message: 'Git has no copy of this new file. You can restore it from the Trash.',
      confirmLabel: 'Move to Trash',
    })
  })

  it('names no system when the computer Halo runs on is not the one showing the dialog', () => {
    expect(trashWording('notes.md', undefined, t)).toEqual({
      title: 'Move notes.md to your computer’s trash?',
      message: 'Git has no copy of this new file. You can restore it from your computer’s trash.',
      confirmLabel: 'Move to trash',
    })
  })
})
