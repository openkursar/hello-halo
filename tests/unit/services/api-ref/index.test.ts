/**
 * halo_api_ref is the one always-on MCP tool an agent uses to operate Halo
 * itself. Its most important failure mode is silent: the generator leaves a
 * `{{API_REF_INDEX_PATH}}` template marker in every page footer for this
 * service to substitute at runtime (the real path differs between a dev
 * checkout and a packaged app, so the build can't write it statically). If
 * substitution ever fails to happen, serving the raw marker to a weak model
 * is worse than an error — it reads as a real path, greps it, fails, and
 * reports the capability doesn't exist. This must fail loud instead.
 *
 * resolved-sdk is mocked so tool()/createSdkMcpServer just capture the
 * handler, and resource-path is mocked so this never touches the filesystem
 * or Electron.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../../src/main/services/agent/resolved-sdk', () => ({
  tool: (name: string, description: string, _schema: unknown, handler: unknown) => ({ name, description, handler }),
  createSdkMcpServer: (opts: { tools: Array<{ name: string; handler: Function }> }) => opts,
}))

const mockGetApiRefPath = vi.fn()
const mockReadApiRefFile = vi.fn()

vi.mock('../../../../src/main/services/api-ref/resource-path', () => ({
  getApiRefPath: (...args: unknown[]) => mockGetApiRefPath(...args),
  readApiRefFile: (...args: unknown[]) => mockReadApiRefFile(...args),
}))

import { createApiRefMcpServer, HALO_API_DESCRIPTION, HALO_API_USAGE_GUIDE } from '../../../../src/main/services/api-ref'

type Tool = { name: string; handler: (args: any) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }> }

function buildTool() {
  const server = createApiRefMcpServer() as unknown as { tools: Tool[] }
  return server.tools.find((t) => t.name === 'halo_api_ref')!
}

describe('halo_api_ref', () => {
  it('keeps capability selection concise and puts execution rules before the returned contract', async () => {
    mockReadApiRefFile.mockReturnValue('## workspace\nGET /api/spaces\nFull index: {{API_REF_INDEX_PATH}}/index.txt\n')
    mockGetApiRefPath.mockReturnValue('/fixture/api-ref/index.txt')
    const server = createApiRefMcpServer() as unknown as { description: string; tools: Array<Tool & { description: string }> }
    expect(server.description).toBe(HALO_API_DESCRIPTION)
    expect(HALO_API_USAGE_GUIDE.length).toBeLessThan(700)
    expect(HALO_API_USAGE_GUIDE).toContain('never guess paths or bypass a permission denial')
    expect(server.tools[0].description.length).toBeLessThan(400)
    expect(HALO_API_USAGE_GUIDE).not.toContain('HTTP 200')
    const response = await server.tools[0].handler({ group: 'workspace' })
    const text = response.content[0].text
    expect(text.indexOf('## Execution rules')).toBeLessThan(text.indexOf('GET /api/spaces'))
    for (const marker of ['HTTP 200 alone is not success', "body's success value", 'HTTP 403', 'never bypass a denial', '$HALO_API_TOKEN', 'never print their values', 'started job is not completion', 'credential-write route', 'read_halo_doc', '/fixture/api-ref/index.txt']) expect(text).toContain(marker)
  })

  it('substitutes the index-path template with the real resolved directory', async () => {
    mockReadApiRefFile.mockReturnValue('## digital-human\nFull index: {{API_REF_INDEX_PATH}}/index.txt   (grep it)\n')
    mockGetApiRefPath.mockReturnValue('/Users/x/Halo.app/Contents/Resources/api-ref/index.txt')

    const res = await buildTool().handler({ group: 'digital-human' })

    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('/Users/x/Halo.app/Contents/Resources/api-ref/index.txt')
    expect(res.content[0].text).not.toContain('{{')
    // The token stands for the directory — substituting the file path instead
    // yields `index.txt/index.txt`, a grep target that does not exist. A
    // `toContain` on the path alone passes either way, so pin the wrong shape.
    expect(res.content[0].text).not.toContain('index.txt/index.txt')
  })

  it('fails loud instead of serving an unsubstituted template marker', async () => {
    // The index path could not be resolved at all — substitution never happens.
    mockReadApiRefFile.mockReturnValue('## digital-human\nFull index: {{API_REF_INDEX_PATH}}   (grep it)\n')
    mockGetApiRefPath.mockReturnValue(null)

    const res = await buildTool().handler({ group: 'digital-human' })

    expect(res.isError).toBe(true)
    expect(res.content[0].text).not.toContain('{{API_REF_INDEX_PATH}}')
  })

  it('reports a clear error when the group has no page in this build', async () => {
    mockReadApiRefFile.mockReturnValue(null)

    const res = await buildTool().handler({ group: 'terminal' })

    expect(res.isError).toBe(true)
    expect(res.content[0].text.toLowerCase()).toContain('terminal')
  })
})
