/**
 * On the halo engine the host must not send the Claude Code-derived template:
 * the engine keeps its own default prompt and receives only Halo's product
 * context as an append. Other engines keep the full template unchanged.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const engine = vi.hoisted(() => ({ id: 'anthropic' as string | null }))

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  getActiveEngine: () => engine.id,
}))

import {
  appendToSystemPrompt,
  buildSystemPrompt,
  hostSystemPromptText,
  toEngineSystemPrompt,
} from '../../../../src/main/services/agent/system-prompt'

import { generatePromptInstructions } from '../../../../src/main/platform/memory'

const ctx = { workDir: '/tmp/w', modelInfo: 'test-model', today: '2026-01-02' }

describe('system prompt per engine', () => {
  beforeEach(() => {
    engine.id = 'anthropic'
  })

  it('keeps the full Halo template as a plain string on other engines', () => {
    for (const id of ['anthropic', 'codex', null]) {
      engine.id = id
      const prompt = buildSystemPrompt(ctx)
      expect(prompt.startsWith('You are Halo, an AI assistant built with Claude Code.')).toBe(true)
      expect(prompt).toContain('# Task Management')
      expect(prompt).toContain('Working directory: /tmp/w')
      expect(toEngineSystemPrompt(prompt)).toBe(prompt)
    }
  })

  it('sends only Halo context, appended to the engine default, on the halo engine', () => {
    engine.id = 'halo'
    const prompt = buildSystemPrompt({ ...ctx, toolsetIndex: '## AI Terminal\nguide' })

    expect(prompt.startsWith('# Halo\nYou are Halo,')).toBe(true)
    expect(prompt).toContain('Remote Access: Enable in Settings > Remote Access')
    expect(prompt).toContain('mcp__web-search__web_search')
    expect(prompt).toContain('# Halo directories')
    expect(prompt).toContain('Halo Digital Humans')
    expect(prompt).toContain('## AI Terminal')

    expect(prompt).not.toContain('Claude Code')
    expect(prompt).not.toContain('TodoWrite')
    expect(prompt).not.toContain('<env>')
    expect(prompt).not.toContain('2026-01-02')
    expect(prompt).not.toContain('test-model')
    expect(prompt).not.toMatch(/\{\{[A-Z_]+\}\}/)

    expect(toEngineSystemPrompt(prompt)).toEqual({ type: 'preset', preset: 'default', append: prompt })
  })

  it('ignores promptProfile on the halo engine', () => {
    engine.id = 'halo'
    expect(buildSystemPrompt({ ...ctx, promptProfile: 'official' })).toBe(buildSystemPrompt(ctx))
  })

  it.each(['anthropic', 'halo', 'codex'])('preserves standing memory context on %s without repeating it', id => {
    engine.id = id
    const memory = generatePromptInstructions('session', { owner: 'space', authorTag: 'chat#ab12' })
    const options = toEngineSystemPrompt(buildSystemPrompt(ctx))
    const prompt = appendToSystemPrompt(options, `\n\n${memory}`)
    expect(hostSystemPromptText(prompt)).toContain(memory)
    expect(hostSystemPromptText(prompt).split('Your History author tag')).toHaveLength(2)
    if (id === 'halo') expect(prompt).toMatchObject({ type: 'preset', preset: 'default' })
    else expect(typeof prompt).toBe('string')
  })

  it('omits the digital humans line when disabled', () => {
    engine.id = 'halo'
    expect(buildSystemPrompt({ ...ctx, digitalHumansEnabled: false })).not.toContain('Digital Humans')
  })
})

describe('prompt shape helpers', () => {
  const preset = { type: 'preset' as const, preset: 'default' as const, append: 'ctx' }

  it('appends to either shape without mutating the input', () => {
    expect(appendToSystemPrompt('base', '\n\nkb')).toBe('base\n\nkb')
    expect(appendToSystemPrompt(preset, '\n\nkb')).toEqual({ ...preset, append: 'ctx\n\nkb' })
    expect(preset.append).toBe('ctx')
    expect(appendToSystemPrompt(undefined, 'kb')).toBeUndefined()
  })

  it('reads the host-authored text from either shape', () => {
    expect(hostSystemPromptText('base')).toBe('base')
    expect(hostSystemPromptText(preset)).toBe('ctx')
    expect(hostSystemPromptText(undefined)).toBe('')
  })
})

describe('engine system prompt wiring', () => {
  // A raw host string assigned on the halo engine would replace the engine's
  // whole default prompt with the Halo append, and nothing else would notice.
  it('routes every session system prompt through the engine-shape helpers', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, relative } = await import('node:path')
    const root = join(__dirname, '../../../../src/main')
    // Task-specific prompts that must stay complete strings on every engine.
    const fullStringPrompts = new Set([
      'services/memory-consolidation/runner.ts',
      'services/api-validator.service.ts',
    ])
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
})
