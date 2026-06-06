/**
 * Halo API — unified interface for IPC and HTTP transports.
 *
 * The method implementations are split by domain into sibling `*.api.ts`
 * slices (shared transport/types in `_shared.ts`); this file composes them
 * into the single `api` object that the renderer consumes. The slice order
 * preserves the original key order.
 */
import { authApi } from './auth.api'
import { configApi } from './config.api'
import { spaceApi } from './space.api'
import { conversationApi } from './conversation.api'
import { agentApi } from './agent.api'
import { artifactApi } from './artifact.api'
import { remoteApi } from './remote.api'
import { systemApi } from './system.api'
import { notifyApi } from './notify.api'
import { imApi } from './im.api'
import { browserApi } from './browser.api'
import { searchApi } from './search.api'
import { updaterApi } from './updater.api'
import { perfApi } from './perf.api'
import { healthApi } from './health.api'
import { appsApi } from './apps.api'
import { storeApi } from './store.api'
import { eventsApi } from './events.api'

/**
 * Unified api object — drop-in replacement for window.halo, transport-agnostic.
 */
export const api = {
  ...authApi,
  ...configApi,
  ...spaceApi,
  ...conversationApi,
  ...agentApi,
  ...artifactApi,
  ...remoteApi,
  ...systemApi,
  ...notifyApi,
  ...imApi,
  ...browserApi,
  ...searchApi,
  ...updaterApi,
  ...perfApi,
  ...healthApi,
  ...appsApi,
  ...storeApi,
  ...eventsApi,
}

// Export type for the API
export type HaloApi = typeof api
