/**
 * Proxy Policy
 *
 * Which proxy Halo's traffic takes and which hosts bypass it, decided once for
 * every route: requests the main process makes (proxy-fetch), the AI Browser
 * session while it follows the Settings proxy, and the environment of the
 * processes Halo starts — agent engines and the MCP servers they connect.
 *
 * The bypass list joins the local addresses, the NO_PROXY the app inherited
 * and the hosts the user listed in Settings, read the way Node's proxy agents
 * read NO_PROXY so every route agrees on it.
 */

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

/**
 * Entries of a NO_PROXY-style list, separated by commas, semicolons or
 * whitespace. A pasted URL keeps only its host and port.
 */
export function parseBypassList(value: string | undefined): string[] {
  const entries: string[] = []
  for (const raw of (value ?? '').split(/[\s,;]+/)) {
    const entry = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').toLowerCase()
    if (entry && !entries.includes(entry)) entries.push(entry)
  }
  return entries
}

/** Local addresses, then the inherited NO_PROXY, then the hosts listed in Settings. */
export function proxyBypassList(
  settings: ProxySettings | undefined,
  inherited: ReadonlyArray<string | undefined> = []
): string[] {
  return parseBypassList([...LOCAL_HOSTS, ...inherited, settings?.noProxy].filter(Boolean).join(','))
}

/**
 * Whether a request to `url` goes direct. "*" matches every host, ".host" and
 * "*.host" the host's subdomains, any other entry exactly that host;
 * "host:port" only that port.
 */
export function bypassesProxy(url: string | URL, list: readonly string[]): boolean {
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return false
  }
  const hostname = parsed.hostname.toLowerCase()
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '')
  return list.some(entry => {
    if (entry === '*') return true
    const withPort = /^(.+):(\d+)$/.exec(entry)
    if (withPort && withPort[2] !== port) return false
    const host = withPort ? withPort[1] : entry
    if (host.startsWith('*')) return hostname.endsWith(host.slice(1))
    if (host.startsWith('.')) return hostname.endsWith(host)
    return hostname === host
  })
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
