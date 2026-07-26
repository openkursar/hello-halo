/**
 * App-management RPC contract (passthrough). Exposes the AppManager and
 * AppRuntime request/response surface to the renderer. Handler bodies and
 * return shapes are preserved verbatim by the IPC layer; this contract only
 * pins the channel names and the exposed `window.halo.*` method names.
 */
import { rawRpcMethod } from '../define'

export const appRpc = {
  // Apps Management
  appList: rawRpcMethod('app:list'),
  appGet: rawRpcMethod('app:get'),
  appInstall: rawRpcMethod('app:install'),
  appUninstall: rawRpcMethod('app:uninstall'),
  appReinstall: rawRpcMethod('app:reinstall'),
  appDelete: rawRpcMethod('app:delete'),
  appPause: rawRpcMethod('app:pause'),
  appResume: rawRpcMethod('app:resume'),
  appTrigger: rawRpcMethod('app:trigger'),
  appGetState: rawRpcMethod('app:get-state'),
  appGetActivity: rawRpcMethod('app:get-activity'),
  appGetSession: rawRpcMethod('app:get-session'),
  appRespondEscalation: rawRpcMethod('app:respond-escalation'),
  appContinueRun: rawRpcMethod('app:continue-run'),
  appInjectRun: rawRpcMethod('app:inject-run'),
  appUpdateConfig: rawRpcMethod('app:update-config'),
  appUpdateFrequency: rawRpcMethod('app:update-frequency'),
  appUpdateOverrides: rawRpcMethod('app:update-overrides'),
  appUpdateSpec: rawRpcMethod('app:update-spec'),
  appGrantPermission: rawRpcMethod('app:grant-permission'),
  appRevokePermission: rawRpcMethod('app:revoke-permission'),
  appSetUpgradeStrategy: rawRpcMethod('app:set-upgrade-strategy'),

  // App Import / Export
  appExportSpec: rawRpcMethod('app:export-spec'),
  appImportSpec: rawRpcMethod('app:import-spec'),
  appOpenSkillFolder: rawRpcMethod('app:open-skill-folder'),
  appGetDataPath: rawRpcMethod('app:get-data-path'),
  appOpenDataFolder: rawRpcMethod('app:open-data-folder'),
  appClearMemory: rawRpcMethod('app:clear-memory'),
  appMoveSpace: rawRpcMethod('app:move-space'),

  // App Chat
  appChatSend: rawRpcMethod('app:chat-send'),
  appChatStop: rawRpcMethod('app:chat-stop'),
  appChatStatus: rawRpcMethod('app:chat-status'),
  appChatMessages: rawRpcMethod('app:chat-messages'),
  appChatSessionState: rawRpcMethod('app:chat-session-state'),
  appChatClear: rawRpcMethod('app:chat-clear'),
  appChatRestart: rawRpcMethod('app:chat-restart'),
  appImChatMessages: rawRpcMethod('app:im-chat-messages'),
  appImChatClear: rawRpcMethod('app:im-chat-clear'),
  appImChatStop: rawRpcMethod('app:im-chat-stop'),
}
