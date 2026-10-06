/**
 * The proxy policy every route shares: local addresses, the inherited NO_PROXY
 * and the hosts listed in Settings bypass the proxy, read the way Node's proxy
 * agents read NO_PROXY; a child process gets the Settings proxy only where its
 * environment names none, and never loses the user's own NO_PROXY.
 */

import { describe, expect, it } from 'vitest'
import {
  applyProxyEnv,
  bypassesProxy,
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
    expect(parseBypassList('https://qyapi.weixin.qq.com/cgi-bin/token, http://wiki.example.com:8080/')).toEqual([
      'qyapi.weixin.qq.com', 'wiki.example.com:8080',
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
    expect(proxyBypassList({ noProxy: '.weixin.qq.com' }, ['corp.example.com,localhost', '.internal'])).toEqual([
      'localhost', '127.0.0.1', '[::1]', 'corp.example.com', '.internal', '.weixin.qq.com',
    ])
  })
})

describe('bypassesProxy', () => {
  const list = proxyBypassList({ noProxy: '.weixin.qq.com, docs.example.com, *.corp.example, git.example.com:8443' })

  it.each([
    'http://localhost:3457/v1/messages',
    'http://127.0.0.1:8080/',
    'http://[::1]:9000/',
    'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
    'https://docs.example.com/page',
    'https://a.b.corp.example/x',
    'https://git.example.com:8443/repo',
  ])('sends %s direct', (url) => {
    expect(bypassesProxy(url, list)).toBe(true)
  })

  it.each([
    'https://api.anthropic.com/v1/messages',
    'https://weixin.qq.com/',
    'https://sub.docs.example.com/',
    'https://git.example.com/repo',
    'not a url',
  ])('sends %s through the proxy', (url) => {
    expect(bypassesProxy(url, list)).toBe(false)
  })

  it('sends everything direct for "*"', () => {
    expect(bypassesProxy('https://api.anthropic.com/', ['*'])).toBe(true)
  })
})

describe('applyProxyEnv', () => {
  it('keeps the user NO_PROXY and adds the local addresses and the Settings list', () => {
    const env: Record<string, string | undefined> = { NO_PROXY: 'corp.example.com', no_proxy: '.internal' }

    applyProxyEnv(env, { proxy: 'http://127.0.0.1:7890', noProxy: '.weixin.qq.com' })

    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,[::1],corp.example.com,.internal,.weixin.qq.com')
    expect(env.no_proxy).toBe(env.NO_PROXY)
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
