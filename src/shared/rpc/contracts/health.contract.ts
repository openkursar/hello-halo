/**
 * Health RPC contract (passthrough). Health status/state queries, recovery
 * triggers, and diagnostic report generation. Handler return shapes are
 * preserved verbatim.
 */
import { rawRpcMethod } from '../define'

export const healthRpc = {
  getHealthStatus: rawRpcMethod('health:get-status'),
  getHealthState: rawRpcMethod('health:get-state'),
  triggerHealthRecovery: rawRpcMethod('health:trigger-recovery'),
  generateHealthReport: rawRpcMethod('health:generate-report'),
  generateHealthReportText: rawRpcMethod('health:generate-report-text'),
  exportHealthReport: rawRpcMethod('health:export-report'),
  runHealthCheck: rawRpcMethod('health:run-check'),
}
