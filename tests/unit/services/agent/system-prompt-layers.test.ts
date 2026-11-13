import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../../../src/main/services/agent/system-prompt'

const engines = ['anthropic', 'halo', 'codex', 'dsh'] as const
const baseCtx = { workDir: '/tmp/w' }

describe('shared Halo product layer', () => {
  it.each(engines)('keeps native behavior and tool manuals out of host context on %s', engineId => {
    const prompt = buildSystemPrompt({ ...baseCtx, engineId, today: '2026-01-02', modelInfo: 'test-model' })
    for (const marker of ['Claude Code', 'TodoWrite', 'AskUserQuestion', 'WebFetch', '<env>', 'Working directory:', 'test-model', '2026-01-02', '# Tone and style', 'without requiring user approval', '# Web research', 'If the user asks for help', 'General Assistance:', 'Halo Digital Humans:']) {
      expect(prompt).not.toContain(marker)
    }
    expect(prompt).toContain('Use `read_halo_doc` for Halo product guidance')
    expect(prompt).toContain('Current tools and permissions determine what you can do')
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)
    expect(prompt.length).toBeLessThan(1400)
  })

  it('uses exactly the same host text across engines with identical bindings', () => {
    const prompts = engines.map(engineId => buildSystemPrompt({ ...baseCtx, engineId,
      ownIdentity: 'app-instructions',
      toolsetIndex: '## Available capability\nfixture guide',
      knowledgeBases: [{ id: 'kb-1', name: 'PCB Survey', indexContent: '## docs' }],
    }))
    expect(new Set(prompts).size).toBe(1)
    expect(prompts[0]).toContain('## Available capability')
    expect(prompts[0]).toContain('## PCB Survey')
  })

  it('does not assume that a product feature is mounted or give a normal chat App Instructions', () => {
    const prompt = buildSystemPrompt(baseCtx)
    expect(prompt).not.toContain('Halo Digital Humans:')
    expect(prompt).not.toContain('App Instructions')
    expect(prompt).toContain("You are Halo, the AI assistant in Halo's chat.")
  })
})
