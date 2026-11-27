import { createHash, randomBytes, randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { dirname } from 'path'
import type { EnterpriseIdentityProvider, OrgBrowserCookie } from '../../../shared/interfaces/enterprise-identity-provider'

/** The part of Electron's `Cookies` this module uses, so it can be supplied by the host and faked in tests. */
export interface BrowserCookieStore {
  get(filter: { domain?: string; url?: string; name?: string }): Promise<Array<{ name: string; domain?: string; path?: string; secure?: boolean }>>
  set(details: {
    url: string
    name: string
    value: string
    domain?: string
    path: string
    secure: boolean
    httpOnly: boolean
    sameSite: 'lax'
    expirationDate: number
  }): Promise<void>
  remove(url: string, name: string): Promise<void>
}

export interface OrgBrowserCookiesOptions {
  store: () => BrowserCookieStore
  /**
   * What Halo wrote (names, never values), the domains it signed in and a
   * digest of the person, kept between runs so a crash leaves nothing behind
   * and the next person never inherits the previous one's page sessions.
   */
  recordFile: string
  now?: () => number
  refreshMarginMs?: number
  log?: Pick<Console, 'error' | 'warn' | 'info'>
}

interface Written {
  domain: string
  path: string
  name: string
  secure: boolean
}

interface CookieRecord {
  salt: string
  subject?: string
  domains: string[]
  cookies: Written[]
}

const MAX_COOKIES = 16
const MAX_VALUE = 4096
const MAX_TIMER_MS = 2 ** 31 - 1
const RETRY_MS = [30_000, 120_000, 300_000]
// A browser keeps nothing longer than this, whatever the provider asks.
const MAX_LIFETIME_MS = 30 * 24 * 3600_000
const DOMAIN = /^\.?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]{1,128}$/
// RFC 6265 cookie-octets: no controls, whitespace, double quote, comma, semicolon or backslash.
const VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/
const PATH = /^\/[\x21-\x3A\x3C-\x7E]{0,255}$/

const keyOf = (cookie: Pick<Written, 'domain' | 'path' | 'name'>) => `${cookie.domain}\u0000${cookie.path}\u0000${cookie.name}`
const urlOf = (cookie: Pick<Written, 'domain' | 'path' | 'secure'>) =>
  `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path}`

/** The provider's cookies when every one is well formed and still valid; otherwise null. */
export function validBrowserCookies(raw: unknown, now: number): Array<Required<OrgBrowserCookie>> | null {
  if (!Array.isArray(raw) || raw.length > MAX_COOKIES) return null
  const cookies: Array<Required<OrgBrowserCookie>> = []
  const seen = new Set<string>()
  for (const item of raw as Array<Partial<OrgBrowserCookie>>) {
    if (!item || typeof item !== 'object') return null
    const { domain, name, value, path = '/', secure = false, expiresAt } = item
    if (typeof domain !== 'string' || !DOMAIN.test(domain) || domain.replace(/^\./, '') === 'localhost') return null
    if (typeof name !== 'string' || !TOKEN.test(name)) return null
    if (typeof value !== 'string' || !value || value.length > MAX_VALUE || !VALUE.test(value)) return null
    if (typeof path !== 'string' || !PATH.test(path) || typeof secure !== 'boolean') return null
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= now) return null
    const key = keyOf({ domain, path, name })
    if (seen.has(key)) return null
    seen.add(key)
    cookies.push({ domain, name, value, path, secure, expiresAt })
  }
  return cookies
}

/**
 * Keeps the organization's browser cookies in Halo's built-in browser in line
 * with the sign-in: written while it is active, renewed before they expire,
 * removed when it ends. When a different person signs in, every cookie of the
 * domains signed in before is cleared first, so pages the previous person
 * opened with the ticket do not stay signed in as them.
 */
export class OrgBrowserCookies {
  private readonly now: () => number
  private readonly log: Pick<Console, 'error' | 'warn' | 'info'>
  private readonly written = new Map<string, Written>()
  private readonly domains = new Set<string>()
  private subject?: string
  // Per installation, so the recorded digest cannot be matched against a known account.
  private salt = randomBytes(16).toString('hex')
  private provider?: EnterpriseIdentityProvider
  private person?: string
  private basis: string | null = null
  private generation = 0
  private pending = false
  private failures = 0
  private refreshAt?: number
  private timer?: ReturnType<typeof setTimeout>
  private loaded?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(private readonly options: OrgBrowserCookiesOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? console
  }

  /**
   * Follow the sign-in. `basis` identifies what is signed in (person and ready
   * capabilities), or is null when nothing should be. A new basis asks the
   * provider again; null removes what Halo wrote.
   */
  sync(provider: EnterpriseIdentityProvider | undefined, person: string | undefined, basis: string | null, resetRetries = false): void {
    if (this.disposed) return
    if (!provider?.browserCookies || !person) basis = null
    if (basis === null) {
      if (this.basis !== null) void this.withdraw()
      else if (!this.loaded) void this.serialize(async () => undefined)
      return
    }
    this.provider = provider
    this.person = person
    const changed = basis !== this.basis
    this.basis = basis
    if (changed) {
      this.generation++
      this.failures = 0
      this.refreshAt = this.now()
    } else if (resetRetries && this.failures > 0) {
      this.failures = 0
      this.refreshAt = this.now()
    }
    if (!this.pending && this.refreshAt !== undefined && this.refreshAt <= this.now()) void this.fetch()
    else this.arm()
  }

  /** Remove what Halo wrote; pages the person signed in to keep their own sessions. */
  withdraw(): Promise<void> {
    this.generation++
    this.basis = null
    this.provider = undefined
    this.person = undefined
    this.refreshAt = undefined
    this.failures = 0
    this.arm()
    return this.serialize(() => this.removeWritten())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    void this.withdraw()
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => this.load()).then(task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Read what an earlier run recorded and remove the cookies it never removed; once, before anything else. */
  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      try {
        const record = JSON.parse(await fsp.readFile(this.options.recordFile, 'utf8')) as Partial<CookieRecord>
        if (typeof record.salt === 'string' && /^[a-f0-9]{32}$/.test(record.salt)) this.salt = record.salt
        if (typeof record.subject === 'string' && /^[a-f0-9]{64}$/.test(record.subject)) this.subject = record.subject
        for (const domain of Array.isArray(record.domains) ? record.domains : []) {
          if (typeof domain === 'string' && DOMAIN.test(domain)) this.domains.add(domain)
        }
        for (const cookie of Array.isArray(record.cookies) ? record.cookies.filter(isWritten) : []) {
          this.written.set(keyOf(cookie), cookie)
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn('[EnterpriseIdentity] Browser cookie record unreadable; starting over')
      }
      await this.removeWritten()
    })()
  }

  private async fetch(): Promise<void> {
    const provider = this.provider
    const person = this.person
    if (!provider?.browserCookies || !person) return
    const generation = this.generation
    this.pending = true
    try {
      const raw = await provider.browserCookies()
      if (generation !== this.generation) return
      const cookies = validBrowserCookies(raw, this.now())
      if (!cookies) throw new Error('Invalid browser cookies')
      await this.serialize(async () => {
        if (generation !== this.generation) return
        await this.replace(createHash('sha256').update(`${this.salt}\u0000${person}`).digest('hex'), cookies)
      })
      if (generation !== this.generation) return
      this.failures = 0
      const earliest = Math.min(...cookies.map(cookie => Math.min(cookie.expiresAt, this.now() + MAX_LIFETIME_MS)))
      const remaining = earliest - this.now()
      this.refreshAt = Number.isFinite(earliest)
        ? this.now() + Math.max(1, remaining - Math.min(this.options.refreshMarginMs ?? 60_000, remaining / 2))
        : undefined
      this.log.info('[EnterpriseIdentity] Browser sign-in updated', { cookies: cookies.length })
    } catch {
      if (generation !== this.generation) return
      const delay = RETRY_MS[this.failures++]
      this.refreshAt = delay === undefined ? undefined : this.now() + delay
      this.log.warn('[EnterpriseIdentity] Could not update browser sign-in', { attempt: this.failures })
    } finally {
      // An outdated answer still ends this fetch; the timer then serves whatever basis replaced it.
      this.pending = false
      this.arm()
    }
  }

  private async replace(subject: string, cookies: Array<Required<OrgBrowserCookie>>): Promise<void> {
    if (this.subject !== undefined && this.subject !== subject) {
      await this.removeWritten()
      for (const domain of this.domains) await this.clearDomain(domain)
      this.domains.clear()
      this.log.info('[EnterpriseIdentity] Ended the previous person\'s organization page sessions')
    }
    this.subject = subject
    const next = new Map(cookies.map(cookie => [keyOf(cookie), cookie] as const))
    for (const [key, cookie] of [...this.written]) {
      if (next.has(key) && next.get(key)!.secure === cookie.secure) continue
      await this.remove(key, cookie)
    }
    for (const [key, cookie] of next) {
      this.written.set(key, { domain: cookie.domain, path: cookie.path, name: cookie.name, secure: cookie.secure })
      this.domains.add(cookie.domain)
    }
    // Recorded before writing, so a crash between the two still leaves the names to clean up.
    await this.record()
    const store = this.options.store()
    for (const cookie of next.values()) {
      await store.set({
        url: urlOf(cookie),
        name: cookie.name,
        value: cookie.value,
        // A leading dot covers subdomains; a bare host stays host-only.
        ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: Math.floor(Math.min(cookie.expiresAt, this.now() + MAX_LIFETIME_MS) / 1000),
      })
    }
  }

  private async removeWritten(): Promise<void> {
    for (const [key, cookie] of [...this.written]) await this.remove(key, cookie)
    await this.record()
  }

  private async remove(key: string, cookie: Written): Promise<void> {
    try {
      await this.options.store().remove(urlOf(cookie), cookie.name)
      this.written.delete(key)
    } catch {
      this.log.error('[EnterpriseIdentity] Could not remove a browser sign-in cookie')
    }
  }

  private async clearDomain(domain: string): Promise<void> {
    const store = this.options.store()
    const bare = domain.replace(/^\./, '')
    try {
      for (const cookie of await store.get({ domain: bare })) {
        const host = (cookie.domain ?? bare).replace(/^\./, '')
        await store.remove(`${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`, cookie.name)
      }
    } catch {
      this.log.error('[EnterpriseIdentity] Could not end the organization page sessions in the browser')
    }
  }

  private async record(): Promise<void> {
    const file = this.options.recordFile
    try {
      if (this.subject === undefined && this.written.size === 0 && this.domains.size === 0) {
        await fsp.rm(file, { force: true })
        return
      }
      const record: CookieRecord = {
        salt: this.salt,
        ...(this.subject ? { subject: this.subject } : {}),
        domains: [...this.domains],
        cookies: [...this.written.values()],
      }
      await fsp.mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.tmp`
      await fsp.writeFile(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' })
      await fsp.rename(temporary, file)
    } catch {
      this.log.warn('[EnterpriseIdentity] Could not record browser sign-in cookies')
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.disposed || this.pending || this.refreshAt === undefined) return
    const delay = Math.min(Math.max(0, this.refreshAt - this.now()), MAX_TIMER_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.pending && this.basis !== null) void this.fetch()
    }, delay)
    this.timer.unref?.()
  }
}

function isWritten(value: unknown): value is Written {
  const cookie = value as Partial<Written> | null
  return !!cookie && typeof cookie.domain === 'string' && DOMAIN.test(cookie.domain) &&
    typeof cookie.name === 'string' && TOKEN.test(cookie.name) &&
    typeof cookie.path === 'string' && PATH.test(cookie.path) && typeof cookie.secure === 'boolean'
}
