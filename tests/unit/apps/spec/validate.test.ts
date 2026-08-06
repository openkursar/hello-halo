/**
 * Unit Tests: apps/spec — Validation
 *
 * Tests the Zod schema validation layer.
 * Covers: valid specs for all types, required field enforcement,
 * type-specific constraints, cross-field validation.
 */

import { describe, it, expect } from 'vitest'
import {
  validateAppSpec,
  validateAppSpecSafe,
  AppSpecValidationError
} from '../../../../src/main/apps/spec'

// ============================================
// Minimal valid specs for each type
// ============================================

const minimalMcpSpec = {
  name: 'Test MCP',
  version: '1.0',
  author: 'tester',
  description: 'A test MCP server',
  type: 'mcp',
  mcp_server: {
    command: 'npx',
    args: ['-y', '@example/mcp-server']
  }
}

const minimalSkillSpec = {
  name: 'Test Skill',
  version: '1.0',
  author: 'tester',
  description: 'A test skill',
  type: 'skill',
  // Skills follow the external SKILL.md format: content lives in
  // skill_content / skill_files, not system_prompt.
  skill_content: '# Test Skill\n\nYou are a helpful assistant.'
}

const minimalAutomationSpec = {
  name: 'Test Automation',
  version: '1.0',
  author: 'tester',
  description: 'A test automation app',
  type: 'automation',
  system_prompt: 'You are a monitoring agent.'
}

const minimalExtensionSpec = {
  name: 'Test Extension',
  version: '1.0',
  author: 'tester',
  description: 'A test extension',
  type: 'extension'
}

describe('validateAppSpec - minimal valid specs', () => {
  it('should accept minimal MCP spec', () => {
    const result = validateAppSpec(minimalMcpSpec)
    expect(result.type).toBe('mcp')
    expect(result.name).toBe('Test MCP')
    expect(result.mcp_server).toBeDefined()
    expect(result.mcp_server!.command).toBe('npx')
  })

  it('should coerce numeric and boolean env values to strings in MCP spec', () => {
    const result = validateAppSpec({
      ...minimalMcpSpec,
      mcp_server: {
        command: 'npx',
        args: ['-y', '@example/mcp-server'],
        env: { PORT: 8080, DEBUG: true, KEY: 'value' }
      }
    })
    expect(result.type).toBe('mcp')
    expect(result.mcp_server!.env).toEqual({ PORT: '8080', DEBUG: 'true', KEY: 'value' })
  })

  it('should accept MCP headers for HTTP transports', () => {
    const result = validateAppSpec({
      ...minimalMcpSpec,
      mcp_server: {
        transport: 'streamable-http',
        command: 'https://example.com/mcp',
        headers: {
          Authorization: 'Bearer token',
        },
      },
    })
    expect(result.mcp_server?.headers).toEqual({
      Authorization: 'Bearer token',
    })
  })

  it('should accept minimal Skill spec', () => {
    const result = validateAppSpec(minimalSkillSpec)
    expect(result.type).toBe('skill')
    expect((result as { skill_content?: string }).skill_content).toContain('You are a helpful assistant.')
  })

  it('should accept minimal Automation spec', () => {
    const result = validateAppSpec(minimalAutomationSpec)
    expect(result.type).toBe('automation')
    expect(result.system_prompt).toBe('You are a monitoring agent.')
  })

  it('preserves the per-app requires.mcps[].enabled flag through validation', () => {
    const result = validateAppSpec({
      ...minimalAutomationSpec,
      requires: { mcps: [{ id: 'postgres', enabled: false }, { id: 'jira' }] },
    })
    const mcps = (result as { requires?: { mcps?: unknown } }).requires?.mcps
    expect(mcps).toEqual([{ id: 'postgres', enabled: false }, { id: 'jira' }])
  })

  it('should accept minimal Extension spec', () => {
    const result = validateAppSpec(minimalExtensionSpec)
    expect(result.type).toBe('extension')
  })

  it('should set spec_version to "1" by default', () => {
    const result = validateAppSpec(minimalSkillSpec)
    expect(result.spec_version).toBe('1')
  })
})

describe('validateAppSpec - required fields', () => {
  it('should reject missing name', () => {
    const spec = { ...minimalSkillSpec, name: undefined }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should reject missing version', () => {
    const spec = { ...minimalSkillSpec, version: undefined }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should reject missing author (non-skill types)', () => {
    // Author is optional for skills (SKILL.md has no author field) but stays
    // required for the other types.
    const spec = { ...minimalAutomationSpec, author: undefined }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
    expect(validateAppSpec({ ...minimalSkillSpec, author: undefined }).type).toBe('skill')
  })

  it('should reject missing description', () => {
    const spec = { ...minimalSkillSpec, description: undefined }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should reject missing type', () => {
    const spec = { ...minimalSkillSpec, type: undefined }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should reject invalid type value', () => {
    const spec = { ...minimalSkillSpec, type: 'invalid' }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should reject empty name', () => {
    const spec = { ...minimalSkillSpec, name: '' }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should reject empty name after trim', () => {
    const spec = { ...minimalSkillSpec, name: '   ' }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })
})

describe('validateAppSpec - type-specific constraints', () => {
  it('should reject automation without system_prompt', () => {
    const spec = { ...minimalAutomationSpec, system_prompt: undefined }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
    try {
      validateAppSpec(spec)
    } catch (err) {
      expect((err as AppSpecValidationError).issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'system_prompt' })
        ])
      )
    }
  })

  it('should accept a skill without system_prompt (SKILL.md model)', () => {
    const result = validateAppSpec(minimalSkillSpec)
    expect(result.system_prompt).toBeUndefined()
  })

  it('should reject MCP without mcp_server', () => {
    const spec = { ...minimalMcpSpec, mcp_server: undefined }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should strip mcp_server on non-MCP type', () => {
    // The discriminated-union schema strips fields that do not belong to the
    // declared type instead of rejecting the spec.
    const result = validateAppSpec({
      ...minimalSkillSpec,
      mcp_server: { command: 'npx' }
    })
    expect(result.mcp_server).toBeUndefined()
  })

  it('should strip subscriptions on non-automation type', () => {
    const result = validateAppSpec({
      ...minimalSkillSpec,
      subscriptions: [{
        source: { type: 'schedule' as const, config: { every: '30m' } }
      }]
    })
    expect(result.subscriptions).toBeUndefined()
  })

  it('should strip memory_schema on non-automation type', () => {
    const result = validateAppSpec({
      ...minimalSkillSpec,
      memory_schema: { price: { type: 'number' } }
    })
    expect(result.memory_schema).toBeUndefined()
  })

  it('should allow extension without system_prompt', () => {
    const result = validateAppSpec(minimalExtensionSpec)
    expect(result.system_prompt).toBeUndefined()
  })
})

describe('validateAppSpec - subscription validation', () => {
  it('should accept valid schedule subscription', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [{
        source: {
          type: 'schedule' as const,
          config: { every: '30m' }
        }
      }]
    }
    const result = validateAppSpec(spec)
    expect(result.subscriptions).toHaveLength(1)
    expect(result.subscriptions![0].source.type).toBe('schedule')
  })

  it('should accept schedule with cron', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [{
        source: {
          type: 'schedule' as const,
          config: { cron: '0 8 * * *' }
        }
      }]
    }
    const result = validateAppSpec(spec)
    expect(result.subscriptions![0].source.config).toEqual({ cron: '0 8 * * *' })
  })

  it('should reject schedule without every or cron', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [{
        source: {
          type: 'schedule' as const,
          config: {}
        }
      }]
    }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should accept valid webpage subscription', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [{
        source: {
          type: 'webpage' as const,
          config: { watch: 'price-element' }
        },
        config_key: 'product_url'
      }],
      config_schema: [{
        key: 'product_url',
        label: 'Product URL',
        type: 'url' as const
      }]
    }
    const result = validateAppSpec(spec)
    expect(result.subscriptions![0].source.type).toBe('webpage')
    expect(result.subscriptions![0].config_key).toBe('product_url')
  })

  it('should reject config_key that references non-existent config field', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [{
        source: {
          type: 'webpage' as const,
          config: { watch: 'price-element' }
        },
        config_key: 'nonexistent'
      }],
      config_schema: [{
        key: 'product_url',
        label: 'Product URL',
        type: 'url' as const
      }]
    }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should accept valid frequency definition', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [{
        source: {
          type: 'schedule' as const,
          config: { every: '30m' }
        },
        frequency: {
          default: '30m',
          min: '10m',
          max: '6h'
        }
      }]
    }
    const result = validateAppSpec(spec)
    expect(result.subscriptions![0].frequency).toEqual({
      default: '30m',
      min: '10m',
      max: '6h'
    })
  })

  it('should reject invalid duration format in frequency', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [{
        source: {
          type: 'schedule' as const,
          config: { every: '30m' }
        },
        frequency: {
          default: 'invalid'
        }
      }]
    }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should accept multiple subscription types', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [
        { id: 'timer', source: { type: 'schedule' as const, config: { every: '1h' } } },
        { id: 'files', source: { type: 'file' as const, config: { pattern: 'src/**' } } },
        { id: 'hook', source: { type: 'webhook' as const, config: { path: 'github' } } }
      ]
    }
    const result = validateAppSpec(spec)
    expect(result.subscriptions).toHaveLength(3)
  })

  it('should reject duplicate subscription IDs', () => {
    const spec = {
      ...minimalAutomationSpec,
      subscriptions: [
        { id: 'same', source: { type: 'schedule' as const, config: { every: '1h' } } },
        { id: 'same', source: { type: 'file' as const, config: { pattern: 'src/**' } } }
      ]
    }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })
})

describe('validateAppSpec - config_schema validation', () => {
  it('should accept valid config_schema', () => {
    const spec = {
      ...minimalAutomationSpec,
      config_schema: [
        { key: 'url', label: 'Product URL', type: 'url', required: true },
        { key: 'price', label: 'Target Price', type: 'number', default: 100 },
        {
          key: 'format', label: 'Output Format', type: 'select',
          options: [
            { label: 'Brief', value: 'brief' },
            { label: 'Detailed', value: 'detailed' }
          ]
        }
      ]
    }
    const result = validateAppSpec(spec)
    expect(result.config_schema).toHaveLength(3)
  })

  it('should reject select type without options', () => {
    const spec = {
      ...minimalAutomationSpec,
      config_schema: [
        { key: 'format', label: 'Format', type: 'select' }
      ]
    }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should accept select type with options', () => {
    const spec = {
      ...minimalAutomationSpec,
      config_schema: [
        {
          key: 'format', label: 'Format', type: 'select',
          options: [{ label: 'A', value: 'a' }]
        }
      ]
    }
    const result = validateAppSpec(spec)
    expect(result.config_schema![0].options).toHaveLength(1)
  })
})

describe('validateAppSpec - filter rules', () => {
  it('should accept valid filter rules', () => {
    const spec = {
      ...minimalAutomationSpec,
      filters: [
        { field: 'price_change_percent', op: 'gt', value: 5 },
        { field: 'category', op: 'eq', value: 'electronics' }
      ]
    }
    const result = validateAppSpec(spec)
    expect(result.filters).toHaveLength(2)
  })

  it('should reject invalid filter operator', () => {
    const spec = {
      ...minimalAutomationSpec,
      filters: [
        { field: 'price', op: 'invalid', value: 5 }
      ]
    }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })

  it('should reject filter without field', () => {
    const spec = {
      ...minimalAutomationSpec,
      filters: [
        { field: '', op: 'gt', value: 5 }
      ]
    }
    expect(() => validateAppSpec(spec)).toThrow(AppSpecValidationError)
  })
})

describe('validateAppSpec - requires block', () => {
  it('should accept requires with mcps and skills', () => {
    const spec = {
      ...minimalAutomationSpec,
      requires: {
        mcps: [
          { id: 'ai-browser', reason: 'For web access' }
        ],
        skills: ['price-analysis']
      }
    }
    const result = validateAppSpec(spec)
    expect(result.requires!.mcps).toHaveLength(1)
    expect(result.requires!.skills).toEqual(['price-analysis'])
  })

  it('should accept empty requires', () => {
    const spec = {
      ...minimalAutomationSpec,
      requires: {}
    }
    const result = validateAppSpec(spec)
    expect(result.requires).toBeDefined()
  })
})

describe('validateAppSpec - memory_schema', () => {
  it('should accept valid memory_schema', () => {
    const spec = {
      ...minimalAutomationSpec,
      memory_schema: {
        price_history: { type: 'array', description: 'Historical prices' },
        last_low_date: { type: 'date' },
        purchase_decision: { type: 'string', description: 'Buy/wait decision' }
      }
    }
    const result = validateAppSpec(spec)
    expect(Object.keys(result.memory_schema!)).toHaveLength(3)
  })
})

describe('validateAppSpec - escalation config', () => {
  it('should accept escalation config', () => {
    const spec = {
      ...minimalAutomationSpec,
      escalation: {
        enabled: true,
        timeout_hours: 48
      }
    }
    const result = validateAppSpec(spec)
    expect(result.escalation!.timeout_hours).toBe(48)
  })
})

describe('validateAppSpecSafe - safe validation', () => {
  it('should return success for valid spec', () => {
    const result = validateAppSpecSafe(minimalSkillSpec)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe('Test Skill')
    }
  })

  it('should return error for invalid spec', () => {
    const result = validateAppSpecSafe({ name: 'x' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0)
    }
  })
})

describe('validateAppSpec - error messages', () => {
  it('should provide clear error message for missing required field', () => {
    const spec = { type: 'skill' }
    try {
      validateAppSpec(spec)
      expect.fail('Should have thrown')
    } catch (err) {
      const error = err as AppSpecValidationError
      expect(error.code).toBe('APP_SPEC_VALIDATION_ERROR')
      expect(error.issues.length).toBeGreaterThan(0)
      // Should mention at least one missing field
      const paths = error.issues.map(i => i.path)
      expect(paths).toEqual(expect.arrayContaining([
        expect.stringMatching(/name|version|author|description/)
      ]))
    }
  })

  it('should provide clear error message for wrong type', () => {
    const spec = { ...minimalSkillSpec, type: 'invalid' }
    try {
      validateAppSpec(spec)
      expect.fail('Should have thrown')
    } catch (err) {
      const error = err as AppSpecValidationError
      const typeIssue = error.issues.find(i => i.path === 'type')
      expect(typeIssue).toBeDefined()
      expect(typeIssue!.message).toContain('mcp')
    }
  })
})
