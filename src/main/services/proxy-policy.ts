/**
 * Proxy Policy
 *
 * Which proxy Halo's traffic takes and which hosts bypass it, decided once for
 * every route: requests the main process makes (proxy-fetch), the AI Browser
 * session while it follows the Settings proxy, and the environment of the
 * processes Halo starts — agent engines and the MCP servers they connect.
 *
 * The bypass list joins the local addresses, the NO_PROXY the app inherited
 * and the hosts the user listed in Settings. Its entries mean what Chromium's
 * bypass rules mean: "*" every host; ".example.com" and "*.example.com" the
 * subdomains, not example.com itself; any other host only itself; "host:port"
 * that port only; "10.0.0.0/8" an IP range. The main process matches requests
 * that way and the AI Browser gets the same rules. A child process gets the
 * entries as written and reads them by its own rules, some of which also count
 * example.com for ".example.com" — so ".example.com" plus "example.com" means
 * the same everywhere.
 */

import { BlockList, isIP } from 'node:net'

/** Reached directly by every route: the loopback router and other local services. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

const PROXY_URL_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'] as const

/** Proxy variables whose value must be a URL with a scheme. */
const PROXY_ENV_KEYS = [...PROXY_URL_KEYS, 'ALL_PROXY', 'all_proxy'] as const

/** The network settings this policy reads (config `network`). */
export interface ProxySettings {
  /** Settings proxy URL; unset means the system proxy. */
  proxy?: string
  /** Hosts that bypass the proxy, as the user typed them. */
  noProxy?: string
}

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

const DEFAULT_PORTS: Record<string, string> = { 'http:': '80', 'https:': '443', 'ws:': '80', 'wss:': '443' }

/**
 * Entries of a NO_PROXY-style list, separated by commas, semicolons or
 * whitespace. A pasted URL keeps only its host and port; every other entry,
 * an IP range included, is kept as written.
 */
export function parseBypassList(value: string | undefined): string[] {
  const entries: string[] = []
  for (const raw of (value ?? '').split(/[\s,;]+/)) {
    const entry = (SCHEME.test(raw) ? urlHost(raw) : raw).toLowerCase()
    if (entry && !entries.includes(entry)) entries.push(entry)
  }
  return entries
}

function urlHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Local addresses, then the inherited NO_PROXY, then the hosts listed in Settings. */
export function proxyBypassList(
  settings: ProxySettings | undefined,
  inherited: ReadonlyArray<string | undefined> = []
): string[] {
  return parseBypassList([...LOCAL_HOSTS, ...inherited, settings?.noProxy].filter(Boolean).join(','))
}

type BypassRule =
  | { kind: 'all' }
  | { kind: 'range'; addresses: BlockList }
  | { kind: 'host'; host: string; port?: string }

/**
 * Whether a request goes direct under the list, read as described above.
 * Built once per list; an entry it cannot read (Chromium's "<local>", a range
 * that is not one) is left out.
 */
export function compileBypassList(list: readonly string[]): (url: string | URL) => boolean {
  const rules = list.map(readRule).filter((rule): rule is BypassRule => rule !== null)
  return (url) => {
    let parsed: URL
    try {
      parsed = typeof url === 'string' ? new URL(url) : url
    } catch {
      return false
    }
    const hostname = parsed.hostname.toLowerCase()
    const port = parsed.port || DEFAULT_PORTS[parsed.protocol] || ''
    const address = hostname.replace(/^\[(.*)\]$/, '$1')
    const family = isIP(address)
    return rules.some(rule => {
      if (rule.kind === 'all') return true
      if (rule.kind === 'range') return family !== 0 && rule.addresses.check(address, family === 4 ? 'ipv4' : 'ipv6')
      if (rule.port && rule.port !== port) return false
      if (rule.host.startsWith('*')) return hostname.endsWith(rule.host.slice(1))
      if (rule.host.startsWith('.')) return hostname.endsWith(rule.host)
      return hostname === rule.host
    })
  }
}

function readRule(entry: string): BypassRule | null {
  if (entry === '*') return { kind: 'all' }
  const range = /^\[?([^\]/]+)\]?\/(\d{1,3})$/.exec(entry)
  if (range) {
    const family = isIP(range[1])
    const bits = Number(range[2])
    if (!family || bits > (family === 4 ? 32 : 128)) return null
    const addresses = new BlockList()
    addresses.addSubnet(range[1], bits, family === 4 ? 'ipv4' : 'ipv6')
    return { kind: 'range', addresses }
  }
  if (entry.includes('/') || entry.startsWith('<')) return null
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry)
  if (bracketed) {
    return isIP(bracketed[1]) === 6 ? { kind: 'host', host: ipv6Hostname(bracketed[1]), port: bracketed[2] } : null
  }
  if (isIP(entry) === 6) return { kind: 'host', host: ipv6Hostname(entry) }
  const withPort = /^(.+):(\d+)$/.exec(entry)
  return withPort ? { kind: 'host', host: withPort[1], port: withPort[2] } : { kind: 'host', host: entry }
}

/** An IPv6 address the way a URL's hostname spells it: bracketed and compressed. */
function ipv6Hostname(address: string): string {
  try {
    return new URL(`http://[${address}]/`).hostname
  } catch {
    return `[${address}]`
  }
}

/** The list in the syntax of Chromium's bypass rules, which needs IPv6 addresses bracketed. */
export function chromiumBypassRules(list: readonly string[]): string {
  return list.map(entry => (isIP(entry) === 6 ? `[${entry}]` : entry)).join(',')
}

/**
 * The proxy part of a child process environment: the Settings proxy where the
 * inherited environment names none, the bypass list as NO_PROXY, and a scheme
 * for proxy URLs written without one (the CLI's HTTP client parses them with
 * `new URL()`, which rejects "127.0.0.1:7890").
 */
export function applyProxyEnv(
  env: Record<string, string | number | undefined>,
  settings: ProxySettings | undefined
): void {
  const proxy = settings?.proxy?.trim()
  if (proxy) {
    for (const key of PROXY_URL_KEYS) {
      if (!env[key]) env[key] = proxy
    }
  }

  const noProxy = proxyBypassList(settings, [env.NO_PROXY, env.no_proxy].map(value => value?.toString())).join(',')
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy

  for (const key of PROXY_ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value && !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      env[key] = `http://${value}`
    }
  }
}
