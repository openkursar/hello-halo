/**
 * Response sanitization for the self-API listener. Keys must survive
 * (a missing key reads to the agent as "does not exist"); only leaf values
 * of secret-shaped fields are replaced. `tokenCount`/`tokensUsed`-style
 * usage figures must not be caught by the substring match on "token".
 */

import { describe, it, expect } from 'vitest'

import { redactValue, redactResponses } from '../../../../src/main/http/self-api/redact'

describe('redactValue', () => {
  it('redacts every leaf of userConfig/env/headers but keeps their keys', () => {
    const input = {
      userConfig: { github_repo: 'openkursar/hello-halo', api_key: 'sk-abc123' },
      spec: {
        mcp_server: {
          env: { GITHUB_TOKEN: 'ghp_xxx' },
          headers: { Authorization: 'Bearer xyz' },
        },
      },
    }
    const out = redactValue(input) as any

    expect(out.userConfig.github_repo).toBe('[redacted]')
    expect(out.userConfig.api_key).toBe('[redacted]')
    expect(Object.keys(out.userConfig)).toEqual(['github_repo', 'api_key'])
    expect(out.spec.mcp_server.env.GITHUB_TOKEN).toBe('[redacted]')
    expect(out.spec.mcp_server.headers.Authorization).toBe('[redacted]')
  })

  it('redacts a WeCom bot scan-auth poll response (botId + secret)', () => {
    // POST /api/wecom-bot/scan-auth/poll — botId is a long-lived identity
    // paired 1:1 with secret; the module's own log redaction already treats
    // it as sensitive, so the HTTP layer must too.
    const input = { success: true, data: { botId: 'wb_abc123', secret: 'sk_xyz' } }
    const out = redactValue(input) as any

    expect(out.data.botId).toBe('[redacted]')
    expect(out.data.secret).toBe('[redacted]')
  })

  it('redacts exact and substring secret-shaped scalar keys case-insensitively', () => {
    const input = {
      password: 'hunter2',
      ApiKey: 'sk-1',
      githubAccessToken: 'ghp_yyy',
      webhookSecret: 'whsec_1',
      nested: { Cookie: 'session=1' },
    }
    const out = redactValue(input) as any

    expect(out.password).toBe('[redacted]')
    expect(out.ApiKey).toBe('[redacted]')
    expect(out.githubAccessToken).toBe('[redacted]')
    expect(out.webhookSecret).toBe('[redacted]')
    expect(out.nested.Cookie).toBe('[redacted]')
  })

  it('does not redact tokenCount/tokensUsed-style usage figures', () => {
    const input = { tokenCount: 1234, tokensUsed: 5678, data: { tokenCount: 1 } }
    const out = redactValue(input) as any

    expect(out.tokenCount).toBe(1234)
    expect(out.tokensUsed).toBe(5678)
    expect(out.data.tokenCount).toBe(1)
  })

  it('leaves unrelated fields untouched', () => {
    const input = { id: 'ap_1', status: 'active', count: 3 }
    expect(redactValue(input)).toEqual(input)
  })
})

describe('redactResponses middleware', () => {
  function fakeRes() {
    const res: any = {
      statusCode: 200,
      sent: undefined,
      status(code: number) {
        res.statusCode = code
        return res
      },
      json(body: unknown) {
        res.sent = body
        return res
      },
    }
    return res
  }

  it('redacts the body before it reaches the original res.json', () => {
    const res = fakeRes()
    redactResponses({} as any, res, () => {})
    res.json({ password: 'hunter2', id: 'x' })

    expect(res.sent).toEqual({ password: '[redacted]', id: 'x' })
  })

  it('fails closed: never sends the original body if redaction throws', () => {
    const res = fakeRes()
    redactResponses({} as any, res, () => {})

    const originalEntries = Object.entries
    Object.entries = () => {
      throw new Error('boom')
    }
    try {
      res.json({ password: 'hunter2' })
    } finally {
      Object.entries = originalEntries
    }

    expect(res.statusCode).toBe(500)
    expect(res.sent).toEqual({ success: false, error: 'Internal error while preparing response' })
  })
})
