// Word joiner and BOM can be pasted as invisible padding, but are not Unicode White_Space.
const outerPasteWhitespace = /^[\p{White_Space}\u200B\u2060\uFEFF]+|[\p{White_Space}\u200B\u2060\uFEFF]+$/gu
const pasteWhitespace = /[\p{White_Space}\u200B\u2060\uFEFF]/u

/** Use only for values whose format excludes whitespace at the edges, never secrets or free text. */
export function trimPastedValue(value: string): string {
  return value.replace(outerPasteWhitespace, '')
}

export function hasPasteWhitespace(value: string): boolean {
  return pasteWhitespace.test(value)
}
