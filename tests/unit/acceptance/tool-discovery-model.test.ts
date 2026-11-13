import { describe, expect, it } from 'vitest'
import { planModelTool, replyWithModelTool } from '../../e2e/fixtures/acceptance-tool-discovery'
import type { ModelRequest } from '../../e2e/fixtures/acceptance-model'

function request(tools: string[], results: ModelRequest['toolResults'] = []): ModelRequest {
  return { sequence: 1, protocol: 'openai', body: { tools }, messages: [{ role: 'assistant', tool_calls: results.filter(result => result.id.endsWith('-search') || result.id.endsWith('-definition')).map(result => ({ id: result.id, type: 'function', function: { name: 'ToolSearch', arguments: '{}' } })) }], tools, text: '', lastUserText: '', toolResults: results }
}
const gateways = ['ToolSearch', 'CallTool']
const definition = { name: 'mcp__crm__lookup', version: 'v1', description: 'Lookup', input_schema: { type: 'object', properties: { id: { type: 'string' } } } }
const result = (id: string, tools: unknown[]) => ({ id, text: JSON.stringify({ tools }), error: false })

describe('scripted model tool discovery', () => {
  it('preserves ordinary eager calls and their inputs', () => {
    expect(planModelTool(request(['mcp__crm__lookup']), 'lookup', { id: '42' }, 'work'))
      .toEqual({ call: { id: 'work', name: 'mcp__crm__lookup', input: { id: '42' } } })
  })

  it('first requests discovery, then wraps only the exact name learned from the result', () => {
    expect(planModelTool(request(gateways), 'lookup', { id: '42' }, 'work'))
      .toEqual({ call: { id: 'work-search', name: 'ToolSearch', input: { query: 'lookup', max_results: 10 } } })
    const loaded = request(gateways, [result('work-search', [definition])])
    expect(planModelTool(loaded, 'lookup', { id: '42' }, 'work'))
      .toEqual({ call: { id: 'work', name: 'CallTool', input: { tool: definition.name, arguments: '{"id":"42"}' } } })
    expect(loaded.tools).toEqual(gateways)
  })

  it('explicitly requests a complete definition when the search reports already loaded', () => {
    const existing = result('work-search', [{ name: definition.name, version: 'v1', already_loaded: true }])
    expect(planModelTool(request(gateways, [existing]), 'lookup', {}, 'work'))
      .toEqual({ call: { id: 'work-definition', name: 'ToolSearch', input: { query: `select:${definition.name}` } } })
    expect(planModelTool(request(gateways, [existing, result('work-definition', [definition])]), 'lookup', {}, 'work'))
      .toMatchObject({ call: { name: 'CallTool', id: 'work' } })
  })

  it('does not take an unrelated result as its discovery receipt', () => {
    expect(planModelTool(request(gateways, [result('other', [definition])]), 'lookup', {}, 'work'))
      .toMatchObject({ call: { name: 'ToolSearch' } })
  })

  it.each([
    { tools: [] },
    { tools: [{ name: definition.name, version: 'v1' }] },
    { tools: [{ name: definition.name, version: 'v1', input_schema: { type: 'object' } }] },
    { tools: [definition, { ...definition, name: 'mcp__other__lookup' }] },
  ])('records missing, incomplete or ambiguous discovery as evidence instead of inventing a callable name', ({ tools }) => {
    const issues: string[] = []
    const reply = replyWithModelTool(request(gateways, [result('work-search', tools)]), 'lookup', {}, 'work', issues)
    expect(reply.tools).toBeUndefined()
    expect(issues).toHaveLength(1)
  })

  it('reuses complete prior ToolSearch definitions from the actual transcript for a new step', () => {
    const prior = request(gateways, [result('earlier-search', [definition])])
    prior.messages = [{ role: 'assistant', tool_calls: [{ id: 'earlier-search', type: 'function', function: { name: 'ToolSearch', arguments: '{}' } }] }]
    expect(planModelTool(prior, 'lookup', { id: '43' }, 'next'))
      .toEqual({ call: { id: 'next', name: 'CallTool', input: { tool: definition.name, arguments: '{"id":"43"}' } } })
  })

  it('reuses Anthropic search receipts but not a newer unmatched version summary', () => {
    const prior = request(gateways, [result('earlier-search', [definition]), result('new-search', [{ name: definition.name, version: 'v2', already_loaded: true }])])
    prior.messages = [{ role: 'assistant', content: ['earlier-search', 'new-search'].map(id => ({ type: 'tool_use', id, name: 'ToolSearch', input: {} })) }]
    expect(planModelTool(prior, 'lookup', {}, 'next')).toMatchObject({ call: { name: 'ToolSearch' } })
    prior.toolResults[1] = result('new-search', [{ name: definition.name, version: 'v1', already_loaded: true }])
    expect(planModelTool(prior, 'lookup', {}, 'next')).toMatchObject({ call: { name: 'CallTool', input: { tool: definition.name } } })
  })

  it('rejects ambiguous prior search definitions and malformed complete definitions', () => {
    for (const tools of [[definition, { ...definition, name: 'mcp__other__lookup' }], [{ ...definition, input_schema: null }]]) {
      const prior = request(gateways, [result('earlier-search', tools)])
      prior.messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'earlier-search', name: 'ToolSearch', input: {} }] }]
      expect(planModelTool(prior, 'lookup', {}, 'next')).toHaveProperty('error')
    }
  })

  it('never falls back to an invalidated current-step receipt or an unproven receipt', () => {
    const prior = request(gateways, [result('work-search', [definition]), result('later-search', [{ name: definition.name, version: 'v2', already_loaded: true }])])
    expect(planModelTool(prior, 'lookup', {}, 'work')).toEqual({ call: { id: 'work-definition', name: 'ToolSearch', input: { query: `select:${definition.name}` } } })
    prior.messages = []
    expect(planModelTool(prior, 'lookup', {}, 'work')).toEqual({ call: { id: 'work-search', name: 'ToolSearch', input: { query: 'lookup', max_results: 10 } } })
  })

  it('rejects malformed JSON and failed actual search receipts', () => {
    for (const receipt of [{ id: 'work-search', text: 'invalid JSON', error: false }, { id: 'work-search', text: 'Search unavailable', error: true }]) {
      expect(planModelTool(request(gateways, [receipt]), 'lookup', {}, 'work')).toHaveProperty('error')
    }
  })

  it('does not apply the client gateway to a vendor search tool without CallTool', () => {
    expect(planModelTool(request(['ToolSearch']), 'lookup', {}, 'work')).toHaveProperty('error')
  })
})
