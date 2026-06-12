/**
 * Tlon — Halo's knowledge base (internal codename; never shown to users, who
 * only ever see "Knowledge").
 *
 * Named after Borges' "Tlön, Uqbar, Orbis Tertius": a secret society spends
 * three centuries inventing the planet Tlön inside an encyclopedia, and the
 * written world slowly bleeds into and overwrites reality. Fitting for a wiki
 * that compounds from your own sources until the agent reasons from it as if
 * it were the world.
 *
 * Tlon public surface.
 *
 * Cross-module integration (agent/app prompts, bootstrap):
 *   getKBReferencesForSpace, getKBReferencesForApp, initTlonWatchers,
 *   shutdownTlon
 *
 * Controller-facing CRUD / file ops / ingest are re-exported for the
 * tlon.controller. ingest.ts and watcher.ts internals stay otherwise
 * unexported.
 */

export {
  // CRUD
  createKB,
  getKB,
  listKBs,
  listKBsForSpace,
  listKBsForApp,
  updateKB,
  deleteKB,
  setDefaultKB,
  getDefaultKB,
  // binding
  bindToSpace,
  unbindFromSpace,
  bindToApp,
  unbindFromApp,
  // linked dirs
  addLinkedDir,
  removeLinkedDir,
  // raw files
  addRawFiles,
  listRawFiles,
  removeRawFile,
  // wiki reads
  listWikiPages,
  readWikiPage,
  readIndexMd,
  // conversation integration (hot path)
  getKBReferencesForSpace,
  getKBReferencesForApp,
  getKBReferenceById,
  getKBChatContext,
  // stats / status
  refreshStats,
  getRawFileLearnedStatus,
} from './service'

export { triggerFullIngest, getIngestProgress, clearAndRelearn, isIngesting } from './ingest'

export { initTlonWatchers, shutdownTlon } from './watcher'
