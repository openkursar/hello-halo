/**
 * Device Identity — persistent per-installation identity (foundation tier).
 *
 * A `{ deviceId, deviceSecret }` pair generated once and persisted in
 * config.json. The pair is the device's long-lived anchor toward external
 * services: the same identity always resolves to the same externally
 * issued resources (e.g. the fixed remote-access hostname granted by the
 * tunnel issuer). The secret proves ownership of the deviceId on re-issue
 * and revoke, so knowing a deviceId alone cannot hijack its resources.
 */

import { randomUUID, randomBytes } from 'crypto'
import { getConfig, saveConfig } from './config.service'

export interface DeviceIdentity {
  /** UUID v4, lowercase */
  deviceId: string
  /** 64 hex chars (32 random bytes) */
  deviceSecret: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SECRET_RE = /^[0-9a-f]{64}$/

/**
 * Get the persistent device identity, generating and persisting it on
 * first access.
 */
export function getDeviceIdentity(): DeviceIdentity {
  const existing = getConfig().deviceIdentity
  if (existing && isValidIdentity(existing)) {
    return existing
  }

  const identity: DeviceIdentity = {
    deviceId: randomUUID(),
    deviceSecret: randomBytes(32).toString('hex'),
  }
  saveConfig({ deviceIdentity: identity })
  console.log(`[DeviceIdentity] Generated new device identity: ${identity.deviceId}`)
  return identity
}

function isValidIdentity(identity: DeviceIdentity): boolean {
  return (
    typeof identity.deviceId === 'string' &&
    UUID_RE.test(identity.deviceId) &&
    typeof identity.deviceSecret === 'string' &&
    SECRET_RE.test(identity.deviceSecret)
  )
}
