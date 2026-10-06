#!/usr/bin/env node
/**
 * Deterministic local OpenAI-compatible SSE mock server.
 *
 * Backs the streaming perf scenarios (S2/S6/S8). A real API's token count and
 * inter-token timing vary run to run, which makes before/after comparisons
 * meaningless; this mock emits a FIXED token count at a FIXED interval every
 * run — same script, same machine, same result shape.
 *
 * Automation runs need one report_to_user tool call to finish. When the
 * caller supplies that tool, the mock emits a short reply and a deterministic
 * tool call, then answers the tool-result turn with a final text response.
 *
 * Does not touch any product code. Halo's own (untouched)
 * src/main/openai-compat-router already knows how to translate a standard
 * OpenAI /chat/completions SSE stream into the format the Claude Agent SDK
 * expects — confirmed by reading (read-only):
 *   - src/main/openai-compat-router/utils/url.ts        (normalizeApiUrl:
 *     any bare http://host URL gets auto-suffixed to `/v1/chat/completions`,
 *     and the request-handler infers apiType:'chat_completions' from that
 *     suffix alone — no explicit `apiType` field needs to be written into
 *     the AI source config.)
 *   - src/main/openai-compat-router/stream/openai-chat-stream.ts (exact
 *     chunk shape this mock must emit: `choices[0].delta.content`, a
 *     `finish_reason` on the terminal chunk, optional `usage`, terminated by
 *     `data: [DONE]`).
 *   - src/main/openai-compat-router/stream/base-stream-handler.ts
 *     (`parseSSEData`: lines must start with `data:`, `[DONE]` sentinel ends
 *     the stream — standard OpenAI SSE framing, nothing provider-specific).
 *
 * Usage:
 *   node tests/perf/mock/sse-server.mjs
 *
 * Env vars (all optional):
 *   MOCK_PORT          default 8791
 *   MOCK_TOKEN_COUNT    default 2000   (word-ish tokens per response)
 *   MOCK_CONTENT        default "default"; "links" = ~20K chars of link- and
 *                       bold-dense paragraphs, "code150" = one 150-line fenced
 *                       TypeScript block. Presets stream in fixed 40-char deltas
 *                       (MOCK_TOKEN_COUNT does not apply).
 *
 * A prompt containing `mock-content:<preset>` gets that preset regardless of
 * MOCK_CONTENT, so one mock (the one run-perf starts) serves every scenario.
 *   MOCK_INTERVAL_MS    default 20     (ms between each token)
 *   MOCK_MODEL          default "mock-sse-v1" (echoed back if request omits model)
 *
 * Point Halo at it (no product code or existing test file needs editing —
 * this is exactly the env-var seam tests/e2e/fixtures/electron.ts already
 * reads):
 *   HALO_TEST_PROVIDER=openai                  # any non-"anthropic" id
 *   HALO_TEST_API_URL=http://127.0.0.1:8791     # normalizeApiUrl() appends /v1/chat/completions
 *   HALO_TEST_API_KEY=mock-key                  # any non-empty string, never validated
 *   HALO_TEST_MODEL=mock-sse-v1                 # must match MOCK_MODEL if you override it
 */
import http from 'node:http'

const PORT = Number(process.env.MOCK_PORT || 8791)
const TOKEN_COUNT = Number(process.env.MOCK_TOKEN_COUNT || 2000)
const INTERVAL_MS = Number(process.env.MOCK_INTERVAL_MS || 20)
const DEFAULT_MODEL = process.env.MOCK_MODEL || 'mock-sse-v1'

// ---------------------------------------------------------------------------
// Deterministic content: prose + multiple fenced code blocks (to exercise
// the Shiki highlight path in the message renderer, not just plain text).
// Tokenized by splitting on whitespace while KEEPING the whitespace as its
// own token, so re-joining tokens[0..n] reproduces the source text exactly
// — no accidental double-spacing or missing newlines between chunks.
// ---------------------------------------------------------------------------
const BASE_TEMPLATE = `Here is a detailed walkthrough of the requested change. Hello! Let's start with the overview, then look at the implementation, and close with a short summary of the trade-offs involved.

## Overview

The component below renders a todo list with add, toggle, and remove behavior. State is kept local to the component for simplicity, and each item carries a stable id so React can key the list correctly during re-renders.

\`\`\`tsx
import { useState } from 'react'

interface TodoItem {
  id: string
  text: string
  done: boolean
}

export function TodoList() {
  const [items, setItems] = useState<TodoItem[]>([])
  const [draft, setDraft] = useState('')

  const addItem = () => {
    if (!draft.trim()) return
    setItems(prev => [...prev, { id: crypto.randomUUID(), text: draft, done: false }])
    setDraft('')
  }

  const toggleItem = (id: string) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, done: !i.done } : i))
  }

  return (
    <div>
      <input value={draft} onChange={e => setDraft(e.target.value)} />
      <button onClick={addItem}>Add</button>
      <ul>
        {items.map(item => (
          <li key={item.id} onClick={() => toggleItem(item.id)}>
            {item.done ? 'done: ' : 'todo: '}{item.text}
          </li>
        ))}
      </ul>
    </div>
  )
}
\`\`\`

A few things worth calling out about the implementation above: the id is generated once per item via \`crypto.randomUUID()\` rather than derived from the array index, which keeps React's reconciliation stable even if items are removed from the middle of the list.

## A second example, in Python

The same idea translated to a small CLI helper, for comparison:

\`\`\`python
from dataclasses import dataclass, field
from uuid import uuid4

@dataclass
class TodoItem:
    text: str
    done: bool = False
    id: str = field(default_factory=lambda: str(uuid4()))

class TodoList:
    def __init__(self):
        self.items: list[TodoItem] = []

    def add(self, text: str) -> None:
        self.items.append(TodoItem(text=text))

    def toggle(self, item_id: str) -> None:
        for item in self.items:
            if item.id == item_id:
                item.done = not item.done
\`\`\`

## Summary

Both versions favor explicit state transitions over hidden mutation, which makes the control flow easy to follow even as the list grows. That is the whole change — nothing else in the surrounding code needs to move.
`

/** Splits on whitespace while keeping the whitespace as separate tokens, so tokens.join('') === input exactly. */
function tokenize(text) {
  return text.split(/(\s+)/).filter((t) => t.length > 0)
}

function buildTokenStream(count) {
  const base = tokenize(BASE_TEMPLATE)
  const out = []
  while (out.length < count) {
    out.push(...base, '\n\n---\n\n') // separator so repeated cycles read as distinct sections
  }
  return out.slice(0, count)
}

const LINK_PARAGRAPH = (n) =>
  `Section ${n}: see [the guide ${n}](https://example.com/docs/guide-${n}) and **the reference ${n}**, ` +
  `then compare with [release notes ${n}](https://example.com/releases/${n}) and [issue ${n}](https://example.com/issues/${n}).\n\n`

const CODE_LINE = (n) =>
  `export function step${n}(input: number): number { return input * ${n} + ${n % 7} } // line ${n}\n`

function presetText(name) {
  if (name === 'links') {
    let text = '# Link-dense report\n\n'
    for (let n = 1; text.length < 20000; n++) text += LINK_PARAGRAPH(n)
    return text
  }
  if (name === 'code150') {
    let code = ''
    for (let n = 1; n <= 150; n++) code += CODE_LINE(n)
    return `Here is the whole module:\n\n\`\`\`ts\n${code}\`\`\`\n\nThat is all 150 lines.\n`
  }
  throw new Error(`Unknown MOCK_CONTENT preset: ${name}`)
}

/** Fixed-size deltas, like a provider streaming a long reply. */
function chunked(text, size) {
  const out = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

const CONTENT = process.env.MOCK_CONTENT || 'default'
const PRESETS = ['links', 'code150']

// Built once at startup so every request in this process serves byte-identical content.
const TOKENS_BY_CONTENT = {
  default: buildTokenStream(TOKEN_COUNT),
  numbers: Array.from({ length: 50 }, (_, index) => `${index % 5 + 1} `),
  first: ['First'],
  second: ['Second'],
  ...Object.fromEntries(PRESETS.map(name => [name, chunked(presetText(name), 40)])),
}
if (!TOKENS_BY_CONTENT[CONTENT]) throw new Error(`Unknown MOCK_CONTENT preset: ${CONTENT}`)

/** Select explicit workload presets or deterministic chat-fixture replies. */
function contentFor(body) {
  const text = JSON.stringify(body.messages ?? [])
  const asked = PRESETS.find(name => text.includes(`mock-content:${name}`))
  const lastUser = body.messages?.filter(message => message.role === 'user').at(-1)
  const prompt = typeof lastUser?.content === 'string' ? lastUser.content
    : Array.isArray(lastUser?.content) ? lastUser.content.map(part => part.text ?? '').join('\n') : ''
  if (prompt.includes('Count from 1 to 5 slowly.')) return 'numbers'
  if (prompt.includes('Say "First" and nothing else.')) return 'first'
  if (prompt.includes('Say "Second" and nothing else.')) return 'second'
  return asked ?? CONTENT
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve({})
      }
    })
  })
}

function sseChunk(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

async function handleChatCompletions(req, res) {
  const body = await readBody(req)
  const model = body.model || DEFAULT_MODEL
  const stream = body.stream !== false // default true, matches how the SDK calls it
  const content = contentFor(body)
  const reportTool = body.tools?.find(tool => tool.function?.name === 'mcp__halo-report__report_to_user')
  const reportResult = body.messages?.some(message => message.role === 'tool' && message.tool_call_id === 'mock-report-1')
  const TOKENS = reportTool ? (reportResult ? ['Run finished.'] : ['Preparing the run report.']) : TOKENS_BY_CONTENT[content]

  console.log(`[mock-sse] POST ${req.url} model=${model} stream=${stream} tokens=${TOKENS.length} content=${content} interval=${INTERVAL_MS}ms report=${!!reportTool} followup=${!!reportResult}`)

  if (!stream) {
    // Non-streaming fallback: full OpenAI chat completion object, for completeness.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: 'mock-cmpl-1',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: TOKENS.join('') },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 20, completion_tokens: TOKENS.length, total_tokens: TOKENS.length + 20 }
    }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.socket?.setNoDelay(true)
  res.flushHeaders?.()

  let i = 0
  const timer = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(timer)
      return
    }

    if (i === 0) {
      // First chunk carries the role, matching real providers' first frame.
      sseChunk(res, {
        id: 'mock-cmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: TOKENS[i] }, finish_reason: null }]
      })
      i++
      return
    }

    if (i < TOKENS.length) {
      sseChunk(res, {
        id: 'mock-cmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: TOKENS[i] }, finish_reason: null }]
      })
      i++
      return
    }

    if (reportTool && !reportResult) {
      sseChunk(res, {
        id: 'mock-cmpl-1',
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'mock-report-1', type: 'function', function: {
          name: reportTool.function.name,
          arguments: JSON.stringify({ type: 'run_complete', message: 'The seeded run completed.' })
        } }] }, finish_reason: null }]
      })
    }
    sseChunk(res, {
      id: 'mock-cmpl-1',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: reportTool && !reportResult ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: TOKENS.length, total_tokens: TOKENS.length + 20 }
    })
    res.write('data: [DONE]\n\n')
    res.end()
    clearInterval(timer)
  }, INTERVAL_MS)

  req.on('close', () => clearInterval(timer))
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST') {
    handleChatCompletions(req, res)
    return
  }
  res.writeHead(404).end()
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-sse] listening on http://127.0.0.1:${PORT}`)
  console.log(`[mock-sse] ${TOKENS_BY_CONTENT[CONTENT].length} tokens/response (${CONTENT}), ${INTERVAL_MS}ms/token, model="${DEFAULT_MODEL}"`)
})
