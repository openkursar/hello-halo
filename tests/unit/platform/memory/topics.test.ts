/**
 * platform/memory topics + section: front matter, the scan, the generated index,
 * and how it reaches the agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  parseTopicFrontMatter,
  scanTopics,
  renderTopicIndexLines,
  flattenTopics,
} from '../../../../src/main/platform/memory/topics'
import { buildMemorySnapshot } from '../../../../src/main/platform/memory/snapshot'
import { renderMemorySection } from '../../../../src/main/platform/memory/section'
import { resolveMemoryLayout } from '../../../../src/main/platform/memory/paths'

function topic(description: string, body = 'body'): string {
  return `---\nname: x\ndescription: ${description}\n---\n${body}\n`
}

describe('parseTopicFrontMatter', () => {
  it('reads name and description, quoted or not, with colons in the value', () => {
    expect(parseTopicFrontMatter('---\nname: "A: b"\ndescription: when x: y happens\n---\nbody'))
      .toEqual({ name: 'A: b', description: 'when x: y happens' })
  })

  it('yields nothing without a leading block', () => {
    expect(parseTopicFrontMatter('# Title\ndescription: not front matter')).toEqual({})
  })
})

describe('scanTopics', () => {
  let root = ''
  beforeEach(() => {
    root = join(mkdtempSync(join(tmpdir(), 'topics-')), 'topics')
    mkdirSync(join(root, 'halo-product'), { recursive: true })
    mkdirSync(join(root, 'bare'), { recursive: true })
    mkdirSync(join(root, '.hidden'), { recursive: true })
    writeFileSync(join(root, 'halo-product', 'index.md'), topic('when someone asks how to use Halo'))
    writeFileSync(join(root, 'halo-product', 'migration.md'), topic('when moving a digital human'))
    writeFileSync(join(root, 'bare', 'loose.md'), 'no front matter')
    writeFileSync(join(root, '.hidden', 'secret.md'), topic('never listed'))
    writeFileSync(join(root, 'visitor-faq.md'), topic('a visitor asks a general question'))
    writeFileSync(join(root, 'notes.txt'), 'ignored')
  })
  afterEach(() => rmSync(join(root, '..'), { recursive: true, force: true }))

  it('builds the tree: categories first, index.md describes the folder, hidden and non-md skipped', async () => {
    const tree = await scanTopics(root)
    expect(tree.topicCount).toBe(3)
    expect(tree.children.map(n => n.relPath)).toEqual(['bare', 'halo-product', 'visitor-faq.md'])
    const product = tree.children[1]
    expect(product.kind).toBe('category')
    if (product.kind === 'category') {
      expect(product.description).toBe('when someone asks how to use Halo')
      expect(product.children.map(c => c.relPath)).toEqual(['halo-product/migration.md'])
    }
    expect(flattenTopics(tree.children).map(t => t.relPath)).not.toContain('.hidden/secret.md')
  })

  it('returns an empty tree when there is no topics folder', async () => {
    const tree = await scanTopics(join(root, 'missing'))
    expect(tree.topicCount).toBe(0)
    expect(tree.children).toEqual([])
  })

  it('renders files with .md and folders with /, and flags what is missing', async () => {
    const { lines, folded } = renderTopicIndexLines(await scanTopics(root))
    expect(folded).toBe(false)
    expect(lines).toContain('- halo-product/ — when someone asks how to use Halo')
    expect(lines.some(l => /^ {2}- migration\.md \(\d+\.\dKB\) — when moving a digital human$/.test(l))).toBe(true)
    expect(lines).toContain('- bare/ — ⚠ no index.md')
    expect(lines.some(l => l.includes('loose.md') && l.includes('⚠ no description'))).toBe(true)
  })

  it('folds deeper levels into counts when the budget runs out, never dropping the top level', async () => {
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(root, 'halo-product', `t${String(i).padStart(2, '0')}.md`), topic(`case ${i} `.repeat(8)))
    }
    const { lines, folded } = renderTopicIndexLines(await scanTopics(root), 600)
    expect(folded).toBe(true)
    expect(lines.some(l => l.startsWith('- halo-product/'))).toBe(true)
    expect(lines.some(l => l.startsWith('- visitor-faq.md'))).toBe(true)
    expect(lines.some(l => l.includes('more in halo-product/') || l.includes('(31 topics)'))).toBe(true)
  })
})

describe('renderMemorySection', () => {
  let space = ''
  beforeEach(() => { space = mkdtempSync(join(tmpdir(), 'section-')) })
  afterEach(() => rmSync(space, { recursive: true, force: true }))

  const layoutOf = (dir: string) => resolveMemoryLayout({ type: 'user', spaceId: 's', spacePath: dir }, 'space')

  it('shows # now, the recent History titles and the generated topic index — not every heading', async () => {
    const layout = layoutOf(space)
    mkdirSync(layout.topicsDir, { recursive: true })
    writeFileSync(join(layout.topicsDir, 'release.md'), topic('when shipping a release'))
    const history = Array.from({ length: 40 }, (_, i) => `## 2026-01-01-${String(1000 + 39 - i)} | entry ${39 - i}`).join('\n')
    mkdirSync(join(space, '.halo'), { recursive: true })
    writeFileSync(layout.file, `# now\n## State | busy\n- a: 1\n\n# History\n${history}\n`)

    const section = renderMemorySection(await buildMemorySnapshot(layout), { framing: 'FRAMING', recentHistory: 3 })
    const nowAt = section.indexOf('### Working Memory')
    const historyAt = section.indexOf('### History: 40 entries')
    const topicsAt = section.indexOf('### Topics — generated from the files each time; edit the files, never this list')
    expect(nowAt).toBeGreaterThan(-1)
    expect(historyAt).toBeGreaterThan(nowAt)
    expect(topicsAt).toBeGreaterThan(historyAt)
    expect(section).toContain('entry 39')
    expect(section).toContain('entry 37')
    expect(section).not.toContain('entry 36')
    expect(section).toContain('37 older')
    expect(section).not.toContain('### Structure')
    expect(section).toContain('release.md')
    expect(section).toContain('FRAMING')
  })

  it('cuts a large # now at a section boundary and says so', async () => {
    const layout = layoutOf(space)
    mkdirSync(join(space, '.halo'), { recursive: true })
    const sections = Array.from({ length: 20 }, (_, i) => `## Section ${i}\n${'- fact: value\n'.repeat(20)}`).join('\n')
    writeFileSync(layout.file, `# now\n${sections}\n# History\n## 2026-01-01-1000 | e\n`)
    const section = renderMemorySection(await buildMemorySnapshot(layout), { nowLimitBytes: 1024 })
    expect(section).toContain('## Section 0')
    expect(section).not.toContain('## Section 10')
    expect(section).toContain('only its first sections are shown')
  })

  it('cuts on a line when a section cut would keep too little, and closes a code fence it cuts', async () => {
    const layout = layoutOf(space)
    mkdirSync(join(space, '.halo'), { recursive: true })
    const huge = `## Huge\n\`\`\`\n${'- line in a fence\n'.repeat(200)}\`\`\`\n`
    writeFileSync(layout.file, `# now\n## State | s\n${huge}\n# History\n## 2026-01-01-1000 | e\n`)
    const section = renderMemorySection(await buildMemorySnapshot(layout), { nowLimitBytes: 1024 })
    expect(section).toContain('- line in a fence')
    const nowBlock = section.slice(section.indexOf('### Working Memory'), section.indexOf('(# now is'))
    expect((nowBlock.match(/```/g) ?? []).length % 2).toBe(0)
  })

  it('lists another memory\'s topics one level deep from what is left of the shared budget', async () => {
    const layout = layoutOf(space)
    mkdirSync(join(layout.topicsDir, 'own'), { recursive: true })
    writeFileSync(join(layout.topicsDir, 'own', 'index.md'), topic('when own'))
    writeFileSync(join(layout.topicsDir, 'own', 'a.md'), topic('when a'))
    const other = join(space, 'other')
    mkdirSync(join(other, 'cat'), { recursive: true })
    writeFileSync(join(other, 'cat', 'index.md'), topic('when the category fits'))
    writeFileSync(join(other, 'cat', 'deep.md'), topic('when deep'))
    const tree = await scanTopics(other)
    const section = renderMemorySection(await buildMemorySnapshot(layout), {
      readOnlyTopics: { title: 'Space memory topics (read-only)', note: 'NOTE', tree },
    })
    expect(section).toContain('  - a.md')
    expect(section).toContain('- cat/ — when the category fits (1 topics)')
    expect(section).not.toContain('deep.md')
  })

  it('shows topics with a missing memory file, without encouraging recreation from a snapshot', async () => {
    const layout = layoutOf(space)
    mkdirSync(layout.topicsDir, { recursive: true })
    writeFileSync(join(layout.topicsDir, 'a.md'), topic('when a'))
    const section = renderMemorySection(await buildMemorySnapshot(layout))
    expect(section).toContain('Memory file unavailable at startup')
    expect(section).toContain('do not recreate it')
    expect(section).toContain('a.md')
  })
})
