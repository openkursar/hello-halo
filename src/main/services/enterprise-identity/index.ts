import { randomUUID } from 'crypto'
import { app, powerMonitor } from 'electron'
import { promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import type { EnterpriseIdentityProvider } from '../../../shared/interfaces/enterprise-identity-provider'
import { resolveLocalizedText } from '../../../shared/types/ai-sources'
import type { OrgSignInResult, OrgSignInState } from '../../../shared/types/enterprise-identity'
import { getEnterpriseIdentityConfig, getProductConfigPath } from '../../foundation/product-config'
import { openLoginWindow } from '../login-window'
import { EnterpriseIdentityService, toolCredentialBindings, type ToolCredentialBinding } from './service'

export interface EnterpriseIdentityHostOptions {
  credentialDir: string
  onDidChange: (state: OrgSignInState) => void
}

const UNCONFIGURED: OrgSignInState = {
  status: 'unconfigured', capabilities: [], boundTools: [], signingIn: false, canUnbindDevice: false,
}

let hostOptions: EnterpriseIdentityHostOptions | undefined
let service: EnterpriseIdentityService | undefined
let leftovers: Promise<boolean> | undefined
let stopHostListeners: (() => void) | undefined

async function clearLeftoverCredentials(dir: string): Promise<boolean> {
  try {
    await fsp.rm(dir, { recursive: true, force: true })
    return true
  } catch {
    // An existing launcher still resolves the old path even if the provider has not been loaded.
    const retired = `${dir}.${randomUUID()}.retired`
    try {
      await fsp.rename(dir, retired)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      console.error('[EnterpriseIdentity] Could not detach credentials left by the previous run')
      return false
    }
    try {
      await fsp.rm(retired, { recursive: true, force: true })
    } catch {
      console.error('[EnterpriseIdentity] Could not delete detached credentials left by the previous run')
    }
    return true
  }
}

export function initEnterpriseIdentity(options: EnterpriseIdentityHostOptions): void {
  if (!getEnterpriseIdentityConfig()) return
  hostOptions = options
  leftovers = clearLeftoverCredentials(options.credentialDir)
}

export function getToolCredentialBindings(): ToolCredentialBinding[] {
  const config = getEnterpriseIdentityConfig()
  if (!config || !hostOptions) return []
  return toolCredentialBindings(config.toolCredentials, hostOptions.credentialDir)
}

async function loadProvider(modulePath: string): Promise<EnterpriseIdentityProvider | null> {
  const file = join(dirname(getProductConfigPath()), modulePath)
  const mod = await import(pathToFileURL(file).href) as Record<string, unknown>
  const getter = Object.keys(mod).find(key => key.startsWith('get') && key.endsWith('Provider') && typeof mod[key] === 'function')
  if (!getter) {
    console.error('[EnterpriseIdentity] Provider module exports no get…Provider()')
    return null
  }
  return (mod[getter] as () => EnterpriseIdentityProvider)()
}

function getService(): EnterpriseIdentityService | undefined {
  if (service) return service
  const config = getEnterpriseIdentityConfig()
  if (!config || !hostOptions) return undefined
  const identityCredentialDir = hostOptions.credentialDir
  const identity = new EnterpriseIdentityService({
    name: config.name ? resolveLocalizedText(config.name, app.getLocale()) : undefined,
    bindings: config.toolCredentials ?? [],
    credentialDir: identityCredentialDir,
    loadProvider: () => loadProvider(config.provider),
    openWindow: openLoginWindow,
    prepareCredentials: () => {
      const cleanup = leftovers ?? clearLeftoverCredentials(identityCredentialDir)
      leftovers = undefined
      return cleanup
    },
  })
  const changes = identity.onDidChange(hostOptions.onDidChange)
  const resume = () => void identity.verify()
  powerMonitor.on('resume', resume)
  stopHostListeners = () => {
    changes.dispose()
    powerMonitor.removeListener('resume', resume)
  }
  service = identity
  return service
}

export function getEnterpriseIdentityState(): OrgSignInState {
  return getService()?.getState() ?? peekEnterpriseIdentityState()
}

export function peekEnterpriseIdentityState(): OrgSignInState {
  if (service) return service.peekState()
  if (!getEnterpriseIdentityConfig()) return UNCONFIGURED
  return hostOptions
    ? { ...UNCONFIGURED, status: 'loading' }
    : { ...UNCONFIGURED, status: 'unavailable', unavailableReason: 'temporary' }
}

/**
 * Applies the organization's session variables to a user session or terminal
 * environment. Reads memory only; an unsigned-in or unconfigured build adds nothing.
 * Returns what was applied, so a session can tell when it needs rebuilding.
 */
export function applyOrgSessionEnv(env: Record<string, string | undefined>): string {
  const extra = service?.sessionEnvironment() ?? {}
  const names = Object.keys(extra).sort()
  for (const name of names) env[name] = extra[name]
  return names.map(name => `${name}=${extra[name]}`).join('\n')
}

export async function retryEnterpriseIdentity(): Promise<OrgSignInState> {
  return (await getService()?.retry()) ?? peekEnterpriseIdentityState()
}

export function signInEnterpriseIdentity(): Promise<OrgSignInResult> {
  return getService()?.signIn() ?? Promise.resolve('failed')
}

export async function signOutEnterpriseIdentity(scope: 'session' | 'device'): Promise<OrgSignInState> {
  return (await getService()?.signOut(scope)) ?? peekEnterpriseIdentityState()
}

export function shutdownEnterpriseIdentity(): void {
  stopHostListeners?.()
  stopHostListeners = undefined
  service?.dispose()
  service = undefined
  hostOptions = undefined
  leftovers = undefined
}
