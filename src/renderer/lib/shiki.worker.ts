/**
 * Tokenizes code blocks off the UI thread (see `shiki-tokenizer.ts`). One
 * request at a time, answered in order: `{ id, request }` → `{ id, result }`
 * or `{ id, error }`.
 */

import { bundledLanguages } from 'shiki/langs'
import { createShikiTokenizer, type TokenizeRequest } from './shiki-tokenizer'
import type { TokensResult } from 'shiki'

export interface ShikiWorkerRequest { id: number; request: TokenizeRequest }
export type ShikiWorkerResponse = { id: number; result: TokensResult } | { id: number; error: string }

const tokenizer = createShikiTokenizer(lang => Object.prototype.hasOwnProperty.call(bundledLanguages, lang))

const post = (response: ShikiWorkerResponse) => (self as unknown as Worker).postMessage(response)

self.onmessage = (event: MessageEvent<ShikiWorkerRequest>) => {
  const { id, request } = event.data
  tokenizer.tokenize(request).then(
    result => post({ id, result }),
    error => post({ id, error: String((error as Error)?.message ?? error) }),
  )
}
