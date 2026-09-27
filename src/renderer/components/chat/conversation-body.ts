/**
 * Whether a conversation shows its message list rather than the empty state.
 * An error counts as content: a first message refused before it was recorded
 * leaves no messages, and its error is drawn only by the list.
 */
export function showsMessageList(view: {
  messageCount: number
  streamingContent: string
  isThinking: boolean
  error: string | null
}): boolean {
  return view.messageCount > 0 || !!view.streamingContent || view.isThinking || !!view.error
}
