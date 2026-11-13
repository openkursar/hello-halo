import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../src/main/services/agent/user-agent-settings', () => ({
  readUserAgentSettings: () => ({ digitalHumansEnabled: true }),
}))

import {
  appendToSystemPrompt,
  buildSystemPrompt,
  hostSystemPromptText,
  toEngineSystemPrompt,
} from '../../../../src/main/services/agent/system-prompt'
import { generatePromptInstructions } from '../../../../src/main/platform/memory'

const engines = ['anthropic', 'halo', 'codex', 'dsh'] as const
const ctx = { workDir: '/tmp/w' }
const runsOnHalo = 'You run in Halo. Your identity and duties come from App Instructions.'

describe('engine system prompt contract', () => {
  it.each(engines)('appends host context to the native default on %s', engineId => {
    const prompt = buildSystemPrompt({ ...ctx, engineId })
    expect(prompt.startsWith('# Halo\nYou are Halo,')).toBe(true)
    expect(toEngineSystemPrompt(prompt, engineId)).toEqual({ type: 'preset', preset: 'default', append: prompt })
    expect(toEngineSystemPrompt(prompt)).toEqual(toEngineSystemPrompt(prompt, engineId))
  })

  it.each(engines)('changes only the identity line when App Instructions own identity on %s', engineId => {
    const plain = buildSystemPrompt({ ...ctx, engineId })
    const own = buildSystemPrompt({ ...ctx, engineId, ownIdentity: 'app-instructions' })
    expect(own).not.toMatch(/^You are Halo, /m)
    expect(own).toBe(plain.replace(/^You are Halo, .*$/m, runsOnHalo))
  })

  it.each(engines)('defers to runtime identity without referencing absent App Instructions on %s', engineId => {
    const plain = buildSystemPrompt({ ...ctx, engineId })
    const own = buildSystemPrompt({ ...ctx, engineId, ownIdentity: 'runtime' })
    expect(own).toBe(plain.replace(/^You are Halo, .*$/m, runsOnHalo.split(' Your identity and duties')[0]))
    expect(own).not.toMatch(/^You are Halo, /m)
    expect(own).not.toContain('App Instructions')
  })

  it.each(engines)('preserves managed and personal skill paths on %s', engineId => {
    const prompt = buildSystemPrompt({ ...ctx, engineId, claudeConfigDir: '/custom/agent-config' })
    expect(prompt).toContain('Personal global skills: ~/.agents/skills/<skill-name>/SKILL.md')
    expect(prompt).toContain('Personal project skills: <space-path>/.agents/skills/<skill-name>/SKILL.md')
    expect(prompt).not.toContain('.claude/skills')
    expect(prompt).toContain('Store-installed and built-in skills live in the same folders')
    expect(prompt).toContain('If ToolSearch is offered instead, discover the skill-management tool before calling it.')
    expect(prompt).toContain('Agent config: /custom/agent-config')
    expect(prompt).not.toContain('/custom/agent-config/skills')
  })

  it.each(engines)('preserves standing memory exactly once on %s', engineId => {
    const memory = generatePromptInstructions('session', { owner: 'space', authorTag: 'chat#ab12' })
    const prompt = appendToSystemPrompt(toEngineSystemPrompt(buildSystemPrompt(ctx), engineId), `\n\n${memory}`)
    expect(hostSystemPromptText(prompt)).toContain(memory)
    expect(hostSystemPromptText(prompt).split('Your History author tag')).toHaveLength(2)
    expect(prompt).toMatchObject({ type: 'preset', preset: 'default' })
  })
})

describe('prompt shape helpers', () => {
  const preset = { type: 'preset' as const, preset: 'default' as const, append: 'ctx' }

  it('preserves explicit replacement strings for internal tasks', () => {
    expect(appendToSystemPrompt('complete task instructions', '\n\nkb')).toBe('complete task instructions\n\nkb')
    expect(hostSystemPromptText('complete task instructions')).toBe('complete task instructions')
  })

  it('appends without mutating the native-preset wrapper', () => {
    expect(appendToSystemPrompt(preset, '\n\nkb')).toEqual({ ...preset, append: 'ctx\n\nkb' })
    expect(preset.append).toBe('ctx')
    expect(hostSystemPromptText(preset)).toBe('ctx')
    expect(appendToSystemPrompt(undefined, 'kb')).toBeUndefined()
    expect(hostSystemPromptText(undefined)).toBe('')
  })
})

it('routes user-facing session prompts through the shared shape helpers', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join, relative } = await import('node:path')
  const root = join(__dirname, '../../../../src/main')
  const fullStringPrompts = new Set(['services/memory-consolidation/runner.ts', 'services/api-validator.service.ts'])
  const assignment = /^\s*systemPrompt\??:|\.systemPrompt\s*=[^=]/
  const wrapped = /toEngineSystemPrompt\(|appendToSystemPrompt\(/
  const offenders: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (name !== 'openai-compat-router') walk(path)
        continue
      }
      if (!name.endsWith('.ts')) continue
      const file = relative(root, path)
      if (fullStringPrompts.has(file)) continue
      readFileSync(path, 'utf-8').split('\n').forEach((line, i) => {
        if (assignment.test(line) && !wrapped.test(line)) offenders.push(`${file}:${i + 1}`)
      })
    }
  }
  walk(root)
  expect(offenders).toEqual([])
})
