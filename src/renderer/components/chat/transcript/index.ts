/**
 * Transcript scrolling primitives shared by every chat surface (space chat,
 * digital-human chat, IM sessions, run detail, team sessions). See DESIGN.md.
 */

export { useStickToBottom } from './useStickToBottom'
export type { StickToBottom, StickToBottomOptions, ScrollMotion } from './useStickToBottom'
export { useHistoryWindow } from './useHistoryWindow'
export type { HistoryWindow, HistoryWindowOptions } from './useHistoryWindow'
export { transcriptRowClass, estimatedRowHeight } from './row'
export { nextTranscriptRows } from './transcript-rows'
export type { TranscriptRows } from './transcript-rows'
export { captureTranscriptPosition, restoreTranscriptPosition, centerRowInView, revealRowInView } from './position'
export type { TranscriptPosition } from './position'
