# AI Source Provider Development Guide

This guide explains how to create a custom AI source provider for Halo.

## Quick Start

```typescript
// Import from @shared (path alias configured in tsconfig)
import type { AISourceProvider, OAuthAISourceProvider, ProviderResult } from '@shared/interfaces'
import type { AISourcesConfig, BackendRequestConfig, OAuthStartResult, OAuthCompleteResult } from '@shared/types'
```

## Provider Types

### 1. Basic Provider (`AISourceProvider`)

For simple API key-based providers:

```typescript
interface AISourceProvider {
  readonly type: string           // Unique ID (e.g., 'custom', 'myapi')
  readonly displayName: string    // Display name (e.g., 'My API')

  isConfigured(config: AISourcesConfig): boolean
  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null
  getCurrentModel(config: AISourcesConfig): string | null
  getAvailableModels(config: AISourcesConfig): Promise<string[]>
  refreshConfig?(config: AISourcesConfig): Promise<ProviderResult<Partial<AISourcesConfig>>>
}
```

### 2. OAuth Provider (`OAuthAISourceProvider`)

For providers requiring OAuth login:

```typescript
interface OAuthAISourceProvider extends AISourceProvider {
  // OAuth methods
  startLogin(): Promise<ProviderResult<OAuthStartResult>>
  completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>>
  refreshToken(): Promise<ProviderResult<void>>
  checkToken(): Promise<ProviderResult<{ valid: boolean; expiresIn?: number }>>
  logout(): Promise<ProviderResult<void>>

  // User info
  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null

  // Optional: metered quota (see below)
  getQuota?(config: AISourcesConfig): Promise<ProviderResult<AuthQuotaSnapshot>>
}
```

#### Optional: `getQuota?` (metered quota)

Implement `getQuota` when your service exposes a spendable balance (credits,
subscription quota, a wallet, ...) that should surface in the app header. The
provider queries its own server and translates the result into the uniform
`AuthQuotaSnapshot` view-model; the renderer only draws it. Providers that omit
this method have no quota concept and no quota UI is shown — this is the default.

Quota is an OAuth-provider capability: only a managed provider that owns its
server can report a spendable balance. API-key sources are arbitrary
OpenAI-compatible gateways with no quota concept, so `getQuota` lives on
`OAuthAISourceProvider` rather than the base interface.

```typescript
interface AuthQuotaSnapshot {
  remaining: number                                  // number shown on the pill
  total: number                                      // progress = remaining / total
  used: number
  unit?: LocalizedText                               // suffix label, e.g. { en: 'credits', 'zh-CN': '积分' }
  symbol?: string                                    // currency prefix, e.g. "$" (mutually exclusive with unit)
  nextResetTime?: number                             // epoch seconds; renders a countdown
  segments?: { label: LocalizedText; value: number }[] // breakdown rows in the popover
  detailsUrl?: string                                // external top-up page (system browser)
  detailsLabel?: LocalizedText                       // button label for detailsUrl
}
```

The manager renews an expired OAuth token before calling `getQuota`, so the
`config` you receive already carries a valid, decrypted access token. On failure
return `{ success: false, error }` — the app keeps the previous value and marks
it stale rather than surfacing an error.

## Required Types Reference

### `ProviderResult<T>`

Standard return type for async operations:

```typescript
interface ProviderResult<T> {
  success: boolean
  data?: T
  error?: string
}
```

### `BackendRequestConfig`

Configuration for making API requests (used by OpenAI compat router):

```typescript
interface BackendRequestConfig {
  url: string                              // API endpoint
  key: string                              // API key or access token
  model?: string                           // Model ID
  headers?: Record<string, string>         // Custom headers
  apiType?: 'chat_completions' | 'responses'
}
```

### `OAuthStartResult`

```typescript
interface OAuthStartResult {
  loginUrl: string    // URL to open in browser
  state: string       // State for tracking login flow
}
```

### `OAuthCompleteResult`

```typescript
interface OAuthCompleteResult {
  success: boolean
  user?: AISourceUserInfo
  error?: string
}
```

### `AISourceUserInfo`

```typescript
interface AISourceUserInfo {
  name: string
  avatar?: string
  uid?: string        // User ID (for API headers)
}
```

## Minimal Implementation Example

### API Key Provider

```typescript
import type { AISourceProvider, ProviderResult } from '@shared/interfaces'
import type { AISourcesConfig, BackendRequestConfig } from '@shared/types'

export class MyApiProvider implements AISourceProvider {
  readonly type = 'myapi'
  readonly displayName = 'My API'

  isConfigured(config: AISourcesConfig): boolean {
    const myConfig = config['myapi'] as any
    return !!myConfig?.apiKey
  }

  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const myConfig = config['myapi'] as any
    if (!myConfig?.apiKey) return null

    return {
      url: 'https://api.myservice.com/v1/chat/completions',
      key: myConfig.apiKey,
      model: myConfig.model || 'default-model'
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    const myConfig = config['myapi'] as any
    return myConfig?.model || null
  }

  async getAvailableModels(): Promise<string[]> {
    return ['model-a', 'model-b', 'model-c']
  }
}

// Export getter function (required for dynamic loading)
export function getMyApiProvider(): MyApiProvider {
  return new MyApiProvider()
}
```

### OAuth Provider

```typescript
import type { OAuthAISourceProvider, ProviderResult } from '@shared/interfaces'
import type {
  AISourcesConfig,
  BackendRequestConfig,
  OAuthStartResult,
  OAuthCompleteResult,
  AISourceUserInfo
} from '@shared/types'

export class MyOAuthProvider implements OAuthAISourceProvider {
  readonly type = 'myoauth'
  readonly displayName = 'My OAuth Service'

  // ========== AISourceProvider Methods ==========

  isConfigured(config: AISourcesConfig): boolean {
    const myConfig = config['myoauth'] as any
    return myConfig?.loggedIn === true
  }

  getBackendConfig(config: AISourcesConfig): BackendRequestConfig | null {
    const myConfig = config['myoauth'] as any
    if (!myConfig?.loggedIn || !myConfig.accessToken) return null

    return {
      url: 'https://api.myservice.com/chat',
      key: myConfig.accessToken,
      model: myConfig.model || 'default-model',
      headers: {
        'X-Custom-Header': 'value'
      }
    }
  }

  getCurrentModel(config: AISourcesConfig): string | null {
    return (config['myoauth'] as any)?.model || null
  }

  async getAvailableModels(config: AISourcesConfig): Promise<string[]> {
    // Fetch from API or return static list
    return ['model-a', 'model-b']
  }

  getUserInfo(config: AISourcesConfig): AISourceUserInfo | null {
    const myConfig = config['myoauth'] as any
    if (!myConfig?.loggedIn || !myConfig.user) return null
    return { name: myConfig.user.name, avatar: myConfig.user.avatar }
  }

  // ========== OAuth Methods ==========

  async startLogin(): Promise<ProviderResult<OAuthStartResult>> {
    // 1. Generate state token
    // 2. Get login URL from your OAuth server
    // 3. Open URL in external browser
    const state = crypto.randomUUID()
    const loginUrl = `https://auth.myservice.com/login?state=${state}`

    // Open in browser
    const { shell } = require('electron')
    shell.openExternal(loginUrl)

    return {
      success: true,
      data: { loginUrl, state }
    }
  }

  async completeLogin(state: string): Promise<ProviderResult<OAuthCompleteResult>> {
    // Poll for token completion or use callback
    // Return user info and token data

    // The manager will save _tokenData to config
    return {
      success: true,
      data: {
        success: true,
        user: { name: 'User Name' },
        // Additional data for config update
        _tokenData: {
          accessToken: 'xxx',
          refreshToken: 'xxx',
          expiresAt: Date.now() + 86400000
        },
        _availableModels: ['model-a', 'model-b'],
        _defaultModel: 'model-a'
      } as any
    }
  }

  async refreshToken(): Promise<ProviderResult<void>> {
    return { success: true }
  }

  async checkToken(): Promise<ProviderResult<{ valid: boolean; expiresIn?: number }>> {
    return { success: true, data: { valid: true } }
  }

  async logout(): Promise<ProviderResult<void>> {
    return { success: true }
  }
}

// Export getter function
export function getMyOAuthProvider(): MyOAuthProvider {
  return new MyOAuthProvider()
}
```

## Registering Your Provider

### 1. Create provider in `auth/`

```
auth/
└── src/
    └── providers/
        └── myprovider/
            ├── index.ts           # Export entry
            ├── myprovider.ts      # Implementation
            └── types.ts           # Provider-specific types
```

### 2. Configure in `product.json`

```json
{
  "authProviders": [
    {
      "type": "myprovider",
      "displayName": "My Provider",
      "description": "My custom AI provider",
      "icon": "globe",
      "iconBgColor": "#3b82f6",
      "recommended": false,
      "path": "./auth/dist/providers/myprovider/index.js",
      "enabled": true
    }
  ]
}
```

### 3. Export Pattern

Your `index.ts` must export either:

```typescript
// Option A: Getter function (recommended)
export function getMyProvider(): MyProvider { ... }

// Option B: Class export
export class MyProvider implements AISourceProvider { ... }
```

## Type Check Helper

```typescript
import { isOAuthProvider } from '@shared/interfaces'

// Check if a provider supports OAuth
if (isOAuthProvider(provider)) {
  // provider has OAuth methods
  await provider.startLogin()
}
```

## File Locations

| File | Description |
|------|-------------|
| `src/shared/interfaces/ai-source-provider.ts` | Provider interfaces |
| `src/shared/types/ai-sources.ts` | Type definitions |
| `src/shared/index.ts` | Unified exports |

## i18n Support

Provider `displayName` and `description` from `product.json` are passed through `t()` translation function. Add translations in:

- `src/renderer/i18n/locales/en.json`
- `src/renderer/i18n/locales/zh-CN.json`
