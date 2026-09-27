/**
 * platform/memory -- Permission Enforcement
 *
 * Who may write which memory through this module's own writers. The agent's
 * file tools are held to the same boundaries by the write guard (guard.ts).
 *
 *   Caller    Scope     Write
 *   ------    -----     -----
 *   user      user      YES
 *   user      space     YES
 *   user      app       NO
 *   app(A)    user      NO
 *   app(A)    space     NO   (a digital human may only read space memory)
 *   app(A)    app(A)    YES
 *   app(A)    app(B)    NO   (structurally: paths resolve from caller.appId)
 */

import type { MemoryCallerScope, MemoryScopeType } from './types'

/** @throws MemoryPermissionError when the caller may not write the scope */
export function assertWritePermission(caller: MemoryCallerScope, scope: MemoryScopeType): void {
  if (caller.type === 'user') {
    if (scope === 'app') {
      throw new MemoryPermissionError(
        'User sessions cannot write to app memory. Only the owning app can modify its private memory.'
      )
    }
    return
  }

  if (scope === 'user') {
    throw new MemoryPermissionError('Apps cannot write to user memory. User memory is read-only for apps.')
  }
  if (scope === 'space') {
    throw new MemoryPermissionError('Apps cannot write to space memory. Space memory is read-only for apps.')
  }
}

export class MemoryPermissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemoryPermissionError'
  }
}
