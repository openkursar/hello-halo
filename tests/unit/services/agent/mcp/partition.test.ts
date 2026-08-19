/**
 * Unit test: services/agent/mcp/partition — the one reading of Halo's stored
 * MCP records every out-of-process engine shares.
 *
 * Getting a record's shape wrong here is silent in both directions: an endpoint
 * mistaken for an executable becomes an ENOENT inside a child process, and an
 * in-process server mistaken for an external one becomes a spawn of a command
 * that does not exist. Neither reaches the user as anything but a missing tool.
 */

import { describe, expect, it } from 'vitest'
import {
  bearerTokenEnvVar,
  normalizeExternalMcpServer,
  partitionMcpServers,
} from '../../../../../src/main/services/agent/mcp/partition'

const sdkServer = {
  type: 'sdk',
  instance: { listTools: () => [], callTool: async () => undefined },
}

describe('partitionMcpServers', () => {
  it('separates in-process servers from the ones a child can be pointed at', () => {
    const { sdk, external, unusable } = partitionMcpServers({
      'ai-browser': sdkServer,
      filesystem: { command: 'npx', args: ['-y', 'fs-server'] },
    })

    expect(Object.keys(sdk)).toEqual(['ai-browser'])
    expect(Object.keys(external)).toEqual(['filesystem'])
    expect(unusable).toEqual([])
  })

  it('reports a record that describes nothing reachable instead of dropping it', () => {
    // The user installed this server and expects its tools. Losing the name
    // here would leave no evidence anywhere that it was skipped.
    expect(partitionMcpServers({ broken: { env: { A: '1' } } }).unusable).toEqual(['broken'])
  })

  it('treats a `type: sdk` record with no callable instance as unusable', () => {
    expect(partitionMcpServers({ half: { type: 'sdk', instance: {} } }).unusable).toEqual(['half'])
  })

  it('accepts an absent option', () => {
    expect(partitionMcpServers(undefined)).toEqual({ sdk: {}, external: {}, unusable: [] })
  })
})

describe('normalizeExternalMcpServer', () => {
  it('reads a spawn record with its full invocation', () => {
    expect(
      normalizeExternalMcpServer({
        command: 'node',
        args: ['server.js'],
        cwd: '/tmp/project',
        env: { TOKEN: 'secret', COUNT: 1 },
      }),
    ).toEqual({
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      cwd: '/tmp/project',
      // Coerced: env values arrive from user config and a number here would be
      // rejected by every child-process API downstream.
      env: { TOKEN: 'secret', COUNT: '1' },
    })
  })

  it('defaults a spawn record to no arguments and an empty environment', () => {
    expect(normalizeExternalMcpServer({ command: 'server' })).toEqual({
      transport: 'stdio',
      command: 'server',
      args: [],
      env: {},
    })
  })

  it('reads an endpoint stored in `command` as a URL, not an executable', () => {
    // Halo's remote-transport records keep the endpoint in `command`. Reading
    // that as a program name spawns nothing and fails inside the child.
    expect(normalizeExternalMcpServer({ command: 'https://example.com/mcp' })).toEqual({
      transport: 'http',
      url: 'https://example.com/mcp',
      headers: {},
    })
  })

  it('keeps SSE distinct from streamable HTTP', () => {
    expect(normalizeExternalMcpServer({ type: 'sse', url: 'https://example.com/sse' })).toEqual({
      transport: 'sse',
      url: 'https://example.com/sse',
      headers: {},
    })
  })

  it('returns null for a record with neither a command nor a URL', () => {
    expect(normalizeExternalMcpServer({ env: { A: '1' } })).toBeNull()
    expect(normalizeExternalMcpServer({ command: '   ' })).toBeNull()
    expect(normalizeExternalMcpServer(null)).toBeNull()
  })
})

describe('bearerTokenEnvVar', () => {
  it('names the variable behind a bearer placeholder, however the header is cased', () => {
    expect(bearerTokenEnvVar({ authorization: 'Bearer ${MY_TOKEN}' })).toBe('MY_TOKEN')
    expect(bearerTokenEnvVar({ Authorization: 'Bearer $MY_TOKEN' })).toBe('MY_TOKEN')
  })

  it('does not mistake a literal token for a variable name', () => {
    // Without the placeholder syntax the header carries the secret itself, and
    // reading it as a variable name would send the child an empty credential.
    expect(bearerTokenEnvVar({ Authorization: 'Bearer sk-abc.123' })).toBeUndefined()
    expect(bearerTokenEnvVar({})).toBeUndefined()
  })
})
