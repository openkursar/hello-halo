/**
 * System RPC contract (passthrough). Auto-launch, window controls, and logging.
 * Handler return shapes are preserved verbatim.
 */
import { rawRpcMethod } from '../define'

export const systemRpc = {
  getAutoLaunch: rawRpcMethod('system:get-auto-launch'),
  setAutoLaunch: rawRpcMethod('system:set-auto-launch'),
  setTitleBarOverlay: rawRpcMethod('window:set-title-bar-overlay'),
  maximizeWindow: rawRpcMethod('window:maximize'),
  unmaximizeWindow: rawRpcMethod('window:unmaximize'),
  isWindowMaximized: rawRpcMethod('window:is-maximized'),
  toggleMaximizeWindow: rawRpcMethod('window:toggle-maximize'),
  openLogFolder: rawRpcMethod('system:open-log-folder'),
  relaunch: rawRpcMethod('system:relaunch'),
}
