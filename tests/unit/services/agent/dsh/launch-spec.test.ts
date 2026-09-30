/**
 * Unit test: services/agent/dsh/runtime — shell resolution and the child
 * environment built around it.
 *
 * The Windows half of this cannot be reached by running the runtime here, and
 * it is the half that breaks: `dsh-bash-local` spawns the bare name `bash`, so
 * a missing PATH entry turns every shell command into ENOENT on a platform the
 * developer machine never exercises.
 */

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const detectGitBash = vi.fn()
vi.mock('../../../../../src/main/services/git-bash', () => ({
  detectGitBash: () => detectGitBash(),
}))

import { buildDshLaunchSpec } from '../../../../../src/main/services/agent/dsh/runtime/launch-spec'
import { resolveDshShell } from '../../../../../src/main/services/agent/dsh/runtime/resolve'

const realPlatform = process.platform
const realPath = process.env.PATH
const realOverride = process.env.HALO_DSH_NODE

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  process.env.PATH = realPath
  if (realOverride === undefined) delete process.env.HALO_DSH_NODE
  else process.env.HALO_DSH_NODE = realOverride
  vi.clearAllMocks()
})

describe('resolveDshShell', () => {
  it('takes the Git Bash path and puts its directory on PATH for Windows', () => {
    setPlatform('win32')
    detectGitBash.mockReturnValue({
      found: true,
      path: 'C:\\Program Files\\Git\\bin\\bash.exe',
      source: 'system',
    })

    expect(resolveDshShell()).toEqual({
      path: 'C:\\Program Files\\Git\\bin\\bash.exe',
      pathPrepend: path.dirname('C:\\Program Files\\Git\\bin\\bash.exe'),
    })
  })

  it('leaves PATH untouched where bash is already on it', () => {
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    expect(resolveDshShell()).toEqual({ path: '/bin/bash', pathPrepend: null })
  })

  it('reports no shell rather than inventing a path', () => {
    setPlatform('win32')
    detectGitBash.mockReturnValue({ found: false, path: null, source: null })

    expect(resolveDshShell()).toBeNull()
  })
})

describe('buildDshLaunchSpec', () => {
  let dataDir = ''

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'dsh-launch-spec-'))
    // Pin the interpreter: which one wins depends on the machine running the
    // suite, and this asserts the environment, not the interpreter choice.
    process.env.HALO_DSH_NODE = '/stub/node'
  })

  function build(
    options: Partial<Parameters<typeof buildDshLaunchSpec>[0]> = {}
  ): Record<string, string> {
    return buildDshLaunchSpec({
      workDir: '/work',
      runtimeDataDir: dataDir,
      apiKey: 'k',
      ...options,
    }).env
  }

  it('prepends the shell directory so the bare name `bash` resolves', () => {
    setPlatform('win32')
    process.env.PATH = 'C:\\Windows\\System32'
    const bash = 'C:\\Git\\bin\\bash.exe'
    detectGitBash.mockReturnValue({ found: true, path: bash, source: 'system' })

    const env = build()

    expect(env.DSH_SHELL_PATH).toBe(bash)
    expect(env.PATH).toBe(`${path.dirname(bash)}${path.delimiter}C:\\Windows\\System32`)
  })

  it('names the shell without reordering PATH on POSIX', () => {
    setPlatform('darwin')
    process.env.PATH = '/opt/homebrew/bin:/usr/bin'
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    const env = build()

    expect(env.DSH_SHELL_PATH).toBe('/bin/bash')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/bin')
  })

  it('omits the shell variable when none was found, leaving the config to fall back', () => {
    setPlatform('win32')
    detectGitBash.mockReturnValue({ found: false, path: null, source: null })

    expect(build().DSH_SHELL_PATH).toBeUndefined()
  })

  it('passes only the allowlisted ambient variables to the child', () => {
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })
    process.env.ANTHROPIC_API_KEY = 'must-not-reach-the-model-provider'

    try {
      expect(build().ANTHROPIC_API_KEY).toBeUndefined()
    } finally {
      delete process.env.ANTHROPIC_API_KEY
    }
  })

  it('routes web search through the same endpoint as the conversation', () => {
    // Search holds its own endpoint whose default is DeepSeek's API; left
    // there, it would carry Halo's encoded backend descriptor off the machine.
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    const env = build({ baseUrl: 'http://127.0.0.1:3457/v1' })

    expect(env.DEEPSEEK_BASE_URL).toBe('http://127.0.0.1:3457/v1')
    expect(env.DEEPSEEK_SEARCH_BASE_URL).toBe('http://127.0.0.1:3457/v1')
  })

  it('declares image input only for a model Halo judges vision-capable', () => {
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    expect(build().DSH_MODEL_CATALOG).toBeUndefined()
    // The entry carries no window: the Settings-governed one must still apply.
    expect(JSON.parse(build({ imageInputModel: 'deepseek-flash' }).DSH_MODEL_CATALOG)).toEqual([
      { id: 'deepseek-flash', inputModalities: ['text', 'image'] },
    ])
  })

  it("keeps the runtime's home inside Halo's data directory", () => {
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    expect(build().DSH_HOME).toBe(path.join(dataDir, 'home'))
  })

  it('names both skill roots so the runtime reads what Halo installed', () => {
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    const roots = JSON.parse(build().DSH_SKILL_DIRS)

    // The space-scoped root is where a skill installed into this workspace
    // lands; without it the runtime only ever sees global skills.
    expect(roots).toContain(path.join('/work', '.claude', 'skills'))
    expect(roots.some((root: string) => root.endsWith(path.join('claude-config', 'skills')))).toBe(true)
  })

  it('carries MCP configuration in the environment, never on the command line', () => {
    // Arguments are visible to any process listing on the machine.
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    const spec = buildDshLaunchSpec({
      workDir: '/work',
      runtimeDataDir: dataDir,
      apiKey: 'k',
      mcpServers: {
        files: { transport: 'stdio', command: 'server', args: [], env: { TOKEN: 'secret' } },
      },
    })

    expect(JSON.parse(spec.env.DSH_MCP_SERVERS).files.env.TOKEN).toBe('secret')
    expect(spec.args.join(' ')).not.toContain('secret')
  })

  it('names the active model context window so compaction has a real capacity', () => {
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    expect(build({ contextWindow: 200_000 }).DSH_CONTEXT_WINDOW).toBe('200000')
  })

  it('leaves the window unset when Halo knows nothing about the model', () => {
    // The composition falls back to the adapter default; naming a guess here
    // would cap a model that genuinely holds more.
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    expect(build().DSH_CONTEXT_WINDOW).toBeUndefined()
  })

  it('still defines the MCP table when no server is configured', () => {
    // The composition reads the variable unconditionally; leaving it unset
    // would fail the load rather than mount nothing.
    setPlatform('darwin')
    detectGitBash.mockReturnValue({ found: true, path: '/bin/bash', source: 'system' })

    expect(build().DSH_MCP_SERVERS).toBe('{}')
  })
})
