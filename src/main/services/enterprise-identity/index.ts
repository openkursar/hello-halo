/**
 * enterprise-identity — the company sign-in a build may provide for its
 * command-line tools. Public surface only; see DESIGN.md.
 */

import { existsSync, promises as fsp } from 'fs'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { getEnterpriseIdentityConfig, getProductConfigPath } from '../../foundation/product-config'
import type { EnterpriseIdentityProvider } from '../../../shared/interfaces/enterprise-identity-provider'
import type { EnterpriseIdentityState, EnterpriseLoginPollResult } from '../../../shared/types/enterprise-identity'
import { EnterpriseIdentityService, toolCredentialBindings, type ToolCredentialBinding } from './service'

export { EnterpriseIdentityService, toolCredentialBindings, usableBindings, credentialFileOf } from './service'
export type { EnterpriseIdentityServiceOptions, EnterpriseToolBindingConfig, ToolCredentialBinding } from './service'

export interface EnterpriseIdentityHostOptions {
  /** Directory for the current credentials, e.g. `<userData>/enterprise-identity`. */
  credentialDir: string
}

const UNAVAILABLE: EnterpriseIdentityState = { status: 'unavailable', methods: [], capabilities: [], boundTools: [] }

let hostOptions: EnterpriseIdentityHostOptions | null = null
let service: EnterpriseIdentityService | null = null
let leftovers: Promise<void> = Promise.resolve()

/**
 * Records where credentials live. In a build with enterprise identity it also
 * removes credentials a previous process left behind (the session is never
 * kept across launches). The provider is loaded on first use.
 */
export function initEnterpriseIdentity(options: EnterpriseIdentityHostOptions): void {
  hostOptions = options
  if (getEnterpriseIdentityConfig()) {
    leftovers = fsp.rm(options.credentialDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Bindings for the CLI tool store; empty when the build has no enterprise identity. */
export function getToolCredentialBindings(): ToolCredentialBinding[] {
  const config = getEnterpriseIdentityConfig()
  if (!config || !hostOptions) return []
  return toolCredentialBindings(config.toolCredentials, hostOptions.credentialDir)
}

async function loadProvider(modulePath: string): Promise<EnterpriseIdentityProvider | null> {
  const clean = modulePath.startsWith('./') ? modulePath.slice(2) : modulePath
  const file = join(dirname(getProductConfigPath()), clean)
  if (!existsSync(file)) {
    console.error('[EnterpriseIdentity] Provider module not found', { file })
    return null
  }
  const mod = await import(pathToFileURL(file).href) as Record<string, unknown>
  const getter = Object.keys(mod).find(key => key.startsWith('get') && key.endsWith('Provider') && typeof mod[key] === 'function')
  if (!getter) {
    console.error('[EnterpriseIdentity] Provider module exports no get…Provider()', { file })
    return null
  }
  return (mod[getter] as () => EnterpriseIdentityProvider)()
}

function getService(): EnterpriseIdentityService | null {
  const config = getEnterpriseIdentityConfig()
  if (!config || !hostOptions) return null
  service ??= new EnterpriseIdentityService({
    bindings: config.toolCredentials ?? [],
    credentialDir: hostOptions.credentialDir,
    loadProvider: () => loadProvider(config.provider),
    ready: leftovers,
  })
  return service
}

export async function getEnterpriseIdentityState(): Promise<EnterpriseIdentityState> {
  return (await getService()?.getState()) ?? UNAVAILABLE
}

export async function beginEnterpriseLogin(methodId: string): Promise<EnterpriseIdentityState> {
  const current = getService()
  if (!current) throw new Error('Enterprise identity is not available in this build')
  return current.beginLogin(methodId)
}

export async function pollEnterpriseLogin(flowId: string): Promise<EnterpriseLoginPollResult> {
  const current = getService()
  if (!current) return { outcome: 'cancelled', state: UNAVAILABLE }
  return current.pollLogin(flowId)
}

export async function cancelEnterpriseLogin(flowId: string): Promise<EnterpriseIdentityState> {
  return (await getService()?.cancelLogin(flowId)) ?? UNAVAILABLE
}

export async function signOutEnterpriseIdentity(): Promise<EnterpriseIdentityState> {
  return (await getService()?.signOut()) ?? UNAVAILABLE
}

/** On quit: withdraw every credential. */
export function shutdownEnterpriseIdentity(): void {
  service?.dispose()
}
