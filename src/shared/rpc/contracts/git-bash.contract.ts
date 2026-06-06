/**
 * Git Bash RPC contract (passthrough). Windows Git Bash detection plus the
 * generic external-URL opener. The install channel is excluded: its preload
 * bridge wraps a per-call progress listener, so it is not a clean 1:1 invoke.
 * Handler bodies and return shapes preserved verbatim.
 */
import { rawRpcMethod } from '../define'

export const gitBashRpc = {
  getGitBashStatus: rawRpcMethod('git-bash:status'),
  openExternal: rawRpcMethod('shell:open-external'),
}
