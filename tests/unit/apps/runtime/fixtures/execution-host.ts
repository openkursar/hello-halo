import { registerAppBridge } from '../../../../../src/main/services/app-bridge'
import { createExecutionWorkHost } from '../../../../../src/main/apps/runtime/team/execution-work'
import type { TeamRuntime } from '../../../../../src/main/apps/runtime/team'

/** The application layer's side of an agent execution, registered the way the runtime does at startup. */
export function registerExecutionHost(runtime: () => TeamRuntime | null): void {
  registerAppBridge({
    getAppManager: () => null, createHaloAppsMcpServer: () => null, onMcpAppsChange: () => () => {},
    executionWork: createExecutionWorkHost({ runtime }),
  })
}
