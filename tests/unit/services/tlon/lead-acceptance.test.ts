/**
 * Lead final-gate acceptance: exercise the REAL extract → ingest → service
 * pipeline (no extractText mock) with real-byte fixtures for the round-2
 * acceptance criteria — legacy encodings, UTF-16, corrupt document (failed
 * state), and a text-less source (no-text state).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import JSZip from 'jszip'
import { getTestDir } from '../../setup'

vi.mock('../../../../src/main/services/tlon/watcher', () => ({
  startWatchersForKB: vi.fn(), stopWatchersForKB: vi.fn(),
  startLinkedDirWatch: vi.fn(), stopLinkedDirWatch: vi.fn(),
}))
vi.mock('@parcel/watcher', () => ({ default: { subscribe: vi.fn() }, subscribe: vi.fn() }))
vi.mock('../../../../src/main/foundation/window.service', () => ({ sendToRenderer: vi.fn() }))
vi.mock('../../../../src/main/http/websocket', () => ({ broadcastToAll: vi.fn() }))

import {
  _resetTlonRegistry, _resetTlonHashCache, createKB, addRawFiles,
  getRawFileLearnedStatus, readHashes,
} from '../../../../src/main/services/tlon/service'
import { triggerFullIngest, getIngestProgress } from '../../../../src/main/services/tlon/ingest'
import { getKBTextDir } from '../../../../src/main/services/tlon/paths'
import { initializeApp } from '../../../../src/main/foundation/config.service'

function scratch(): string {
  const d = path.join(getTestDir(), 'lead-' + Math.random().toString(36).slice(2))
  fs.mkdirSync(d, { recursive: true })
  return d
}

// A syntactically valid .docx that is NOT a zip → jszip throws → extraction fails.
function corruptDocx(dir: string): string {
  const p = path.join(dir, 'corrupt.docx')
  fs.writeFileSync(p, Buffer.from('this is not a real docx, just plain bytes'))
  return p
}

function corpusText(kbId: string): string {
  const td = getKBTextDir(kbId)
  if (!fs.existsSync(td)) return ''
  return fs.readdirSync(td).filter(f => f.endsWith('.txt'))
    .map(f => fs.readFileSync(path.join(td, f), 'utf-8')).join('\n')
}

describe('Lead acceptance — real pipeline', () => {
  beforeEach(() => { initializeApp(); _resetTlonRegistry(); _resetTlonHashCache() })
  afterEach(() => { vi.restoreAllMocks() })

  it('GBK-encoded .txt is decoded to real Chinese (greppable), marked learned', async () => {
    const dir = scratch()
    // GBK bytes for 紫金山实验室门禁编号 (verified codepoints), plus ASCII " 8826".
    const gbkBytes = Buffer.from([
      0xd7,0xcf, 0xbd,0xf0, 0xc9,0xbd, 0xca,0xb5, 0xd1,0xe9, 0xca,0xd2, // 紫金山实验室
      0xc3,0xc5, 0xbd,0xfb, 0xb1,0xe0, 0xba,0xc5, // 门禁编号
      0x20,0x38,0x38,0x32,0x36, // " 8826"
    ])
    const f = path.join(dir, 'gate.txt'); fs.writeFileSync(f, gbkBytes)
    const kb = createKB({ name: 'GBK' })
    addRawFiles(kb.id, [f])
    await triggerFullIngest(kb.id)
    const text = corpusText(kb.id)
    expect(text).toContain('紫金山实验室')
    expect(text).toContain('8826')
    expect(text).not.toContain('\ufffd')
    const st = getRawFileLearnedStatus(kb.id).find(s => s.name === 'gate.txt')!
    expect(st.state).toBe('learned')
  })

  it('UTF-16LE BOM .txt is ingested (not dropped as binary) and greppable', async () => {
    const dir = scratch()
    const content = '会议纪要 Q3 revenue 1847.66'
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
    const f = path.join(dir, 'memo.txt'); fs.writeFileSync(f, u16)
    const kb = createKB({ name: 'U16' })
    addRawFiles(kb.id, [f])
    await triggerFullIngest(kb.id)
    const text = corpusText(kb.id)
    expect(text).toContain('会议纪要')
    expect(text).toContain('1847.66')
    const st = getRawFileLearnedStatus(kb.id).find(s => s.name === 'memo.txt')!
    expect(st.state).toBe('learned')
  })

  it('corrupt .docx → state=failed with a persisted error; batch reports errors[] and still completes', async () => {
    const dir = scratch()
    const bad = corruptDocx(dir)
    const good = path.join(dir, 'ok.md'); fs.writeFileSync(good, '# Fine\nreadable content')
    const kb = createKB({ name: 'Fail' })
    addRawFiles(kb.id, [bad, good])
    await triggerFullIngest(kb.id)
    const prog = getIngestProgress(kb.id)
    expect(prog.phase).toBe('done')
    expect(prog.errors?.some(e => e.file === 'corrupt.docx')).toBe(true)
    const statuses = getRawFileLearnedStatus(kb.id)
    const badSt = statuses.find(s => s.name === 'corrupt.docx')!
    expect(badSt.state).toBe('failed')
    expect(typeof badSt.error).toBe('string')
    expect(badSt.error!.length).toBeGreaterThan(0)
    // The good file must still be learned — one bad file doesn't sink the batch.
    expect(statuses.find(s => s.name === 'ok.md')!.state).toBe('learned')
    // Persisted lastError so the reason survives a reload.
    const h = readHashes(kb.id)
    expect(h.files['corrupt.docx'].lastError).toBeTruthy()
    expect(h.files['corrupt.docx'].textPath).toBeUndefined()
  })

  it('valid .docx with no text → state=no-text (empty), not failed', async () => {
    const dir = scratch()
    // A real, valid docx zip whose document.xml has no <w:t> runs.
    const zip = new JSZip()
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p/></w:body></w:document>')
    const buf = await zip.generateAsync({ type: 'nodebuffer' })
    const f = path.join(dir, 'blank.docx'); fs.writeFileSync(f, buf)
    const kb = createKB({ name: 'Empty' })
    addRawFiles(kb.id, [f])
    await triggerFullIngest(kb.id)
    const st = getRawFileLearnedStatus(kb.id).find(s => s.name === 'blank.docx')!
    expect(st.state).toBe('no-text')
    const h = readHashes(kb.id)
    expect(h.files['blank.docx'].empty).toBe(true)
  })
})
