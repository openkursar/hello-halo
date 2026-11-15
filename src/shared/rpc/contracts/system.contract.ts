/**
 * System RPC contract (passthrough). Auto-launch, window controls, logging, and
 * the native file/folder picker.
 * Handler return shapes are preserved verbatim.
 */
import { rawRpcMethod, type RpcResponse } from '../define'

/** The route the app's requests to Claude and ChatGPT take now; `address` is host:port only. */
export type ProxyRouteInfo =
  | { kind: 'proxy'; via: 'settings' | 'system'; address: string }
  | { kind: 'direct'; listed: boolean }

export const systemRpc = {
  getAutoLaunch: rawRpcMethod('system:get-auto-launch'),
  setAutoLaunch: rawRpcMethod('system:set-auto-launch'),
  setTitleBarOverlay: rawRpcMethod('window:set-title-bar-overlay'),
  maximizeWindow: rawRpcMethod('window:maximize'),
  unmaximizeWindow: rawRpcMethod('window:unmaximize'),
  isWindowMaximized: rawRpcMethod('window:is-maximized'),
  toggleMaximizeWindow: rawRpcMethod('window:toggle-maximize'),
  openLogFolder: rawRpcMethod('system:open-log-folder'),
  /** Open the crash reports (minidumps + pre-crash snapshots) folder; data = { path, pending } */
  openCrashReportsFolder: rawRpcMethod('system:open-crash-reports-folder'),
  relaunch: rawRpcMethod('system:relaunch'),
  pickLocalEntries: rawRpcMethod('system:pick-local-entries'),
  /** How Claude and ChatGPT traffic would leave the machine right now. */
  getProxyRoute: rawRpcMethod<[], RpcResponse<ProxyRouteInfo>>('system:get-proxy-route'),
}
