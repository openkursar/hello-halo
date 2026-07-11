/**
 * Unit Tests: apps/spec — End-to-End Integration
 *
 * Tests the full YAML-to-validated-AppSpec pipeline.
 * Includes the "e-commerce low price hunter" example from the architecture doc.
 */

import { describe, it, expect } from 'vitest'
import {
  parseAndValidateAppSpec,
  parseAppSpec,
  validateAppSpec,
  AppSpecParseError,
  AppSpecValidationError
} from '../../../../src/main/apps/spec'

// ============================================
// Full "e-commerce low price hunter" example from architecture doc
// ============================================

const ecommercePriceHunterYaml = `
name: "e-commerce low price hunter"
version: "1.0.0"
author: fly
description: "Monitor e-commerce product prices and alert on significant drops"
type: automation

system_prompt: |
  You are a professional price comparison Agent.
  Check JD.com self-operated/third-party stores/Billion Subsidy/Plus member prices/
  stacked coupon final prices, exclude pre-orders and overseas purchases,
  compare 30-day price trends to determine if at a low point.

  When you detect a price drop meeting the user's threshold, immediately
  report via report_to_user(type="milestone").

  Always report completion via report_to_user(type="run_complete").

requires:
  mcps:
    - id: ai-browser
      reason: "Used for web page interaction and price extraction"
  skills:
    - price-analysis

subscriptions:
  - id: price-check
    source:
      type: webpage
      config:
        watch: "price-element"
    frequency:
      default: "30m"
      min: "10m"
      max: "6h"
    config_key: "product_url"

filters:
  - field: price_change_percent
    op: gt
    value: 5

memory_schema:
  price_history:
    type: array
    description: "Historical price records with timestamps"
  last_low_date:
    type: date
    description: "Date of last detected low price"
  purchase_decision:
    type: string
    description: "Buy/wait decision and reasoning"

config_schema:
  - key: product_url
    label: "Product Link"
    type: url
    required: true
    placeholder: "https://item.jd.com/..."
  - key: target_price
    label: "Target Price"
    type: number
    required: true
    description: "Alert when price drops below this value"

output:
  notify:
    system: true
  format: "Current lowest price {price}, {trend_analysis}"

permissions:
  - browser.navigate
  - notification.send

escalation:
  enabled: true
  timeout_hours: 24
`

describe('parseAndValidateAppSpec - e-commerce low price hunter', () => {
  it('should fully parse and validate the architecture doc example', () => {
    const spec = parseAndValidateAppSpec(ecommercePriceHunterYaml)

    // Basic fields
    expect(spec.name).toBe('e-commerce low price hunter')
    expect(spec.version).toBe('1.0.0')
    expect(spec.author).toBe('fly')
    expect(spec.type).toBe('automation')
    expect(spec.spec_version).toBe('1')

    // System prompt
    expect(spec.system_prompt).toContain('price comparison Agent')
    expect(spec.system_prompt).toContain('report_to_user')

    // Requires
    expect(spec.requires).toBeDefined()
    expect(spec.requires!.mcps).toHaveLength(1)
    expect(spec.requires!.mcps![0].id).toBe('ai-browser')
    expect(spec.requires!.mcps![0].reason).toContain('web page')
    expect(spec.requires!.skills).toEqual(['price-analysis'])

    // Subscriptions
    expect(spec.subscriptions).toHaveLength(1)
    const sub = spec.subscriptions![0]
    expect(sub.id).toBe('price-check')
    expect(sub.source.type).toBe('webpage')
    if (sub.source.type === 'webpage') {
      expect(sub.source.config.watch).toBe('price-element')
    }
    expect(sub.frequency).toEqual({
      default: '30m',
      min: '10m',
      max: '6h'
    })
    expect(sub.config_key).toBe('product_url')

    // Filters
    expect(spec.filters).toHaveLength(1)
    expect(spec.filters![0]).toEqual({
      field: 'price_change_percent',
      op: 'gt',
      value: 5
    })

    // Memory schema
    expect(spec.memory_schema).toBeDefined()
    expect(spec.memory_schema!.price_history.type).toBe('array')
    expect(spec.memory_schema!.last_low_date.type).toBe('date')
    expect(spec.memory_schema!.purchase_decision.type).toBe('string')

    // Config schema
    expect(spec.config_schema).toHaveLength(2)
    expect(spec.config_schema![0].key).toBe('product_url')
    expect(spec.config_schema![0].type).toBe('url')
    expect(spec.config_schema![0].required).toBe(true)
    expect(spec.config_schema![1].key).toBe('target_price')
    expect(spec.config_schema![1].type).toBe('number')

    // Output
    expect(spec.output).toEqual({
      notify: { system: true },
      format: 'Current lowest price {price}, {trend_analysis}'
    })

    // Permissions
    expect(spec.permissions).toEqual(['browser.navigate', 'notification.send'])

    // Escalation
    expect(spec.escalation).toEqual({
      enabled: true,
      timeout_hours: 24
    })
  })
})

// ============================================
// Full "HN Daily" example from product doc
// ============================================

const hnDailyYaml = `
name: "HN Daily"
author: fly
type: automation
version: "1.0"
description: "Send Hacker News top stories digest every morning at 8am"

subscriptions:
  - source:
      type: schedule
      config:
        cron: "0 8 * * *"

config_schema:
  - key: email
    type: string
    label: "Receiving Email"
    required: true

system_prompt: |
  You are an HN information assistant. On each trigger:
  1. Open https://news.ycombinator.com and get today's Top 10
  2. Write a concise summary in Chinese (2-3 sentences each)
  3. Send via email MCP to the configured email
  4. Report completion via report_to_user
`

describe('parseAndValidateAppSpec - HN Daily example', () => {
  it('should fully parse and validate the HN Daily spec', () => {
    const spec = parseAndValidateAppSpec(hnDailyYaml)

    expect(spec.name).toBe('HN Daily')
    expect(spec.type).toBe('automation')
    expect(spec.subscriptions).toHaveLength(1)
    expect(spec.subscriptions![0].source.type).toBe('schedule')
    if (spec.subscriptions![0].source.type === 'schedule') {
      expect(spec.subscriptions![0].source.config.cron).toBe('0 8 * * *')
    }
    expect(spec.config_schema).toHaveLength(1)
    expect(spec.config_schema![0].key).toBe('email')
    expect(spec.config_schema![0].required).toBe(true)
    expect(spec.system_prompt).toContain('HN information assistant')
  })
})

// ============================================
// Full MCP app example
// ============================================

const postgresMcpYaml = `
name: "PostgreSQL MCP"
version: "0.3.1"
author: community
description: "PostgreSQL database access for AI"
type: mcp

mcp_server:
  command: npx
  args:
    - "-y"
    - "@modelcontextprotocol/server-postgres"
  env:
    DATABASE_URL: "{{config.database_url}}"

config_schema:
  - key: database_url
    label: "Database URL"
    type: url
    required: true
    placeholder: "postgresql://user:pass@localhost/db"
`

const remoteHttpMcpYaml = `
name: "Remote HTTP MCP"
version: "1.2.0"
author: community
description: "Remote MCP server over HTTP"
type: mcp

mcp_server:
  transport: streamable-http
  command: https://example.com/mcp
  headers:
    Authorization: Bearer test-token
`

describe('parseAndValidateAppSpec - MCP app example', () => {
  it('should fully parse and validate the PostgreSQL MCP spec', () => {
    const spec = parseAndValidateAppSpec(postgresMcpYaml)

    expect(spec.name).toBe('PostgreSQL MCP')
    expect(spec.type).toBe('mcp')
    expect(spec.mcp_server).toBeDefined()
    expect(spec.mcp_server!.command).toBe('npx')
    expect(spec.mcp_server!.args).toEqual(['-y', '@modelcontextprotocol/server-postgres'])
    expect(spec.mcp_server!.env).toEqual({ DATABASE_URL: '{{config.database_url}}' })
    expect(spec.config_schema).toHaveLength(1)
  })

  it('should parse MCP headers for remote transports', () => {
    const spec = parseAndValidateAppSpec(remoteHttpMcpYaml)

    expect(spec.type).toBe('mcp')
    expect(spec.mcp_server?.transport).toBe('streamable-http')
    expect(spec.mcp_server?.command).toBe('https://example.com/mcp')
    expect(spec.mcp_server?.headers).toEqual({
      Authorization: 'Bearer test-token',
    })
  })
})

// ============================================
// Backward compatibility: old-style YAML
// ============================================

const oldStyleYaml = `
name: "Legacy App"
version: "1.0"
author: legacy
description: "Uses old field names"
type: automation

system_prompt: "Do something"

required_mcps:
  - ai-browser
required_skills:
  - analysis

inputs:
  - key: url
    label: URL
    type: url
    required: true

subscriptions:
  - type: webpage
    config:
      watch: element
    input: url
`

describe('parseAndValidateAppSpec - backward compatibility', () => {
  it('should handle old-style required_mcps, required_skills, inputs, and subscription shorthand', () => {
    const spec = parseAndValidateAppSpec(oldStyleYaml)

    // required_mcps normalized to requires.mcps
    expect(spec.requires).toBeDefined()
    expect(spec.requires!.mcps).toEqual([{ id: 'ai-browser' }])
    expect(spec.requires!.skills).toEqual(['analysis'])

    // inputs normalized to config_schema
    expect(spec.config_schema).toHaveLength(1)
    expect(spec.config_schema![0].key).toBe('url')

    // subscription shorthand + input alias
    expect(spec.subscriptions).toHaveLength(1)
    expect(spec.subscriptions![0].source.type).toBe('webpage')
    expect(spec.subscriptions![0].config_key).toBe('url')
  })
})

// ============================================
// Alternate requires format from product direction doc
// ============================================

const altRequiresYaml = `
name: "Alt Requires"
version: "1.0"
author: tester
description: "Uses requires.mcp shorthand"
type: automation
system_prompt: "test"

requires:
  mcp:
    - id: ai-browser
      reason: "For web access"
  skills:
    - price-analysis
`

describe('parseAndValidateAppSpec - alternative requires format', () => {
  it('should normalize requires.mcp (singular) to requires.mcps (plural)', () => {
    const spec = parseAndValidateAppSpec(altRequiresYaml)
    expect(spec.requires!.mcps).toEqual([
      { id: 'ai-browser', reason: 'For web access' }
    ])
    expect(spec.requires!.skills).toEqual(['price-analysis'])
  })
})

describe('parseAndValidateAppSpec - store metadata and structured skill deps', () => {
  it('should accept store metadata and structured skill dependency objects', () => {
    const yaml = `
name: "Store Example"
version: "1.2.3"
author: "tester"
description: "Spec with store metadata and structured skill deps"
type: automation
system_prompt: "run"
requires:
  skills:
    - id: price-analysis
      reason: "Use shared analysis logic"
      bundled: true
store:
  slug: "a"
  category: "shopping"
  tags: ["price", "automation"]
  registry_id: "official"
`
    const spec = parseAndValidateAppSpec(yaml)
    expect(spec.store?.slug).toBe('a')
    expect(spec.store?.registry_id).toBe('official')
    expect(spec.requires?.skills).toEqual([
      { id: 'price-analysis', reason: 'Use shared analysis logic', bundled: true },
    ])
  })

  it('should reject invalid store slug format', () => {
    const yaml = `
name: "Bad Store Slug"
version: "1.0.0"
author: "tester"
description: "Invalid slug"
type: automation
system_prompt: "run"
store:
  slug: "-bad-slug"
`
    expect(() => parseAndValidateAppSpec(yaml)).toThrow(AppSpecValidationError)
  })
})

// ============================================
// Two-step parse + validate workflow
// ============================================

describe('two-step: parseAppSpec + validateAppSpec', () => {
  it('should work identically to parseAndValidateAppSpec', () => {
    const parsed = parseAppSpec(ecommercePriceHunterYaml)
    const spec = validateAppSpec(parsed)
    const oneStep = parseAndValidateAppSpec(ecommercePriceHunterYaml)

    // Deep equality
    expect(spec).toEqual(oneStep)
  })
})

// ============================================
// Error path: parse error then validation error
// ============================================

describe('error paths', () => {
  it('should throw AppSpecParseError for invalid YAML', () => {
    expect(() => parseAndValidateAppSpec('{')).toThrow(AppSpecParseError)
  })

  it('should throw AppSpecValidationError for valid YAML but invalid spec', () => {
    const yaml = `
name: incomplete
type: automation
`
    expect(() => parseAndValidateAppSpec(yaml)).toThrow(AppSpecValidationError)
  })

  it('should have correct error codes', () => {
    try {
      parseAndValidateAppSpec('{')
    } catch (err) {
      expect((err as AppSpecParseError).code).toBe('APP_SPEC_PARSE_ERROR')
    }

    try {
      parseAndValidateAppSpec('name: x\ntype: automation\n')
    } catch (err) {
      expect((err as AppSpecValidationError).code).toBe('APP_SPEC_VALIDATION_ERROR')
    }
  })
})

// ============================================
// Skill app with all optional fields
// ============================================

const fullSkillYaml = `
name: "Code Review Expert"
version: "2.1.0"
author: "halo-official"
description: "Expert code review with security and performance analysis"
type: skill
icon: "code-review"

system_prompt: |
  You are a senior code reviewer. Focus on:
  - Security vulnerabilities
  - Performance bottlenecks
  - Code style and maintainability
  Review thoroughly and provide actionable suggestions.

requires:
  mcps:
    - id: git-mcp
      reason: "Access git history and diffs"

config_schema:
  - key: language
    label: "Primary Language"
    type: select
    options:
      - label: TypeScript
        value: typescript
      - label: Python
        value: python
      - label: Go
        value: go

permissions:
  - filesystem.read

output:
  format: "Review for {file}: {summary}"
`

describe('parseAndValidateAppSpec - full skill example', () => {
  it('should parse all optional fields for a skill app', () => {
    const spec = parseAndValidateAppSpec(fullSkillYaml)

    expect(spec.name).toBe('Code Review Expert')
    expect(spec.type).toBe('skill')
    expect(spec.icon).toBe('code-review')
    expect(spec.requires!.mcps![0].id).toBe('git-mcp')
    expect(spec.config_schema).toHaveLength(1)
    expect(spec.config_schema![0].type).toBe('select')
    expect(spec.config_schema![0].options).toHaveLength(3)
    expect(spec.permissions).toEqual(['filesystem.read'])
    // `output` belongs to automation specs only — the skill schema strips it
    // (skills follow the external SKILL.md format).
    expect(spec.output).toBeUndefined()
  })
})

// ============================================
// Extension app (minimal)
// ============================================

const extensionYaml = `
name: "Dark Theme"
version: "1.0"
author: "themes-community"
description: "Dark color theme for Halo"
type: extension
icon: "moon"
`

describe('parseAndValidateAppSpec - extension app', () => {
  it('should accept a minimal extension app', () => {
    const spec = parseAndValidateAppSpec(extensionYaml)
    expect(spec.type).toBe('extension')
    expect(spec.icon).toBe('moon')
    expect(spec.system_prompt).toBeUndefined()
    expect(spec.subscriptions).toBeUndefined()
  })
})

// ============================================
// Automation with multiple subscription source types
// ============================================

const multiSubYaml = `
name: "Multi Source Monitor"
version: "1.0"
author: tester
description: "Monitors multiple sources"
type: automation
system_prompt: "Monitor and report changes"

subscriptions:
  - id: timer
    source:
      type: schedule
      config:
        every: "1h"
  - id: file-watch
    source:
      type: file
      config:
        pattern: "src/**/*.ts"
        path: "/home/user/project"
  - id: hook
    source:
      type: webhook
      config:
        path: "github-pr"
        secret: "webhook-secret-123"
  - id: rss-feed
    source:
      type: rss
      config:
        url: "https://example.com/feed.xml"
  - id: custom-source
    source:
      type: custom
      config:
        provider: "custom-provider"
        api_key: "xxx"
`

describe('parseAndValidateAppSpec - multiple subscription types', () => {
  it('should accept all subscription source types', () => {
    const spec = parseAndValidateAppSpec(multiSubYaml)
    expect(spec.subscriptions).toHaveLength(5)

    const types = spec.subscriptions!.map(s => s.source.type)
    expect(types).toEqual(['schedule', 'file', 'webhook', 'rss', 'custom'])

    // Verify custom source config is passthrough
    const customSub = spec.subscriptions![4]
    if (customSub.source.type === 'custom') {
      expect(customSub.source.config).toEqual({
        provider: 'custom-provider',
        api_key: 'xxx'
      })
    }
  })
})
