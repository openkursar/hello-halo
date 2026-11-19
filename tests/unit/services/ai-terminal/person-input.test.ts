/**
 * Only what a person did may tell the AI "the user typed here". The viewer's
 * terminal also writes to the pty by itself — answers to the program's queries,
 * focus changes, mouse movement — and none of that is anyone acting.
 */

import { describe, expect, it } from 'vitest'
import { isPersonInput } from '../../../../src/main/services/ai-terminal/person-input'

describe('what counts as a person typing', () => {
  it.each([
    ['letters', 'ls -la'],
    ['Enter', '\r'],
    ['Ctrl+C', '\x03'],
    ['an arrow key', '\x1b[A'],
    ['Escape', '\x1b'],
    ['Tab', '\t'],
    ['pasted text', 'echo "hi"\r'],
    ['a typed word after a reply', '\x1b[12;40Rok'],
    ['a mouse button press', '\x1b[<0;10;5M'],
    ['a wheel scroll in a program that asked for the mouse', '\x1b[<64;10;5M'],
    ['an old-style mouse press', '\x1b[M !!'],
  ])('counts %s', (_name, data) => {
    expect(isPersonInput(data)).toBe(true)
  })

  it.each([
    ['a cursor position report', '\x1b[12;40R'],
    ['a device attributes reply', '\x1b[?62;4c'],
    ['a secondary device attributes reply', '\x1b[>0;276;0c'],
    ['a device status reply', '\x1b[0n'],
    ['focus gained', '\x1b[I'],
    ['focus lost', '\x1b[O'],
    ['a mode report', '\x1b[?2004;2$y'],
    ['a window size report', '\x1b[8;24;80t'],
    ['a colour reply', '\x1b]11;rgb:0000/0000/0000\x07'],
    ['a colour reply ended with ST', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
    ['a DCS reply', '\x1bP1$r0m\x1b\\'],
    ['mouse movement', '\x1b[<35;10;5M'],
    ['a mouse button release', '\x1b[<0;10;5m'],
    ['several replies in a row', '\x1b[I\x1b[12;40R\x1b[?62;4c'],
    ['nothing', ''],
  ])('does not count %s', (_name, data) => {
    expect(isPersonInput(data)).toBe(false)
  })
})
