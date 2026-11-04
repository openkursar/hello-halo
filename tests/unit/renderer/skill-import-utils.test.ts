/**
 * Unit tests for skill package parsing.
 *
 * The case handling is the point: a `skill.md` authored on macOS or Windows is
 * a working skill there and an invisible one on Linux, because everything
 * downstream — frontmatter normalization, the on-disk sync, SDK discovery —
 * addresses `SKILL.md` exactly. Import has to absorb that, not reject it.
 */

import { describe, it, expect, vi } from 'vitest'
import { zipSync } from 'fflate'
import { parseSkillFiles, processZipFile, processFileListAsFolder, processDirectoryEntry, processMdFile, MAX_SKILL_BYTES, MAX_SKILL_FILES } from '../../../src/renderer/components/apps/skill-import-utils'

vi.mock('i18next', () => ({ t: (text: string) => text }))

const SKILL_MD = `---
name: my-skill
description: Does a thing.
---

# My Skill
`

const encoder = new TextEncoder()

function file(name: string, bytes: Uint8Array, relativePath = ''): File {
  return { name, size: bytes.length, webkitRelativePath: relativePath,
    arrayBuffer: async () => bytes.slice().buffer } as File
}

function directory(files: Record<string, Uint8Array>): FileSystemDirectoryEntry {
  const entries: FileSystemEntry[] = []
  const folders = new Map<string, Record<string, Uint8Array>>()
  for (const [path, bytes] of Object.entries(files)) {
    const slash = path.indexOf('/')
    if (slash < 0) {
      entries.push({ name: path, isFile: true, isDirectory: false,
        file: (resolve: (value: File) => void) => resolve(file(path, bytes)) } as FileSystemFileEntry)
    } else {
      const name = path.slice(0, slash)
      if (!folders.has(name)) folders.set(name, {})
      folders.get(name)![path.slice(slash + 1)] = bytes
    }
  }
  for (const [name, children] of folders) entries.push({ ...directory(children), name })
  return { name: 'fixture', isDirectory: true, isFile: false, createReader: () => {
    let done = false
    return { readEntries: (resolve: (values: FileSystemEntry[]) => void) => {
      resolve(done ? [] : entries)
      done = true
    } }
  } } as FileSystemDirectoryEntry
}

const importers = {
  zip: (files: Record<string, Uint8Array>) => processZipFile(file('fixture.zip', zipSync(files))),
  fileList: (files: Record<string, Uint8Array>) => processFileListAsFolder(
    Object.entries(files).map(([path, bytes]) => file(path, bytes, `fixture/${path}`)) as unknown as FileList),
  directory: (files: Record<string, Uint8Array>) => processDirectoryEntry(directory(files)),
}

for (const [source, load] of Object.entries(importers)) {
  describe(`${source} byte fidelity`, () => {
    it('preserves binary, BOM, Unicode, empty and nested files through one wrapper', async () => {
      const files = {
        'wrapped/skill.md': encoder.encode('\uFEFF' + SKILL_MD),
        'wrapped/assets/template.docx': new Uint8Array([80, 75, 0, 255, 128, 3]),
        'wrapped/assets/valid-utf8-binary.bin': new Uint8Array([0, 1, 2]),
        'wrapped/references/guide.md': encoder.encode('\uFEFF中文\r\n'),
        'wrapped/empty.txt': new Uint8Array(),
        '__MACOSX/._wrapped': new Uint8Array([255]),
        'wrapped/.DS_Store': new Uint8Array([255]),
      }
      const result = await load(files)
      expect(result.name).toBe('my-skill')
      expect(result.skillFiles['SKILL.md']).toBe('\uFEFF' + SKILL_MD)
      for (const [path, bytes] of Object.entries(files)) {
        if (!path.startsWith('wrapped/') || path.endsWith('.DS_Store')) continue
        const key = path.slice(8).replace(/^skill.md$/, 'SKILL.md')
        const actual = result.skillAssets?.[key]
          ? new Uint8Array(Buffer.from(result.skillAssets[key].content, 'base64'))
          : encoder.encode(result.skillFiles[key])
        expect(actual).toEqual(bytes)
      }
      expect(Object.keys(result.skillAssets!)).toHaveLength(2)
      expect(Object.keys(result.skillFiles)).toHaveLength(3)
    })

    it('rejects malformed UTF-8 in SKILL.md rather than replacing bytes', async () => {
      await expect(load({ 'SKILL.md': new Uint8Array([255]) })).rejects.toThrow(/UTF-8/)
    })

    it.each(['../escape', '/absolute', 'C:/drive', 'a\\escape', 'a/../escape', 'a/./escape', 'a\0bad'])(
      'rejects unsafe path %s', async path => {
        await expect(load({ 'SKILL.md': encoder.encode(SKILL_MD), [path]: new Uint8Array([255]) })).rejects.toThrow(/unsafe|safe root/)
      })

    it('rejects oversized expanded content', async () => {
      await expect(load({ 'SKILL.md': encoder.encode(SKILL_MD), 'large.bin': new Uint8Array(MAX_SKILL_BYTES) }))
        .rejects.toThrow(/10 MB/)
    })

    it('rejects excessive file counts', async () => {
      const files: Record<string, Uint8Array> = { 'SKILL.md': encoder.encode(SKILL_MD) }
      for (let i = 0; i < MAX_SKILL_FILES; i++) files[`file-${i}`] = new Uint8Array()
      await expect(load(files)).rejects.toThrow(/2000/)
    })
  })
}

it('preserves BOM in a standalone markdown import', async () => {
  const content = '\uFEFF' + SKILL_MD
  expect((await processMdFile(file('test.md', encoder.encode(content)))).skillFiles['SKILL.md']).toBe(content)
})

describe('parseSkillFiles', () => {
  it('accepts a misspelled entry file and ships it canonically', () => {
    const parsed = parseSkillFiles({ 'skill.md': SKILL_MD }, 'folder')
    expect(parsed.name).toBe('my-skill')
    expect(Object.keys(parsed.skillFiles)).toEqual(['SKILL.md'])
  })

  it('unwraps a wrapping folder before looking for the entry file', () => {
    const parsed = parseSkillFiles({ 'my-skill/SKILL.md': SKILL_MD }, 'my-skill')
    expect(parsed.skillFiles).toEqual({ 'SKILL.md': SKILL_MD })
  })

  it('never ships macOS metadata into the skill', () => {
    const parsed = parseSkillFiles({
      'SKILL.md': SKILL_MD,
      '.DS_Store': 'binary junk',
      '._SKILL.md': 'binary junk',
      'references/.DS_Store': 'binary junk',
      'references/guide.md': 'a guide',
    }, 'my-skill')
    expect(Object.keys(parsed.skillFiles).sort()).toEqual(['SKILL.md', 'references/guide.md'])
  })

  it('keeps Halo metadata riding alongside the skill', () => {
    const parsed = parseSkillFiles({
      'SKILL.md': SKILL_MD,
      'index.js': 'export default 1',
      'spec.yaml': 'type: skill',
    }, 'my-skill')
    expect(Object.keys(parsed.skillFiles).sort()).toEqual(['SKILL.md', 'index.js', 'spec.yaml'])
  })

  it('reads the description from the frontmatter', () => {
    expect(parseSkillFiles({ 'SKILL.md': SKILL_MD }, 'folder').description).toBe('Does a thing.')
  })

  it('falls back to the folder name when frontmatter carries none', () => {
    expect(parseSkillFiles({ 'SKILL.md': '# No frontmatter' }, 'My Folder').name).toBe('my-folder')
  })

  it('rejects a tree with no entry file', () => {
    expect(() => parseSkillFiles({ 'readme.md': 'a' }, 'folder')).toThrow(/SKILL\.md not found/)
  })
})
