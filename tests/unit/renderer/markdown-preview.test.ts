/**
 * A clamped preview reads as the text, never as Markdown source.
 */

import { describe, expect, it } from 'vitest'
import { markdownDigest, markdownPreview } from '../../../src/renderer/utils/markdown-preview'

describe('markdownPreview', () => {
  it('drops syntax marks and keeps one line per block', () => {
    const report = [
      '润色完成，v2 已交付主编。',
      '',
      '**成果**',
      '- 成稿：`halo-promo-v2.md`',
      '- 正文 **1611 字**',
      '',
      '## 守住的边界',
      '> 结构未重排',
    ].join('\n')
    expect(markdownPreview(report)).toBe('润色完成，v2 已交付主编。\n成果\n• 成稿：halo-promo-v2.md\n• 正文 1611 字\n守住的边界\n结构未重排')
  })

  it('keeps link and image text and drops fences, rules and table separators', () => {
    const text = ['See [the brief](https://example.com) ![chart](a.png)', '```ts', 'const a = 1', '```', '---', '| a | b |', '| --- | :-: |', '- [x] done'].join('\n')
    expect(markdownPreview(text)).toBe('See the brief chart\nconst a = 1\n| a | b |\n• done')
  })

  it('leaves plain text as it is', () => {
    expect(markdownPreview('Draft sent to the editor')).toBe('Draft sent to the editor')
  })
})

describe('markdownDigest', () => {
  it('opens with the first paragraph and outlines the sections', () => {
    const report = ['## 完成情况', '润色完成，', 'v2 已交付主编。', '', '**成果**', '- 成稿', '- 正文', '', '## 守住的边界', '> 结构未重排'].join('\n')
    expect(markdownDigest(report)).toEqual({ lead: '润色完成， v2 已交付主编。', outline: ['完成情况', '成果', '守住的边界'], whole: false })
  })

  it('outlines top-level items when there are no sections, and never reads a fence as the opening', () => {
    expect(markdownDigest(['```', 'code', '```', '1. **a** done', '   detail', '2. b'].join('\n'))).toEqual({ lead: '', outline: ['a done', 'b'], whole: false })
  })

  it('names a bold lead-in section without the colon that introduces it', () => {
    expect(markdownDigest(['**为什么之前没有协作：**', 'x', '**这一版补的：**', 'y'].join('\n')).outline).toEqual(['为什么之前没有协作', '这一版补的'])
  })

  it('says a plain reply is whole', () => {
    expect(markdownDigest('Draft sent to the editor')).toEqual({ lead: 'Draft sent to the editor', outline: [], whole: true })
  })
})
