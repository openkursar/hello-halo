/**
 * Secure Storage Service
 *
 * DEPRECATED for new data - kept only for backward compatibility.
 *
 * Previously used Electron's safeStorage API to encrypt API keys and tokens.
 * This caused macOS users to see Keychain permission prompts on first launch,
 * which was confusing and hurt the user experience.
 *
 * Current behavior:
 * - encryptString(): No longer used (removed from callers)
 * - decryptString(): Still used to READ old encrypted values (enc: prefix)
 *
 * Migration strategy:
 * - Old encrypted values are decrypted on read
 * - New values are stored as plaintext
 * - Next save automatically migrates to plaintext
 *
 * Platform behavior (for reference):
 * - macOS: Uses Keychain (prompts user!)
 * - Windows: Uses DPAPI (silent)
 * - Linux: Uses libsecret
 */

import { safeStorage } from 'electron'

// Prefix to identify encrypted strings
const ENCRYPTED_PREFIX = 'enc:'

/**
 * Check if encryption is available on this platform
 * @deprecated No longer used - kept for backward compatibility
 */
export function isEncryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable()
}

/**
 * Encrypt a string value
 * @deprecated Do not use - causes Keychain prompts on macOS
 * Returns encrypted base64 string with prefix, or original value if encryption unavailable
 */
export function encryptString(value: string): string {
  if (!value) return value

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[SecureStorage] Encryption not available, storing plaintext')
    return value
  }

  try {
    const encrypted = safeStorage.encryptString(value)
    return ENCRYPTED_PREFIX + encrypted.toString('base64')
  } catch (error) {
    console.error('[SecureStorage] Encryption failed:', error)
    return value
  }
}

/**
 * Decrypt a string value
 * Handles both encrypted (with prefix) and plaintext values
 */
export function decryptString(value: string): string {
  if (!value) return value

  // Check if it's an encrypted value
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
    // Plaintext or legacy value - return as-is
    return value
  }

  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[SecureStorage] Encryption not available, cannot decrypt')
    return ''
  }

  try {
    const base64Data = value.slice(ENCRYPTED_PREFIX.length)
    const buffer = Buffer.from(base64Data, 'base64')
    return safeStorage.decryptString(buffer)
  } catch (error) {
    console.error('[SecureStorage] Decryption failed:', error)
    return ''
  }
}

/**
 * Encrypt token fields in an object
 * @deprecated Do not use - causes Keychain prompts on macOS
 * Encrypts: accessToken, refreshToken
 */
export function encryptTokens<T extends Record<string, any>>(obj: T): T {
  if (!obj) return obj

  const result = { ...obj }

  if (result.accessToken && typeof result.accessToken === 'string') {
    result.accessToken = encryptString(result.accessToken)
  }

  if (result.refreshToken && typeof result.refreshToken === 'string') {
    result.refreshToken = encryptString(result.refreshToken)
  }

  return result
}

/**
 * Decrypt token fields in an object
 * Decrypts: accessToken, refreshToken
 */
export function decryptTokens<T extends Record<string, any>>(obj: T): T {
  if (!obj) return obj

  const result = { ...obj }

  if (result.accessToken && typeof result.accessToken === 'string') {
    result.accessToken = decryptString(result.accessToken)
  }

  if (result.refreshToken && typeof result.refreshToken === 'string') {
    result.refreshToken = decryptString(result.refreshToken)
  }

  return result
}
