import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { openSessionWriter, readSessionTranscript, readSessionMessageThoughts } from '../../../../src/main/apps/runtime/session-store'
import { SKILL_NOTICE_TEXT } from '../../../../src/shared/skill-notice'
import type { SkillNotice } from '../../../../src/shared/types/skills'

const root = process.env.HALO_TEST_TMPDIR ?? tmpdir()

// These records contain only generic fixtures; no profile or credentials are borrowed.
describe('digital-human skill notice persistence', () => {
  it.each<SkillNotice>(['catalog-unavailable'])('keeps %s visible in paged history after a completed turn is reopened', code => {
    mkdirSync(root, { recursive: true })
    const dir = mkdtempSync(join(root, 'notice-'))
    try {
      const writer = openSessionWriter(dir, 'person', 'chat')
      writer.writeTrigger('hello')
      writer.writeEvent({ type: 'system', subtype: 'init' })
      writer.writeEvent({ type: 'system', subtype: 'skill_notice', skillNotice: code, content: '/private/ignored-name' })
      writer.writeEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Normal answer' }] } })
      writer.writeEvent({ type: 'result', subtype: 'success', result: 'Normal answer' })
      const page = readSessionTranscript(dir, 'person', 'chat', { limit: 10 })
      const reply = page.messages.find(message => message.role === 'assistant')!
      expect(reply.content).toBe('Normal answer')
      expect(reply.error).toBeUndefined()
      expect(reply.thoughts).toBeNull()
      expect(reply.thoughtsSummary?.skillNotices).toEqual([code])
      const thoughts = readSessionMessageThoughts(dir, 'person', 'chat', reply.id)
      expect(thoughts).toContainEqual(expect.objectContaining({ type: 'system', skillNotice: code, content: SKILL_NOTICE_TEXT[code] }))
      expect(JSON.stringify(page)).not.toContain('ignored-name')
      expect(JSON.stringify(thoughts)).not.toContain('/private/')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
