import type { ReplyEnding } from './types/transcript'

/** `raw` as a reply ending this build knows, or undefined: a stored or received value is not trusted as one. */
export function readReplyEnding(raw: unknown): ReplyEnding | undefined {
  return raw === 'stopped' || raw === 'interrupted' || raw === 'step-limit' ? raw : undefined
}
