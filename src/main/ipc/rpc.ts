/**
 * Main-side typed RPC registrar.
 *
 * Registers `ipcMain.handle` for every method in a contract, wrapping each
 * implementation in the standard `{ success, data } | { success, error }`
 * envelope and uniform error logging — the boilerplate every hand-written
 * handler used to repeat. The `handlers` object is type-checked against the
 * contract, so a missing or mis-typed implementation is a compile error.
 */

import { ipcMain } from 'electron'
import type { RpcContract, RpcHandlers } from '../../shared/rpc/define'

/**
 * Auto-envelope registrar: the handler returns RAW data and this wraps it in
 * the standard `{ success, data } | { success, error }` envelope + uniform
 * error logging. Use for channels whose renderer consumers expect the
 * envelope (the common case).
 */
export function registerRpcHandlers<C extends RpcContract>(
  contract: C,
  handlers: RpcHandlers<C>,
  logTag: string,
): void {
  for (const name of Object.keys(contract) as (keyof C)[]) {
    const { channel } = contract[name]
    const handler = handlers[name] as (...args: unknown[]) => unknown
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return { success: true, data: await handler(...args) }
      } catch (error) {
        console.error(`[${logTag}] ${channel} error:`, error)
        return { success: false, error: String(error) }
      }
    })
  }
}

/**
 * Passthrough registrar: the handler returns the channel's EXACT result shape
 * (already an envelope, or a raw value like `true`/`void`/a service object),
 * and it is returned to the renderer unchanged. Use when migrating existing
 * handlers whose bodies must be preserved verbatim (non-uniform return
 * contracts). The contract gives the channel name + types a single source of
 * truth and lets the preload bridge be derived, without touching behavior.
 */
export function registerRawRpcHandlers<C extends RpcContract>(
  contract: C,
  // Handlers keep their own inline parameter types (lifted from the original
  // handler bodies); `any[]` here lets those typed signatures be accepted
  // without the contract having to re-declare every argument type.
  handlers: { [K in keyof C]: (...args: any[]) => unknown },
): void {
  for (const name of Object.keys(contract) as (keyof C)[]) {
    const { channel } = contract[name]
    const handler = handlers[name] as (...args: unknown[]) => unknown
    ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(...args))
  }
}
