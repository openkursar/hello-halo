/**
 * Regression tests: the Knowledge section must reach the system prompt for BOTH
 * session kinds. A toolset-broker session always sets toolsetIndex (main chat);
 * an early return after appending the toolset guides once silently dropped the
 * Knowledge section for every chat session, so the model never saw attached
 * knowledge bases despite correct resolution upstream.
 */

import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../../../../src/main/services/agent/system-prompt'
import type { KBReference } from '../../../../src/shared/types/tlon'

const kbs: KBReference[] = [
  { id: 'kb-1', name: 'PCB Survey', indexContent: '## docs\n- survey.md — main survey' },
]

const baseCtx = { workDir: '/tmp/w', modelInfo: 'test-model' }

describe('buildSystemPrompt knowledge injection', () => {
  it('appends Knowledge for toolset-broker sessions (toolsetIndex set)', () => {
    const prompt = buildSystemPrompt({
      ...baseCtx,
      toolsetIndex: '## AI Terminal\nterminal guide',
      knowledgeBases: kbs,
    })
    expect(prompt).toContain('## AI Terminal')
    expect(prompt).toContain('# Knowledge')
    expect(prompt).toContain('## PCB Survey')
    expect(prompt).toContain('survey.md')
    // Knowledge comes after the toolset guides
    expect(prompt.indexOf('# Knowledge')).toBeGreaterThan(prompt.indexOf('## AI Terminal'))
  })

  it('appends Knowledge when toolsetIndex is an empty string (all toolsets off)', () => {
    const prompt = buildSystemPrompt({ ...baseCtx, toolsetIndex: '', knowledgeBases: kbs })
    expect(prompt).toContain('# Knowledge')
    expect(prompt).toContain('## PCB Survey')
    // Broker sessions never get the legacy static-injection guidance
    expect(prompt).not.toContain('# AI Browser (Not Enabled)')
  })

  it('appends Knowledge for legacy static-injection sessions (no toolsetIndex)', () => {
    const prompt = buildSystemPrompt({ ...baseCtx, aiBrowserEnabled: false, knowledgeBases: kbs })
    expect(prompt).toContain('# AI Browser (Not Enabled)')
    expect(prompt).toContain('# Knowledge')
    expect(prompt).toContain('## PCB Survey')
  })

  it('omits the Knowledge section when no knowledge bases are attached', () => {
    const prompt = buildSystemPrompt({ ...baseCtx, toolsetIndex: '' })
    expect(prompt).not.toContain('# Knowledge')
  })
})
