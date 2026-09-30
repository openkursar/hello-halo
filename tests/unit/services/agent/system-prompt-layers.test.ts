/**
 * An engine whose runtime writes its own tool guidance (dsh) gets Halo's
 * layers only — identity, behavior, environment. Sending it Claude Code's
 * template would tell the model it is "built with Claude Code" and point it at
 * TodoWrite, AskUserQuestion and Task, names its runtime never registered.
 *
 * Claude Code, Codex and the halo engine are covered by
 * system-prompt-engine.test.ts and must not change.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ id: 'dsh' as string | null }))

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  getActiveEngine: () => engine.id,
}))

import { buildSystemPrompt } from '../../../../src/main/services/agent/system-prompt'

const baseCtx = { workDir: '/tmp/w', modelInfo: 'test-model', promptProfile: 'halo' as const }

/** What only Halo can tell the model, whichever runtime answers. */
const IDENTITY_MARKERS = [
  'You are Halo',
  "inform them of Halo's capabilities",
  '# Tone and style',
  '# Professional objectivity',
  '# Output efficiency',
  '# Halo Directory Structure',
  'Working directory: /tmp/w',
]

/** Tool names that belong to Claude Code's registrations, not to every engine. */
const CC_TOOL_MARKERS = ['TodoWrite', 'AskUserQuestion', 'subagent_type=Explore']

describe('buildSystemPrompt on an engine with its own agent guidance', () => {
  beforeEach(() => {
    engine.id = 'dsh'
  })

  it('withholds Claude Code tool guidance', () => {
    const prompt = buildSystemPrompt(baseCtx)
    for (const marker of CC_TOOL_MARKERS) {
      expect(prompt, `leaked "${marker}"`).not.toContain(marker)
    }
    expect(prompt).not.toContain('without requiring user approval')
  })

  it('keeps identity and environment', () => {
    const prompt = buildSystemPrompt(baseCtx)
    for (const marker of IDENTITY_MARKERS) {
      expect(prompt, `missing "${marker}"`).toContain(marker)
    }
  })

  it('never tells the model it is Claude Code', () => {
    expect(buildSystemPrompt(baseCtx)).not.toContain('Claude Code')
  })

  it('carries the session bindings', () => {
    // Knowledge bases and optional toolsets are Halo's alone to declare; no
    // runtime can discover them, so they must survive the narrower layering.
    const prompt = buildSystemPrompt({
      ...baseCtx,
      toolsetIndex: '## AI Terminal\nterminal guide',
      knowledgeBases: [{ id: 'kb-1', name: 'PCB Survey', indexContent: '## docs' }],
    })
    expect(prompt).toContain('## AI Terminal')
    expect(prompt).toContain('# Knowledge')
    expect(prompt).toContain('## PCB Survey')
  })

  it('applies the profile choice', () => {
    expect(buildSystemPrompt(baseCtx)).toContain('# Web Research')
    expect(buildSystemPrompt({ ...baseCtx, promptProfile: 'official' })).not.toContain('# Web Research')
  })

  it('leaves no placeholder unresolved', () => {
    expect(buildSystemPrompt(baseCtx)).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('leaves the Claude Code prompt untouched', () => {
    engine.id = 'anthropic'
    const prompt = buildSystemPrompt(baseCtx)
    expect(prompt.startsWith('You are Halo, an AI assistant built with Claude Code.')).toBe(true)
    for (const marker of CC_TOOL_MARKERS) expect(prompt).toContain(marker)
  })
})
