/**
 * Transcript primitives shared by every chat surface (space chat, digital-human
 * chat, IM sessions, run detail, team sessions): scrolling, rows, and where a
 * record received mid-turn is drawn. See DESIGN.md.
 */

export { useStickToBottom } from './useStickToBottom'
export type { StickToBottom, StickToBottomOptions, ScrollMotion } from './useStickToBottom'
export { useHistoryWindow } from './useHistoryWindow'
export type { HistoryWindow, HistoryWindowOptions } from './useHistoryWindow'
export { transcriptRowClass, estimatedRowHeight } from './row'
export { inputsByReply, nextTranscriptRows, openerOwner } from './transcript-rows'
export type { ReplyInputs, TranscriptRows } from './transcript-rows'
export { isArrivalRecord, isArrivalThought, liveArrivals, mergeArrivalThoughts, projectArrivalThoughts, toArrivalThought, workSeconds } from './arrivals'
export type { ArrivalThought } from './arrivals'
export { captureTranscriptPosition, restoreTranscriptPosition, centerRowInView, revealRowInView } from './position'
export type { TranscriptPosition } from './position'
