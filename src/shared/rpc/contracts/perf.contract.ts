/**
 * Performance-monitoring RPC contract (passthrough — handler bodies preserved;
 * some channels return raw values like PerfServiceState / PerfSnapshot[] / string).
 * The one-way `perf:renderer-metrics` channel is an event (ipcRenderer.send) and
 * is intentionally NOT part of this request/response contract.
 */
import { rawRpcMethod } from '../define'

export const perfRpc = {
  perfStart: rawRpcMethod('perf:start'),
  perfStop: rawRpcMethod('perf:stop'),
  perfGetState: rawRpcMethod('perf:get-state'),
  perfGetHistory: rawRpcMethod('perf:get-history'),
  perfClearHistory: rawRpcMethod('perf:clear-history'),
  perfSetConfig: rawRpcMethod('perf:set-config'),
  perfExport: rawRpcMethod('perf:export'),
}
