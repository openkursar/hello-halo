/**
 * Typed RPC contract primitives (cross-process).
 *
 * A request/response IPC operation is the single most duplicated thing in the
 * codebase: each one is hand-written in up to five places (ipcMain.handle, the
 * preload bridge, the renderer transport map, the renderer api adapter, and an
 * HTTP route). The names and argument order must stay in lockstep or events
 * silently break — the architecture docs even ship a "sync checklist" for it.
 *
 * A typed contract collapses the boilerplate: declare each operation once
 * (channel name + argument and result types), then derive the main-side
 * handler registration and the preload invoker bindings from it. The compiler
 * enforces that handlers and callers match the declared shapes, so the five
 * surfaces can no longer drift.
 *
 * This module is dependency-free and renderer-safe (types + a tiny factory),
 * so the same contract object is importable from main, preload, and renderer.
 */

/** Standard envelope returned by every request/response channel. */
export interface RpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * A single request/response method definition. `Args`/`Result` are phantom
 * type parameters carried for inference; only `channel` exists at runtime.
 *
 * `Raw` distinguishes two channel kinds that coexist in this codebase:
 *  - `Raw = false` (auto-envelope): the handler returns RAW data and the
 *    registrar wraps it in `RpcResponse<Result>`; the client receives the
 *    envelope. Declared with {@link rpcMethod}.
 *  - `Raw = true` (passthrough): the handler returns the channel's exact
 *    shape (a raw value or an envelope it built itself) and it reaches the
 *    client unchanged. Declared with {@link rawRpcMethod}. Used to migrate
 *    existing handlers whose return contracts are not the standard envelope.
 */
export interface RpcMethodDef<Args extends unknown[], Result, Raw extends boolean = false> {
  readonly channel: string
  readonly raw?: Raw
  /** @internal phantom — never read at runtime */
  readonly __args?: (...a: Args) => void
  /** @internal phantom — never read at runtime */
  readonly __result?: Result
}

/** Declare an auto-envelope method: handler returns raw data of type `Result`. */
export function rpcMethod<Args extends unknown[], Result>(channel: string): RpcMethodDef<Args, Result, false> {
  return { channel }
}

/**
 * Declare a passthrough method: handler returns the channel's exact `Result`.
 * Type params default to `unknown[]`/`unknown` so existing channels can be
 * migrated with a one-line contract entry while the handler keeps its own
 * inline parameter types (lifted verbatim from the original handler) and the
 * preload client stays typed by the `HaloAPI` interface via `bindRpc`.
 */
export function rawRpcMethod<Args extends unknown[] = unknown[], Result = unknown>(
  channel: string,
): RpcMethodDef<Args, Result, true> {
  return { channel, raw: true }
}

/** A contract is a flat map of exposed-method-name → method definition. */
export type RpcContract = Record<string, RpcMethodDef<never, unknown, boolean>>

/**
 * The main-side implementation shape inferred from a contract. For both kinds
 * the handler returns `Result` (auto-envelope wraps it; passthrough returns it
 * verbatim).
 */
export type RpcHandlers<C extends RpcContract> = {
  [K in keyof C]: C[K] extends RpcMethodDef<infer A, infer R, boolean> ? (...args: A) => R | Promise<R> : never
}

/** The client (preload / renderer) call shape inferred from a contract. */
export type RpcClient<C extends RpcContract> = {
  [K in keyof C]: C[K] extends RpcMethodDef<infer A, infer R, infer Raw>
    ? (Raw extends true ? (...args: A) => Promise<R> : (...args: A) => Promise<RpcResponse<R>>)
    : never
}
