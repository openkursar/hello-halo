import { describe, it, expect, vi, beforeEach } from 'vitest'

interface QueuedResponse {
  status: number
  body: unknown
  /** Simulate a transport-level failure instead of a response. */
  networkError?: string
  /** Simulate a request that never answers, so the deadline fires. */
  hang?: boolean
  /** Throw this exact value, for errors that carry a `cause`. */
  throwValue?: unknown
}

const httpState = {
  queue: [] as QueuedResponse[],
  requests: [] as { url: string; params: URLSearchParams }[],
}

// The module talks to Feishu through Halo's proxy-aware fetch, so that is what
// the test replaces — a machine whose route to Feishu is a proxy is the normal
// case this indirection exists for.
vi.mock('../../../../../src/main/services/proxy-fetch', () => ({
  proxyFetch: async (url: string, init?: RequestInit) => {
    httpState.requests.push({
      url,
      params: new URLSearchParams(String(init?.body ?? '')),
    })
    const next = httpState.queue.shift()
    if (!next) throw new Error('no queued response')
    if (next.hang) {
      // Resolve only when the caller's deadline aborts the request.
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
    if (next.throwValue) throw next.throwValue
    if (next.networkError) throw new Error(next.networkError)
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  },
}))

vi.mock('../../../../../src/main/foundation/product-config', () => ({
  loadProductConfig: () => ({ name: 'Halo' }),
}))

const zlib = await import('zlib')

const {
  BOT_MINIMUM_ADDONS,
  beginRegistration,
  pollRegistration,
  buildDefaultAppPreset,
  FeishuScanAuthError,
} = await import('../../../../../src/main/apps/runtime/im-channels/feishu-bot-scan-auth')

function queue(...responses: QueuedResponse[]): void {
  httpState.queue.push(...responses)
}

const BEGIN_OK = {
  status: 200,
  body: {
    device_code: 'dev-code-1',
    verification_uri_complete: 'https://accounts.feishu.cn/open-apis/oauth/page/launcher?user_code=ABCD-1234',
    interval: 1,
    expires_in: 600,
  },
}

beforeEach(() => {
  httpState.queue = []
  httpState.requests = []
})

describe('beginRegistration', () => {
  it('requests the PersonalAgent archetype and returns the poll parameters', async () => {
    queue(BEGIN_OK)
    const result = await beginRegistration()

    expect(httpState.requests).toHaveLength(1)
    const [req] = httpState.requests
    expect(req.url).toBe('https://accounts.feishu.cn/oauth/v1/app/registration')
    expect(req.params.get('action')).toBe('begin')
    expect(req.params.get('archetype')).toBe('PersonalAgent')
    expect(req.params.get('auth_method')).toBe('client_secret')

    expect(result.deviceCode).toBe('dev-code-1')
    expect(result.host).toBe('accounts.feishu.cn')
    expect(result.intervalMs).toBe(1000)
    expect(result.expiresInMs).toBe(600_000)
  })

  it('decorates the QR URL with createOnly and the prefill', async () => {
    queue(BEGIN_OK)
    const { authUrl } = await beginRegistration({ name: 'Halo', desc: 'Halo assistant' })
    const url = new URL(authUrl)

    // createOnly is what stops the landing page from offering an existing app.
    expect(url.searchParams.get('createOnly')).toBe('true')
    expect(url.searchParams.get('name')).toBe('Halo')
    expect(url.searchParams.get('desc')).toBe('Halo assistant')
    // The server's own params must survive decoration.
    expect(url.searchParams.get('user_code')).toBe('ABCD-1234')
  })

  it('asks for only the scopes the bot actually uses', async () => {
    // Review exemption hinges on the requested permissions staying inside what
    // the admin allows, so asking for the platform's 35-scope agent template
    // would push every install into an approval queue for capabilities this
    // provider never calls.
    queue(BEGIN_OK)
    const { authUrl } = await beginRegistration()
    const encoded = new URL(authUrl).searchParams.get('addons')
    expect(encoded).toBeTruthy()

    // Same pipeline the platform fixes: gzip → base64 → URL-safe → unpadded.
    const b64 = encoded!.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = JSON.parse(
      zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'),
    )

    expect(decoded.preset).toBe(false)
    expect(decoded.scopes.tenant).toEqual([...BOT_MINIMUM_ADDONS.scopes.tenant])
    expect(decoded.events.items.tenant).toEqual(['im.message.receive_v1'])
    // The sensitive one always triggers review, so it is never requested for
    // the user — they turn it on themselves in the Feishu console.
    expect(decoded.scopes.tenant).not.toContain('im:message.group_msg')
  })

  it('requests nothing beyond messaging, media and cards', () => {
    // A scope creeping in here silently costs every user an approval round.
    expect([...BOT_MINIMUM_ADDONS.scopes.tenant].sort()).toEqual([
      'cardkit:card:read',
      'cardkit:card:write',
      // Contacts: the only way to label a one-to-one chat with a person.
      'contact:contact.base:readonly',
      'contact:user.base:readonly',
      'im:chat:read',
      'im:message.group_at_msg:readonly',
      'im:message.p2p_msg:readonly',
      // Receiving an event is not reading the file it carries: without this,
      // every inbound image and file download is refused.
      'im:message:readonly',
      'im:message:send_as_bot',
      'im:resource',
    ])
  })

  it('caps avatar candidates at the six Feishu accepts', async () => {
    queue(BEGIN_OK)
    const avatars = Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.png`)
    const { authUrl } = await beginRegistration({ avatar: avatars })
    expect(new URL(authUrl).searchParams.getAll('avatar')).toHaveLength(6)
  })

  it('accepts a Lark-hosted verification URI', async () => {
    queue({
      status: 200,
      body: {
        device_code: 'dev-code-1',
        verification_uri_complete: 'https://accounts.larksuite.com/oauth/page?user_code=X',
      },
    })
    const { authUrl } = await beginRegistration()
    expect(new URL(authUrl).host).toBe('accounts.larksuite.com')
  })

  it('refuses to build a QR code for a non-https verification URI', async () => {
    queue({
      status: 200,
      body: {
        device_code: 'dev-code-1',
        verification_uri_complete: 'http://accounts.feishu.cn/oauth/page?user_code=X',
      },
    })
    await expect(beginRegistration()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('refuses to build a QR code for a verification URI outside the official hosts', async () => {
    // The URI comes back over TLS from a request we initiated, but it ends up
    // in a QR code the user is told to scan — never encode a foreign host.
    for (const uri of [
      'https://evil.example.com/oauth/page?user_code=X',
      'https://accounts.feishu.cn.evil.example.com/page',
      'not a url',
    ]) {
      httpState.queue = []
      queue({
        status: 200,
        body: { device_code: 'dev-code-1', verification_uri_complete: uri },
      })
      await expect(beginRegistration()).rejects.toMatchObject({ kind: 'invalid-response' })
    }
  })

  it('rejects a response without a device code', async () => {
    queue({ status: 200, body: { verification_uri_complete: 'https://accounts.feishu.cn/x' } })
    await expect(beginRegistration()).rejects.toMatchObject({ kind: 'invalid-response' })
  })

  it('surfaces the underlying cause, not a bare "fetch failed"', async () => {
    // A refused proxy CONNECT reaches us wrapped: the cause is the only part
    // that tells the user which hop is broken.
    const wrapped = new Error('fetch failed')
    wrapped.cause = new Error('connect ECONNREFUSED 127.0.0.1:7890')
    queue({ status: 0, body: null, throwValue: wrapped })

    const err = await beginRegistration().catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/Cannot reach accounts\.feishu\.cn/)
    expect((err as Error).message).toMatch(/ECONNREFUSED/)
    expect((err as InstanceType<typeof FeishuScanAuthError>).detail).toMatch(/proxy/i)
  })

  it('explains a dead route instead of reporting a bare read timeout', async () => {
    // The failure a proxied machine actually hits: the request is accepted and
    // nothing ever comes back, so the deadline is the only thing that fires.
    vi.useFakeTimers()
    try {
      queue({ status: 0, body: null, hang: true })
      const pending = beginRegistration().catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(20_000)
      const err = await pending

      expect(err).toBeInstanceOf(FeishuScanAuthError)
      expect((err as InstanceType<typeof FeishuScanAuthError>).kind).toBe('network')
      expect((err as Error).message).toMatch(/No response from accounts\.feishu\.cn/)
      expect((err as InstanceType<typeof FeishuScanAuthError>).detail).toMatch(/proxy/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('presets a name from the product config', () => {
    expect(buildDefaultAppPreset().name).toBe('Halo')
  })
})

describe('pollRegistration', () => {
  const pollOpts = (signal: AbortSignal) => ({
    signal,
    host: 'accounts.feishu.cn',
    intervalMs: 1,
    timeoutMs: 5_000,
  })

  it('keeps polling through authorization_pending and returns the credentials', async () => {
    queue(
      { status: 400, body: { error: 'authorization_pending' } },
      {
        status: 200,
        body: {
          client_id: 'cli_a1b2c3d4e5f60718',
          client_secret: 'super-secret',
          user_info: { open_id: 'ou_123', tenant_brand: 'feishu' },
        },
      },
    )
    const creds = await pollRegistration('dev-code-1', pollOpts(new AbortController().signal))

    expect(creds).toEqual({
      appId: 'cli_a1b2c3d4e5f60718',
      appSecret: 'super-secret',
      tenantBrand: 'feishu',
      openId: 'ou_123',
    })
    expect(httpState.requests).toHaveLength(2)
    expect(httpState.requests[0].params.get('action')).toBe('poll')
    expect(httpState.requests[0].params.get('device_code')).toBe('dev-code-1')
  })

  it('switches to the Lark host and reports the brand', async () => {
    queue(
      { status: 200, body: { user_info: { tenant_brand: 'lark' } } },
      {
        status: 200,
        body: { client_id: 'cli_a1b2c3d4e5f60718', client_secret: 's', user_info: { tenant_brand: 'lark' } },
      },
    )
    const creds = await pollRegistration('dev-code-1', pollOpts(new AbortController().signal))

    expect(creds.tenantBrand).toBe('lark')
    expect(httpState.requests[0].url).toContain('accounts.feishu.cn')
    expect(httpState.requests[1].url).toContain('accounts.larksuite.com')
  })

  it('maps expired_token to kind=expired', async () => {
    queue({ status: 400, body: { error: 'expired_token' } })
    await expect(
      pollRegistration('dev-code-1', pollOpts(new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'expired' })
  })

  it('maps access_denied to kind=denied', async () => {
    queue({ status: 400, body: { error: 'access_denied', error_description: 'user declined' } })
    await expect(
      pollRegistration('dev-code-1', pollOpts(new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'denied' })
  })

  it('tolerates two transient network failures and gives up on the third', async () => {
    queue(
      { status: 0, body: null, networkError: 'ECONNRESET' },
      { status: 0, body: null, networkError: 'ECONNRESET' },
      { status: 0, body: null, networkError: 'ECONNRESET' },
    )
    await expect(
      pollRegistration('dev-code-1', pollOpts(new AbortController().signal)),
    ).rejects.toMatchObject({ kind: 'network' })
    expect(httpState.requests).toHaveLength(3)
  })

  it('stops on abort', async () => {
    const controller = new AbortController()
    queue({ status: 400, body: { error: 'authorization_pending' } })
    const promise = pollRegistration('dev-code-1', {
      signal: controller.signal,
      host: 'accounts.feishu.cn',
      intervalMs: 50,
      timeoutMs: 5_000,
    })
    controller.abort()
    await expect(promise).rejects.toBeInstanceOf(FeishuScanAuthError)
    await expect(promise).rejects.toMatchObject({ kind: 'cancelled' })
  })

  it('times out when the window elapses', async () => {
    await expect(
      pollRegistration('dev-code-1', {
        signal: new AbortController().signal,
        host: 'accounts.feishu.cn',
        intervalMs: 1,
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' })
  })
})
