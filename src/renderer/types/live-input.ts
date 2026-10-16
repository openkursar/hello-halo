import type { Message } from './index'

/** Position where an input became visible within the current streamed turn. */
export interface LiveInput {
  message: Message
  afterThoughtId?: string
  textBlockVersion: number
  textOffset: number
  textSnapshot?: string
}
