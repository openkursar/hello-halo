/**
 * Remote-access auth module. Public surface used by:
 *   - src/main/http/server.ts        (login route, /api/* gate, token lifecycle)
 *   - src/main/http/websocket.ts     (WS auth)
 *   - src/main/services/remote.service.ts (persistence)
 *
 * Internal split:
 *   token-store      — in-memory credential + timing-safe compare
 *   password-policy  — complexity validator for user-chosen passwords
 *   envelope         — at-rest encoding (plain or SM4-CBC+HMAC-SM3)
 *   rate-limit       — IP / target sliding windows + lockout state
 *   audit            — JSONL audit log
 *   alert            — desktop notification on lockout
 *   middleware       — express auth gate + login handler
 */

export {
  generateAccessToken,
  restoreAccessToken,
  setCustomAccessToken,
  getAccessToken,
  clearAccessToken,
  validateToken,
  CredentialRestoreError,
} from './token-store'

export { logAuthEvent } from './audit'

export { authMiddleware, handleLogin, authenticateWebSocket } from './middleware'

export { encodeForStorage, decodeFromStorage } from '../../foundation/crypto-envelope'
