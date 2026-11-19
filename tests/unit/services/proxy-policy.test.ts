/**
 * The proxy policy every route shares: local addresses, the inherited NO_PROXY
 * and the hosts listed in Settings bypass the proxy. The main process matches
 * the list the way Chromium reads its bypass rules (IP ranges included), the
 * AI Browser gets it in Chromium's syntax, and a child process gets the entries
 * as written — the Settings proxy only where its environment names none, and
 * never at the cost of the user's own NO_PROXY.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const product = vi.hoisted(() => ({ networkPolicy: undefined as { proxyOnly?: string[] } | undefined }))
vi.mock('../../../src/main/foundation/product-config', () => ({
  getNetworkPolicy: () => product.networkPolicy,
}))

import {
  applyProxyEnv,
  chromiumBypassRules,
  compileBypassList,
  effectiveProxyOnly,
  mcpServerUrls,
  parseBypassList,
  proxyBypassList,
} from '../../../src/main/services/proxy-policy'

beforeEach(() => {
  for (const key of ['HALO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) vi.stubEnv(key, '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  product.networkPolicy = undefined
})

describe('parseBypassList', () => {
  it('splits on commas, semicolons and whitespace, keeps the first of duplicates', () => {
    expect(parseBypassList('.weixin.qq.com, intranet.example.com;10.0.0.5\n.WEIXIN.qq.com')).toEqual([
      '.weixin.qq.com', 'intranet.example.com', '10.0.0.5',
    ])
  })

  it('keeps only the host and port of a pasted URL', () => {
    expect(parseBypassList(
      'https://qyapi.weixin.qq.com/cgi-bin/token, http://wiki.example.com:8080/, http://user:pw@a.example.com/x, http://[fe80::1]:8080/'
    )).toEqual(['qyapi.weixin.qq.com', 'wiki.example.com:8080', 'a.example.com', '[fe80::1]:8080'])
  })

  it('keeps IP ranges, IPv6 addresses and ports as written', () => {
    expect(parseBypassList('10.0.0.0/8, 192.168.0.0/16, fe80::/10, ::1, [fe80::1]:8080, git.example.com:8443')).toEqual([
      '10.0.0.0/8', '192.168.0.0/16', 'fe80::/10', '::1', '[fe80::1]:8080', 'git.example.com:8443',
    ])
  })

  it('reads nothing from an empty or missing value', () => {
    expect(parseBypassList(undefined)).toEqual([])
    expect(parseBypassList(' , ;')).toEqual([])
  })
})

describe('proxyBypassList', () => {
  it('is only the local addresses when nothing else is set', () => {
    expect(proxyBypassList(undefined)).toEqual(['localhost', '127.0.0.1', '[::1]'])
    expect(proxyBypassList({ proxy: 'http://127.0.0.1:7890', noProxy: '' }, [undefined])).toEqual(['localhost', '127.0.0.1', '[::1]'])
  })

  it('adds the inherited NO_PROXY and the Settings list after them', () => {
    expect(proxyBypassList({ noProxy: '.weixin.qq.com' }, ['corp.example.com,localhost,10.0.0.0/8', '.internal'])).toEqual([
      'localhost', '127.0.0.1', '[::1]', 'corp.example.com', '10.0.0.0/8', '.internal', '.weixin.qq.com',
    ])
  })
})

describe('compileBypassList', () => {
  const direct = compileBypassList(proxyBypassList({
    noProxy: '.weixin.qq.com, docs.example.com, *.corp.example, git.example.com:8443, 10.0.0.0/8, fe80::/10, fd00::5, [fd00::7]:8080',
  }))

  it.each([
    'http://localhost:3457/v1/messages',
    'http://127.0.0.1:8080/',
    'http://[::1]:9000/',
    'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    'https://docs.example.com/page',
    'https://a.b.corp.example/x',
    'https://git.example.com:8443/repo',
    'http://10.1.2.3:8080/',
    'http://[fe80::1]/',
    'http://[fd00::5]:3000/',
    'http://[fd00:0::7]:8080/',
  ])('sends %s direct', (url) => {
    expect(direct(url)).toBe(true)
  })

  it.each([
    'https://api.anthropic.com/v1/messages',
    // A leading dot covers subdomains only, not the domain itself.
    'https://weixin.qq.com/',
    'https://sub.docs.example.com/',
    'https://git.example.com/repo',
    'http://11.0.0.1/',
    'http://[fd00::7]:9090/',
    'not a url',
  ])('sends %s through the proxy', (url) => {
    expect(direct(url)).toBe(false)
  })

  it('sends everything direct for "*"', () => {
    expect(compileBypassList(['*'])('https://api.anthropic.com/')).toBe(true)
  })

  it('ignores an entry it cannot read instead of failing', () => {
    const matcher = compileBypassList(['10.0.0.0/99', 'nonsense/8', '<local>'])
    expect(matcher('http://10.1.2.3/')).toBe(false)
  })
})

describe('chromiumBypassRules', () => {
  it('passes hosts, suffixes and IP ranges as written and brackets a bare IPv6 address', () => {
    expect(chromiumBypassRules(['localhost', '.weixin.qq.com', '10.0.0.0/8', 'fe80::/10', '::1', '[fe80::1]:8080'])).toBe(
      'localhost,.weixin.qq.com,10.0.0.0/8,fe80::/10,[::1],[fe80::1]:8080'
    )
  })
})

describe('applyProxyEnv', () => {
  it('keeps the user NO_PROXY and adds the local addresses and the Settings list', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: 'corp.example.com', no_proxy: '.internal' }

    applyProxyEnv(env, { proxy: 'http://127.0.0.1:7890', noProxy: '.weixin.qq.com' })

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,[::1],corp.example.com,.internal,.weixin.qq.com')
    expect(env.no_proxy).toBe(env.NO_PROXY)
  })

  it('hands IP ranges and IPv6 entries to the child as written', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: '10.0.0.0/8,192.168.0.0/16' }

    applyProxyEnv(env, { noProxy: 'fe80::/10, ::1' })

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,[::1],10.0.0.0/8,192.168.0.0/16,fe80::/10,::1')
  })

  it('uses the Settings proxy only where the environment names none', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: 'http://10.0.0.1:3128' }

    applyProxyEnv(env, { proxy: 'http://127.0.0.1:7890' })

    expect(env.HTTPS_PROXY).toBe('http://10.0.0.1:3128')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.https_proxy).toBe('http://127.0.0.1:7890')
  })

  it('sets only the local addresses when no proxy and no list are configured', () => {
    const env: Record<string, string | undefined> = {}

    applyProxyEnv(env, undefined)

    expect(env).toEqual({ NO_PROXY: 'localhost,127.0.0.1,[::1]', no_proxy: 'localhost,127.0.0.1,[::1]' })
  })

  it('gives a proxy URL written without a scheme an http:// one', () => {
    const env: Record<string, string | undefined> = { HTTPS_PROXY: '127.0.0.1:7890', ALL_PROXY: 'socks5://127.0.0.1:1080' }

    applyProxyEnv(env, undefined)

    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7890')
    expect(env.ALL_PROXY).toBe('socks5://127.0.0.1:1080')
  })

  it('leaves the session endpoints alone when no host list limits the proxy', () => {
    vi.stubEnv('HALO_SERVER_MODE', '1')
    const env: Record<string, string | undefined> = {}

    applyProxyEnv(env, { proxy: 'http://127.0.0.1:7890' }, ['https://llm.corp.example/v1'])

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,[::1]')
  })

  it('adds the session endpoints proxyOnly excludes to NO_PROXY on a server', () => {
    vi.stubEnv('HALO_SERVER_MODE', '1')
    const env: Record<string, string | undefined> = { NO_PROXY: '.internal' }

    applyProxyEnv(env, { proxy: 'http://127.0.0.1:7890', proxyOnly: ['*.weixin.qq.com'] }, [
      'https://llm.corp.example/v1', 'https://qyapi.weixin.qq.com/mcp', 'http://10.0.0.8:8080/sse', undefined, 'not a url',
    ])

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,[::1],.internal,llm.corp.example:443,10.0.0.8:8080')
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:7890')
  })

  it('does not exempt a proxied port on a host with a direct endpoint', () => {
    vi.stubEnv('HALO_SERVER_MODE', '1')
    const env: Record<string, string> = {}
    applyProxyEnv(env, { proxyOnly: ['mcp.internal:443'] }, ['https://mcp.internal', 'http://mcp.internal:8080'])
    expect(env.NO_PROXY.split(',')).toContain('mcp.internal:8080')
    expect(env.NO_PROXY.split(',')).not.toContain('mcp.internal')
  })

  it('ignores proxyOnly on the desktop', () => {
    const env: Record<string, string | undefined> = {}

    applyProxyEnv(env, { proxyOnly: ['*.weixin.qq.com'] }, ['https://llm.corp.example/v1'])

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,[::1]')
  })
})

describe('effectiveProxyOnly', () => {
  it('is empty on the desktop, whatever is configured', () => {
    product.networkPolicy = { proxyOnly: ['*.weixin.qq.com'] }
    expect(effectiveProxyOnly(['api.example.com'])).toEqual([])
    expect(effectiveProxyOnly(undefined)).toEqual([])
  })

  it('takes the config value on a server, else the product default', () => {
    vi.stubEnv('HALO_SERVER_MODE', 'true')
    product.networkPolicy = { proxyOnly: ['*.weixin.qq.com'] }
    expect(effectiveProxyOnly(['api.example.com'])).toEqual(['api.example.com'])
    expect(effectiveProxyOnly([])).toEqual([])
    expect(effectiveProxyOnly(undefined)).toEqual(['*.weixin.qq.com'])
    product.networkPolicy = undefined
    expect(effectiveProxyOnly(undefined)).toEqual([])
  })
})

describe('mcpServerUrls', () => {
  it('lists the URLs of remote servers only', () => {
    expect(mcpServerUrls({
      remote: { type: 'http', url: 'https://mcp.example.com/mcp' },
      events: { type: 'sse', url: 'https://sse.example.com/sse' },
      local: { command: 'node', args: ['server.js'] },
      inProcess: { type: 'sdk', instance: {} },
      empty: null,
    })).toEqual(['https://mcp.example.com/mcp', 'https://sse.example.com/sse'])
    expect(mcpServerUrls(undefined)).toEqual([])
  })
})
