/**
 * A reply's work: the folded line above a reply and, opened, a timeline of what
 * the AI said along the way with each stretch of operations as one line. See DESIGN.md.
 */

export { WorkHistory, TIMELINE_PAGE } from './WorkHistory'
export { WorkHistoryHeader } from './WorkHistoryHeader'
export { formatWorkDuration } from './duration'
export { answerTextIds, liveTextIds, sameIdsOr } from './spoken-text'
export { nextWorkStream, hasWorkToShow } from './work-stream'
export type { WorkEntry, WorkStream } from './work-stream'
export { operationStatus } from './operation-status'
export type { OperationStatus } from './operation-status'
export { summarizeGroup, workKind } from './group-summary'
export type { GroupSummary, WorkKind } from './group-summary'
export { describeOperation, editStats, operationIcon } from './operation-label'
export type { OperationLabel } from './operation-label'
export { LIVE_WORK, WorkViewMemory, WorkViewMemoryProvider, useTranscriptWorkView, useWorkOpen, useWorkViewMemory } from './view-memory'
export type { WorkViewState } from './view-memory'
