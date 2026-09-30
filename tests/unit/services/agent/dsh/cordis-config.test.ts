/**
 * Unit test: services/agent/dsh/runtime/cordis-config — the composition that
 * decides what the model can do.
 *
 * This is the only place a restriction can be applied to this runtime: there is
 * no per-call approval channel and no tool filter outside the child, so a tool
 * a guest must not use has to be a tool that never gets registered. A gap here
 * is not a degraded feature, it is an unrestricted guest.
 */

import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { beforeEach, describe, expect, it } from 'vitest'
import { materializeCordisConfig } from '../../../../../src/main/services/agent/dsh/runtime/cordis-config'
import type { ExternalMcpServer } from '../../../../../src/main/services/agent/mcp/types'

/** Every tool plugin the composition can mount, by cordis id. */
const TOOL_IDS = [
  'tool-fs',
  'tool-fs-search',
  'tool-str-replace-editor',
  'tool-todo',
  'tool-bash',
  'tool-terminal',
  'tool-web',
  'tool-skill',
  'tool-subagent',
]

/**
 * What `app-chat.ts` produces for a guest whose policy permits nothing — the
 * default. Spelled out rather than imported: this asserts the runtime answers
 * correctly to the list it is handed, and coupling it to the caller's constant
 * would let both drift together unnoticed.
 */
const EVERY_HALO_TOOL = [
  'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit',
  'EnterPlanMode', 'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob',
  'Grep', 'NotebookEdit', 'Read', 'Skill', 'Task', 'TaskOutput', 'TaskStop',
  'TodoWrite', 'WebFetch', 'WebSearch', 'Write',
]

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'dsh-cordis-'))
})

function compose(
  disallowedTools?: readonly string[],
  mcpServers?: Record<string, ExternalMcpServer>
): { text: string; file: string; env: Record<string, string>; mcpServers: string[] } {
  const config = materializeCordisConfig(dir, {
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    workDir: '/work',
  })
  return {
    text: readFileSync(config.path, 'utf-8'),
    file: config.path,
    env: config.env,
    mcpServers: config.mcpServers,
  }
}

/** The cordis ids present in a composition. */
function mountedTools(text: string): string[] {
  return TOOL_IDS.filter((id) => text.includes(`- id: ${id}\n`))
}

describe('materializeCordisConfig', () => {
  it('mounts every tool for an unrestricted caller', () => {
    expect(mountedTools(compose().text)).toEqual(TOOL_IDS)
  })

  it('drops both shell surfaces when the shell is denied', () => {
    const mounted = mountedTools(compose(['Bash']).text)

    // tool-terminal is six terminal_* tools driving a live shell: denying Bash
    // and leaving it mounted would deny nothing at all.
    expect(mounted).not.toContain('tool-bash')
    expect(mounted).not.toContain('tool-terminal')
    expect(mounted).toContain('tool-fs')
  })

  it('leaves a default guest with no tools at all', () => {
    const { text } = compose(EVERY_HALO_TOOL)

    expect(mountedTools(text)).toEqual([])
    // The runtime still has to boot and answer: a guest gets a chat, not a crash.
    expect(text).toContain("name: 'cordis:dsh-sdk-jsonrpc-server'")
    expect(text).toContain("name: 'cordis:dsh-agent'")
  })

  it('withholds a bundle it cannot fully permit rather than over-granting', () => {
    // A read-only guest. dsh registers read, write and edit from one plugin, so
    // the only choice that respects the denial of Write is to omit the bundle
    // and lose Read with it.
    const mounted = mountedTools(compose(EVERY_HALO_TOOL.filter((t) => t !== 'Read' && t !== 'Glob' && t !== 'Grep')).text)

    expect(mounted).toEqual(['tool-fs-search'])
  })

  it('discovers skills from Halo roots only, so both engines see one catalogue', () => {
    const { text } = compose()

    expect(text).toContain("name: 'cordis:dsh-skill-filesystem'")
    // The provider's own ~/.dsh and ~/.agents roots hold skills Halo never
    // wrote and the default engine never reads.
    expect(text).toContain('includeDefaultRoots: false')
    expect(text).toContain('DSH_SKILL_DIRS')
  })

  it('withholds the skill loader from a caller denied Skill, leaving discovery inert', () => {
    expect(mountedTools(compose(['Skill']).text)).not.toContain('tool-skill')
    expect(compose(['Skill']).text).toContain("name: 'cordis:dsh-skill-filesystem'")
  })

  it('narrows the web block instead of dropping it', () => {
    // Halo denies WebSearch by default, so treating web as one bundle would
    // take web_fetch away from every ordinary user.
    const { text } = compose(['WebSearch'])

    expect(mountedTools(text)).toContain('tool-web')
    expect(text).toContain('search: false')
    expect(text).toContain('fetch: true')
  })

  it('drops the web block only when neither of its tools is permitted', () => {
    expect(mountedTools(compose(['WebSearch', 'WebFetch']).text)).not.toContain('tool-web')
  })

  it('mounts one MCP client per server and points it at the environment', () => {
    const { text, mcpServers } = compose(undefined, {
      'web-search': { transport: 'http', url: 'https://example.com/mcp', headers: {} },
      files: { transport: 'stdio', command: 'npx', args: ['-y', 'fs'], env: {} },
    })

    expect(mcpServers).toEqual(['web-search', 'files'])
    expect(text).toContain("- id: mcp-web-search\n  name: 'cordis:dsh-mcp-client'")
    expect(text).toContain("- id: mcp-files\n  name: 'cordis:dsh-mcp-client'")
    // Single-quoted inside the double-quoted YAML scalar: double quotes here
    // terminate the scalar and the whole document fails to parse.
    expect(text).toContain(`config: !!js "JSON.parse(process.env.DSH_MCP_SERVERS)['web-search']"`)
  })

  it('keeps every MCP secret and endpoint out of the file on disk', () => {
    // The composition outlives the session in a shared directory. A token
    // written here is a token readable by anything that can read the folder,
    // long after the conversation that supplied it ended.
    const { text, env } = compose(undefined, {
      secret: {
        transport: 'stdio',
        command: 'server',
        args: [],
        env: { API_TOKEN: 'tk-do-not-write-me' },
      },
      remote: {
        transport: 'http',
        url: 'http://127.0.0.1:51234/mcp/ai-browser',
        headers: { Authorization: 'Bearer tk-also-secret' },
      },
    })

    expect(text).not.toContain('tk-do-not-write-me')
    expect(text).not.toContain('tk-also-secret')
    expect(text).not.toContain('51234')
    expect(env.DSH_MCP_SERVERS).toContain('tk-do-not-write-me')
    expect(JSON.parse(env.DSH_MCP_SERVERS).remote.url).toBe('http://127.0.0.1:51234/mcp/ai-browser')
  })

  it('lets two sessions differing only in credentials share one watched file', () => {
    // The loader hot-reloads the path it booted from. If a token reached the
    // text, the second session would rewrite the file the first is watching.
    const first = compose(undefined, {
      files: { transport: 'stdio', command: 'server', args: [], env: { TOKEN: 'a' } },
    })
    const second = compose(undefined, {
      files: { transport: 'stdio', command: 'server', args: [], env: { TOKEN: 'b' } },
    })

    expect(second.file).toBe(first.file)
    expect(second.env.DSH_MCP_SERVERS).not.toBe(first.env.DSH_MCP_SERVERS)
  })

  it('gives a session with different MCP servers a different file', () => {
    const withServer = compose(undefined, {
      files: { transport: 'stdio', command: 'server', args: [], env: {} },
    })

    expect(withServer.file).not.toBe(compose().file)
  })

  it('drops a server the dsh client cannot reach instead of misconfiguring it', () => {
    const { text, mcpServers } = compose(undefined, {
      legacy: { transport: 'sse', url: 'https://example.com/sse', headers: {} },
      'name with spaces': { transport: 'stdio', command: 'server', args: [], env: {} },
    })

    expect(mcpServers).toEqual([])
    expect(text).not.toContain('dsh-mcp-client')
  })

  it('defaults a server with no working directory to the session workspace', () => {
    const { env } = compose(undefined, {
      files: { transport: 'stdio', command: 'server', args: [], env: {} },
    })

    expect(JSON.parse(env.DSH_MCP_SERVERS).files.cwd).toBe('/work')
  })

  it('reads the model context window from the environment, not from the file', () => {
    // Compaction fires at a ratio of this number. Writing a session's window
    // into the document would fork the file per model and let one runtime's
    // capacity rewrite the file another is watching.
    const { text } = compose()

    expect(text).toContain(
      'defaultContextWindow: !!js "Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)"'
    )
  })

  it('replaces the shipped model catalogue with the one Halo passes in', () => {
    // A shipped entry carries its own window and outranks the value above, so
    // leaving the list in place would exempt the models it names from the
    // user's own configuration while their neighbours obey it.
    expect(compose().text).toContain(`models: !!js "JSON.parse(process.env.DSH_MODEL_CATALOG ?? '[]')"`)
  })

  it('mounts the attachment store an image prompt is admitted into', () => {
    const { text } = compose()
    expect(text).toContain("name: 'cordis:dsh-attachment-local'")
    expect(text).toContain("name: 'cordis:dsh-compaction-image-offload'")
  })

  it('gives the model Halo\'s persona as its whole identity', () => {
    const { text } = compose()
    expect(text).toMatch(/includeHarnessIdentity: false/)
    expect(text).toMatch(/personaPrefix: !!js process\.env\.DSH_SYSTEM_PROMPT/)
  })

  it('relays the live assistant stream the SDK protocol does not carry', () => {
    expect(compose().text).toContain("name: 'cordis:halo-assistant-stream'")
  })

  it('retries transient provider failures instead of ending the turn', () => {
    expect(compose().text).toContain("name: 'cordis:dsh-llm-retry'")
  })

  it('mounts no session persistence the SDK protocol could never read back', () => {
    const { text } = compose()
    expect(text).not.toContain('session-persistence')
    expect(text).not.toContain('session-checkpoint-policy')
  })

  it('sizes compaction headroom to fit windows smaller than DeepSeek\'s', () => {
    expect(compose().text).toMatch(/headroomTokens: 16384/)
  })

  it('picks the PowerShell terminal dialect only when Halo found no bash', () => {
    const { text } = compose()
    expect(text).toContain(`shellDialect: !!js "process.env.DSH_SHELL_PATH ? 'bash' : 'pwsh'"`)
  })

  it('gives each composition its own filename', () => {
    // The loader hot-reloads the path it booted from and every session shares
    // this directory, so a name shared across policies would let a new launch
    // rewrite a running guest's permissions.
    expect(compose().file).not.toBe(compose(['Bash']).file)
  })

  it('reuses the path and the bytes for an identical composition', () => {
    const first = compose(['Bash'])
    const second = compose(['Bash'])

    expect(second.file).toBe(first.file)
    expect(second.text).toBe(first.text)
  })
})
