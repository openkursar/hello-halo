/**
 * services/memory-consolidation — keeps memories from outgrowing themselves.
 *
 * When a memory is due, an agent reorganises it in a private copy: settled
 * knowledge moves from `# now` and old `# History` into topics. The copy
 * replaces the live memory only after platform/memory has validated it and
 * confirmed nothing else changed meanwhile (History written meanwhile is carried
 * over). Every swap keeps a restorable snapshot.
 *
 * Callers:
 *   - apps/runtime, after a digital human's run or chat turn, and for the
 *     owner's status and "consolidate now"
 *   - the space trigger below, after a space conversation's turn, and the
 *     same owner controls for a space
 *
 * When: by the owner's cadence (memory.md size, `# now` size, History length).
 * The agent is kept at it until its result passes: a failed check or changes
 * made meanwhile go back to it. Only when it runs out of rounds is History
 * trimmed without it, and the memory then waits until it has grown before the
 * next automatic attempt. With auto-consolidation off, History is only trimmed.
 *
 * Does NOT: decide when a memory is loaded or written by a turn, or know
 * anything about apps; the digital-human side reaches it with plain inputs.
 */

export {
  requestConsolidation,
  consolidateNow,
  getMemoryStatus,
  type ConsolidationRequest,
} from './service'
export {
  initSpaceMemoryConsolidation,
  disposeSpaceMemoryConsolidation,
  getSpaceMemoryStatus,
  consolidateSpaceMemoryNow,
} from './space-trigger'
