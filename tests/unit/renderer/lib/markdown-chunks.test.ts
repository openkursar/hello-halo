/**
 * Unit tests for splitMarkdownIntoChunks's correctness guards.
 *
 * These pin down two rounds of fixes: a set of chunk-boundary counterexamples,
 * and the false-positive regression found afterwards by running the fixed
 * splitter against this repo's own real markdown corpus. An unclosed HTML
 * block/comment/raw-text element, or a footnote *definition*, must never be
 * split across chunks,
 * and a new chunk may never start on an indented line — but none of that may
 * come at the cost of collapsing an ordinary long document (or one that
 * merely *resembles* HTML inside a code span, a regex, or a pasted stack
 * trace) into one giant, unvirtualized chunk. `minChars`/`maxChars` are
 * shrunk via options so small synthetic inputs can still cross the split
 * thresholds without needing megabyte-sized fixtures.
 */

import { describe, it, expect } from 'vitest'
import { splitMarkdownIntoChunks } from '../../../../src/renderer/lib/markdown-chunks'

const SMALL = { minChars: 200, maxChars: 500 }

/** Index of the first chunk containing `needle`, or -1 if none does. */
function chunkContaining(chunks: string[], needle: string): number {
  return chunks.findIndex(chunk => chunk.includes(needle))
}

/**
 * Index of the last chunk containing `needle`, or -1 if none does. Needed
 * when a document has more than one occurrence of the same closing tag text
 * (nested same-name tags) and the one that matters is the outermost — the
 * textually last one — not whichever comes first.
 */
function lastChunkContaining(chunks: string[], needle: string): number {
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].includes(needle)) return i
  }
  return -1
}

/**
 * A document should get roughly one chunk per `4 * maxChars` of content —
 * looser than "one chunk per maxChars" because a real boundary (blank line
 * outside any fence/HTML/footnote state) isn't guaranteed on every page, but
 * tight enough to catch a false-positive guard silently gluing most of the
 * document into one oversized chunk (which "chunks.length > 1" cannot: a
 * document can produce 2 chunks and still have kept 90%+ of its bulk stuck
 * together in one of them).
 */
function minProportionalChunks(contentLength: number, maxChars: number): number {
  return contentLength / (4 * maxChars)
}

describe('splitMarkdownIntoChunks — unclosed HTML guards', () => {
  it('keeps an unclosed <details> container in one chunk, but still splits after it closes', () => {
    const doc = [
      '<details>',
      '<summary>Expand</summary>',
      '',
      'x'.repeat(300), // exceeds maxChars while still inside the container
      '',
      '## Inner Heading',
      '',
      'secret body',
      '',
      '</details>',
      '',
      '## After',
      '',
      'y'.repeat(600) // past the container, splitting should resume
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<details>')
    const closeIdx = chunkContaining(chunks, '</details>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('keeps an unclosed HTML comment in one chunk, but still splits after it closes', () => {
    const doc = [
      'Intro ' + 'x'.repeat(300),
      '',
      '<!--',
      '',
      '# TODO delete this',
      '',
      'draft text',
      '',
      '-->',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<!--')
    const closeIdx = chunkContaining(chunks, '-->')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('keeps an unclosed <pre> raw-text block in one chunk, but still splits after it closes', () => {
    const doc = [
      '<pre>',
      'x'.repeat(600), // exceeds maxChars while still inside the block
      '',
      'y'.repeat(50),
      '</pre>',
      '',
      '## After',
      '',
      'z'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<pre>')
    const closeIdx = chunkContaining(chunks, '</pre>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
    expect(chunks.length).toBeGreaterThan(1)
  })

  // The self-closing check must apply to the specific tag HTML_OPEN_RE matched,
  // not to however the line happens to end — otherwise a block-level open tag
  // followed later on the same line by an unrelated self-closed tag reads as
  // "this line is self-closing" and the guard never engages. All three shapes
  // below leaked real hidden content open before this was fixed.
  it('keeps a <div> open across a same-line trailing self-closed tag (GitHub README header form)', () => {
    const doc = [
      '<div align="center">',
      '<img src="logo.png"/>',
      '',
      'x'.repeat(600), // exceeds maxChars while still inside the div
      '',
      '## Inside',
      '',
      'secret body',
      '',
      '</div>',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<div align="center">')
    const closeIdx = chunkContaining(chunks, '</div>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
  })

  it('keeps <details> open when followed on the same line by a self-closed tag (<details><br/>)', () => {
    const doc = [
      '<details><br/>',
      '<summary>Expand</summary>',
      '',
      'x'.repeat(600),
      '',
      '## Inside',
      '',
      'secret body',
      '',
      '</details>',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<details><br/>')
    const closeIdx = chunkContaining(chunks, '</details>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
  })

  it('recognizes an open tag whose name runs straight to end of line, attributes on the next line', () => {
    const doc = [
      '<div',
      '  class="note">',
      'Some content inside the div.',
      '',
      'x'.repeat(600),
      '',
      '## Inside',
      '',
      'secret body',
      '',
      '</div>',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<div')
    const closeIdx = chunkContaining(chunks, '</div>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
  })
})

describe('splitMarkdownIntoChunks — nested same-name HTML tags', () => {
  // While the stack was non-empty, only a close was ever checked — a new
  // (nested) open on the same or a later line was never pushed. So the
  // inner tag's own close popped the *outer* tag's stack entry early,
  // leaving the outer tag's real close to fall through unmatched and the
  // outer container to be split open. Checking close and open independently, unconditionally,
  // fixes it — both real content forms below are things people actually
  // write (centered image/badge groups, multi-level collapsible FAQs).
  it('keeps a nested <div> (centered image/card group) intact when the inner </div> closes first', () => {
    const doc = [
      '<div class="outer">',
      '<div class="inner">',
      'inner content',
      '</div>',
      '',
      'x'.repeat(600), // exceeds maxChars while still inside the outer div
      '',
      '## Inside',
      '',
      'more outer content',
      '',
      '</div>',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<div class="outer">')
    // Two `</div>` occurrences exist (inner, then outer) — the one that must
    // land with the opening tag is the last one, the outer's real close.
    const closeIdx = lastChunkContaining(chunks, '</div>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
  })

  it('keeps a nested <details> (multi-level collapsible FAQ) intact when the inner </details> closes first', () => {
    const doc = [
      '<details>',
      '<summary>Outer FAQ</summary>',
      '<details>',
      '<summary>Inner question</summary>',
      'inner secret answer',
      '</details>',
      '',
      'x'.repeat(600),
      '',
      '## Inside',
      '',
      'more outer secret content',
      '',
      '</details>',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<details>')
    const closeIdx = lastChunkContaining(chunks, '</details>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
  })
})

describe('splitMarkdownIntoChunks — sticky states are never forced closed early', () => {
  // No fence/comment/raw-text/HTML-tag state is ever timed out, no matter how
  // large — an earlier version force-closed a stuck state after a character
  // budget, which recovered chunking on documents with an isolated unclosed
  // fence but could also slice open a real, oversized <details> or comment.
  // Removed: losing virtualization on a misdetected document is an acceptable
  // cost, exposing hidden content isn't.
  it('keeps a very large <details> container intact regardless of size', () => {
    const doc = [
      '<details>',
      '<summary>Expand</summary>',
      '',
      'x'.repeat(3000),
      '',
      '## Inner Heading',
      '',
      'secret body',
      '',
      '</details>',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<details>')
    const closeIdx = chunkContaining(chunks, '</details>')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
  })

  it('keeps a very large HTML comment intact regardless of size', () => {
    const doc = [
      'Intro ' + 'x'.repeat(300),
      '',
      '<!--',
      '',
      'x'.repeat(3000),
      '',
      '-->',
      '',
      '## After',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    const openIdx = chunkContaining(chunks, '<!--')
    const closeIdx = chunkContaining(chunks, '-->')
    expect(openIdx).toBeGreaterThanOrEqual(0)
    expect(openIdx).toBe(closeIdx)
  })

  it('an isolated unterminated fence glues everything after it into one chunk (correct, not a bug)', () => {
    // No closing fence anywhere after this. Per CommonMark, everything from
    // here to the real end of the fenced block is literal code text, so there
    // is no boundary left to split on — collapsing here is the contract
    // ("Rendering it whole is slow, but it is the only answer that is still
    // correct"), not a performance regression to route around.
    const doc = [
      'Intro ' + 'x'.repeat(300),
      '',
      '```',
      '',
      '# not a real heading, this is inside the fence',
      '',
      'x'.repeat(3000),
      '',
      '<details>would not actually render</details>'
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    expect(chunks).toHaveLength(1)
  })
})

describe('splitMarkdownIntoChunks — footnote guard', () => {
  it('never splits a document containing a footnote reference/definition', () => {
    const doc = [
      'Ref here[^1].',
      '',
      'x'.repeat(600),
      '',
      '## Later',
      '',
      'text',
      '',
      '[^1]: the definition'
    ].join('\n')

    expect(splitMarkdownIntoChunks(doc, SMALL)).toHaveLength(1)
  })
})

describe('splitMarkdownIntoChunks — no chunk starts indented', () => {
  it('never starts a chunk on a nested (indented) list item', () => {
    const doc = Array.from({ length: 8 }, (_, i) =>
      `- one ${i} ${'w'.repeat(80)}\n\n  - two ${i} ${'w'.repeat(80)}\n\n    - three ${i} ${'w'.repeat(80)}\n`
    ).join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => !/^\s/.test(chunk))).toBe(true)
  })

  it('never starts a chunk mid indented-code-block, and keeps the block whole', () => {
    const doc = Array.from({ length: 6 }, (_, i) =>
      `Intro ${i}:\n\n    code line ${i} ${'x'.repeat(80)}\n\n    code line ${i}b ${'x'.repeat(80)}\n`
    ).join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => !/^\s/.test(chunk))).toBe(true)
  })
})

describe('splitMarkdownIntoChunks — splitting still works (no over-wide guard)', () => {
  it('still splits a plain long document with no HTML and no footnotes roughly proportionally', () => {
    const doc = Array.from(
      { length: 10 },
      (_, i) => `## Section ${i}\n\n${'word '.repeat(100)}\n`
    ).join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    expect(chunks.length).toBeGreaterThanOrEqual(minProportionalChunks(doc.length, SMALL.maxChars))
  })
})

describe('splitMarkdownIntoChunks — false-positive resistance (real corpus shapes)', () => {
  // These four all come from real documents in this repo:
  // a line-based, non-tokenizing HTML guard can mistake any of them for a
  // block-level open tag or a footnote, and get stuck for the rest of the file.
  function longDoc(middle: string): string {
    const filler = (label: string) => `Filler paragraph ${label} ${'word '.repeat(20)}\n`
    const before = Array.from({ length: 20 }, (_, i) => filler(`before-${i}`)).join('\n')
    const after = Array.from({ length: 20 }, (_, i) => filler(`after-${i}`)).join('\n')
    return `${before}\n${middle}\n\n## Later\n\n${after}`
  }

  it('a regex character class ([^a-z]) does not trip the footnote guard', () => {
    const doc = longDoc('Matches everything but a letter: `/[^a-z]/`.')
    const chunks = splitMarkdownIntoChunks(doc, SMALL)
    expect(chunks.length).toBeGreaterThanOrEqual(minProportionalChunks(doc.length, SMALL.maxChars))
  })

  it('a self-closing <script src="…" defer /> reference does not stick to end of file', () => {
    const doc = longDoc('Loaded via `<script src="/assets/app.js" defer />` in the page head.')
    const chunks = splitMarkdownIntoChunks(doc, SMALL)
    expect(chunks.length).toBeGreaterThanOrEqual(minProportionalChunks(doc.length, SMALL.maxChars))
  })

  it('inline JSX in a code span does not stick to end of file', () => {
    const doc = longDoc('Renders the icon: `<Star className="h-3.5 w-3.5 fill-current" />` in the header.')
    const chunks = splitMarkdownIntoChunks(doc, SMALL)
    expect(chunks.length).toBeGreaterThanOrEqual(minProportionalChunks(doc.length, SMALL.maxChars))
  })

  it('a pasted JS stack trace with <anonymous> does not stick to end of file', () => {
    const doc = longDoc('at async WebContents.<anonymous> (node:electron/js2c/browser_init:2:78381)')
    const chunks = splitMarkdownIntoChunks(doc, SMALL)
    expect(chunks.length).toBeGreaterThanOrEqual(minProportionalChunks(doc.length, SMALL.maxChars))
  })

  // The four above all place the tag mid-line, where HTML_OPEN_RE's `^` anchor
  // already excludes it — they exercise a shape that cannot fail. The ones
  // below start the line with the tag, which is the shape that did fail: any
  // word in angle brackets at column zero used to push onto the HTML stack and
  // never come off, turning virtualization off for the rest of the document.
  //
  // `minProportionalChunks` is too blunt to see this. Everything before the
  // tag still splits normally, so a document that glues its entire second half
  // into one chunk still clears that bar. Asserting that the text after the
  // tag went on splitting is what actually distinguishes the two outcomes.
  it.each([
    ['<webview> starting a sentence about the tag', '<webview> is how the browser panel embeds a page.'],
    ['<anonymous> at the start of a stack frame line', '<anonymous> (node:electron/js2c/browser_init:2:78381)'],
    ['<Star> written as a bare JSX element', '<Star className="h-4 w-4" >'],
    ['<tool_call> opening a pasted agent transcript', '<tool_call>\nname: Read\npath: /tmp/x']
  ])('a line starting with %s does not stick to end of file', (_label, middle) => {
    const chunks = splitMarkdownIntoChunks(longDoc(middle), SMALL)
    const heading = chunkContaining(chunks, '## Later')
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(lastChunkContaining(chunks, 'after-19')).toBeGreaterThan(heading)
  })

  // The other half of the same boundary: restricting the stack to CommonMark's
  // block-level names must not stop guarding the containers that do wrap
  // content in the DOM.
  it.each(['div', 'details', 'table', 'section', 'blockquote'])(
    'nothing is split away from an unclosed <%s>',
    (tag) => {
      const doc = longDoc(`<${tag}>\n\nBody that must not be split away from its container.`)
      const chunks = splitMarkdownIntoChunks(doc, SMALL)
      expect(chunkContaining(chunks, `<${tag}>`)).toBe(chunks.length - 1)
    }
  )
})

describe('splitMarkdownIntoChunks — fenced code block (regression protection)', () => {
  it('never splits inside a fenced code block, even when it contains a blank line', () => {
    const doc = [
      'Intro ' + 'x'.repeat(300),
      '',
      '```js',
      'const x = 1',
      '',
      '',
      'const y = 2',
      '```',
      '',
      '## Next',
      '',
      'y'.repeat(600)
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    for (const chunk of chunks) {
      const fenceMarkers = chunk.match(/```/g)?.length ?? 0
      expect(fenceMarkers % 2).toBe(0)
    }
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe('splitMarkdownIntoChunks — nested same-name HTML containers', () => {
  // The stack used to push only while it was empty, so an inner </div> popped
  // the OUTER one and cleared the stack early. Everything after that inner
  // close became splittable even though it was still inside the outer
  // container — for <details> that means collapsed content renders as visible
  // markdown, the same failure the unclosed-HTML guards above exist to stop.
  it('keeps a nested <div> inside its outer container', () => {
    const doc = [
      '<div>',
      '',
      'x'.repeat(300),
      '',
      '<div>',
      '',
      'y'.repeat(300),
      '',
      '</div>', // inner close — must NOT be read as closing the outer <div>
      '',
      '## Heading After Inner Close',
      '',
      'still inside the outer div',
      '',
      '</div>'
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    expect(chunkContaining(chunks, '## Heading After Inner Close')).toBe(0)
    expect(chunks).toHaveLength(1)
  })

  it('keeps a nested <details> collapsed rather than exposing its body', () => {
    const doc = [
      '<details>',
      '<summary>Outer</summary>',
      '',
      'x'.repeat(300),
      '',
      '<details>',
      '<summary>Inner</summary>',
      '',
      'y'.repeat(300),
      '',
      '</details>',
      '',
      '## Heading After Inner Close',
      '',
      'secret body that must stay collapsed',
      '',
      '</details>'
    ].join('\n')

    const chunks = splitMarkdownIntoChunks(doc, SMALL)

    // Both the heading and the secret body must stay in the chunk that still
    // has the outer <details> open around them.
    expect(chunkContaining(chunks, 'secret body that must stay collapsed')).toBe(0)
    expect(chunks).toHaveLength(1)
  })
})
