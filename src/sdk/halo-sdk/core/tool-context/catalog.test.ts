import { describe, expect, it } from 'vitest';
import { createToolCatalog } from './catalog.js';
import type { Tool } from '../../types/tool.js';

function tool(name: string, description = ''): Tool {
  return { name: `mcp__crm__${name}`, mcpSource: { server: 'crm', name }, description,
    inputSchema: { type: 'object', properties: { customerId: { type: 'string' } } },
    permissionLevel: 'none', execute: async () => ({ content: '', isError: false }) };
}
const policy = { services: { crm: { identity: 'crm', loading: 'deferred' as const, summary: 'Customer records' } } };

describe('local tool search', () => {
  it('indexes identifier words and camel-case parameter names', () => {
    const catalog = createToolCatalog([tool('get_orders'), tool('getHTTPStatus')], policy);
    expect(catalog.search('order').map(item => item.originalName)).toEqual(['get_orders']);
    expect(catalog.search('HTTP status').map(item => item.originalName)).toEqual(['getHTTPStatus']);
    expect(catalog.search('customer id')).toHaveLength(2);
  });

  it('ranks exact names above purpose matches and keeps equal scores stable', () => {
    const catalog = createToolCatalog([tool('z', '查客户订单'), tool('a', '查客户订单'), tool('lookup', '查客户订单')], policy);
    expect(catalog.search('客户订单').map(item => item.originalName)).toEqual(['a', 'lookup', 'z']);
    expect(catalog.search('lookup')[0].originalName).toBe('lookup');
    expect(catalog.search('select:mcp__crm__z,mcp__crm__a').map(item => item.originalName)).toEqual(['a', 'z']);
    expect(catalog.search('客户订单', 'disabled-service')).toEqual([]);
  });
});
