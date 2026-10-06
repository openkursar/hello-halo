/**
 * The proxy policy every route shares: local addresses, the inherited NO_PROXY
 * and the hosts listed in Settings bypass the proxy. The main process matches
 * the list the way Chromium reads its bypass rules (IP ranges included), the
 * AI Browser gets it in Chromium's syntax, and a child process gets the entries
 * as written — the Settings proxy only where its environment names none, and
 * never at the cost of the user's own NO_PROXY.
 */

import { describe, expect, it } from 'vitest'
import {
  applyProxyEnv,
  chromiumBypassRules,
  compileBypassList,
  parseBypassList,
  proxyBypassList,
} from '../../../src/main/services/proxy-policy'

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
})
