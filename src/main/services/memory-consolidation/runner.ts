/**
 * The consolidating agent: rounds of work over one prepared workspace.
 *
 * File tools only (no shell), rooted in the workspace, and — where the engine
 * runs hooks — held to it: any file tool aimed outside the workspace is refused.
 * The first round gets the task; each later round gets the task again, told
 * that the directory holds its work so far, plus what the system found wrong
 * (a validation failure, or what changed in the live memory meanwhile). Every
 * round is a fresh query: not every engine can resume one — the Halo engine's
 * one-shot query keeps no transcript — and the files carry the state anyway.
 */

import { randomUUID } from 'crypto'
import { globSearchRoot, isPathWithin, resolveToolPath } from '../../foundation/path-containment'
import { z } from 'zod'
import {
  moveWithinWorkspace,
  type ConsolidationWorkspace,
  type MemoryOwnerKind,
} from '../../platform/memory'
import {
  query, tool, createSdkMcpServer, getEngineCapabilities, addSdkHooks,
  buildInternalTaskSdkOptions, getHeadlessElectronPath, type ResolvedSdkCredentials,
} from '../agent'
import { CONSOLIDATION_SYSTEM_PROMPT, buildConsolidationMessage, buildFollowUpMessage } from './prompt'

const TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep']
const MCP_SERVER = 'halo-memory-consolidation'

const MAX_TURNS_PER_ROUND = 60
const ROUND_TIMEOUT_MS = 10 * 60_000

export interface ConsolidationAgentInput {
  ws: ConsolidationWorkspace
  credentials: ResolvedSdkCredentials
  spaceId: string
  ownerName: string
  ownerKind: MemoryOwnerKind
  memoryBytes: number
  nowBytes: number
  topicCount: number
  tag: string
  signal?: AbortSignal
}

export type ConsolidationRoundOutcome =
  /** `exhausted`: the round ran out of turns — its work may be unfinished */
  | { ok: true; summary: string; turns: number; exhausted: boolean }
  | { ok: false; reason: string }

export interface ConsolidationAgent {
  /** First round: the task itself */
  start(): Promise<ConsolidationRoundOutcome>
  /** A later round: the task again, with what to do now */
  followUp(feedback: string[]): Promise<ConsolidationRoundOutcome>
}

export function createConsolidationAgent(input: ConsolidationAgentInput): ConsolidationAgent {
  const task = buildConsolidationMessage({
    ownerName: input.ownerName,
    ownerKind: input.ownerKind,
    memoryBytes: input.memoryBytes,
    nowBytes: input.nowBytes,
    topicCount: input.topicCount,
  })

  async function round(prompt: string): Promise<ConsolidationRoundOutcome> {
    const { ws, tag } = input
    const abortController = new AbortController()
    const cancel = () => abortController.abort()
    input.signal?.addEventListener('abort', cancel, { once: true })
    if (input.signal?.aborted) cancel()
    const timer = setTimeout(cancel, ROUND_TIMEOUT_MS)
    const pendingMoves = new Set<Promise<unknown>>()
    try {
      input.signal?.throwIfAborted()
      const sdkOptions = await buildOptions(input, abortController, pendingMoves)
      abortController.signal.throwIfAborted()

      let summary = ''
      let turns = 0
      let exhausted = false
      for await (const msg of query({ prompt, options: sdkOptions })) {
        if (msg.type === 'assistant') {
          turns++
        } else if (msg.type === 'result') {
          summary = typeof msg.result === 'string' ? msg.result : ''
          // Running out of turns can still leave a sound result; the harness decides.
          if (msg.subtype !== 'success' && msg.subtype !== 'error_max_turns') {
            return { ok: false, reason: `agent ended with ${msg.subtype}` }
          }
          if (msg.subtype === 'error_max_turns') {
            exhausted = true
            console.warn(`[MemoryConsolidation][${tag}] Agent reached ${MAX_TURNS_PER_ROUND} turns`)
          }
          break
        }
      }
      input.signal?.throwIfAborted()
      if (abortController.signal.aborted) return { ok: false, reason: `timed out after ${ROUND_TIMEOUT_MS / 1000}s` }
      console.log(`[MemoryConsolidation][${tag}] Round finished in ${ws.dir}: ${turns} turns`)
      return { ok: true, summary, turns, exhausted }
    } catch (err) {
      input.signal?.throwIfAborted()
      if (abortController.signal.aborted) return { ok: false, reason: `timed out after ${ROUND_TIMEOUT_MS / 1000}s` }
      return { ok: false, reason: `agent failed: ${(err as Error).message}` }
    } finally {
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', cancel)
      abortController.abort()
      await Promise.allSettled(pendingMoves)
    }
  }

  return {
    start: () => round(task),
    followUp: (feedback) => round(buildFollowUpMessage(task, feedback)),
  }
}

async function buildOptions(
  input: ConsolidationAgentInput,
  abortController: AbortController,
  pendingMoves: Set<Promise<unknown>>
): Promise<Record<string, any>> {
  const { ws, tag } = input
  const sdkOptions = await buildInternalTaskSdkOptions({
    engineId: input.credentials.engineId,
    credentials: input.credentials,
    workDir: ws.dir,
    electronPath: getHeadlessElectronPath(),
    spaceId: input.spaceId,
    // A plain uuid: request identity on the halo engine requires one.
    conversationId: randomUUID(),
  })

  Object.assign(sdkOptions, {
    systemPrompt: CONSOLIDATION_SYSTEM_PROMPT,
    tools: [...TOOLS],
    allowedTools: [...TOOLS, `mcp__${MCP_SERVER}__memory_move`],
    mcpServers: { [MCP_SERVER]: createMoveServer(ws, abortController.signal, pendingMoves) },
    maxTurns: MAX_TURNS_PER_ROUND,
    // No user skills, CLAUDE.md or project settings: they are about other work.
    settingSources: [],
    abortController,
  })
  delete sdkOptions.includePartialMessages
  delete sdkOptions.canUseTool
  delete sdkOptions.disallowedTools

  if (getEngineCapabilities(sdkOptions.engineId)?.features.hooks) {
    addSdkHooks(sdkOptions, confineToWorkspace(ws.dir, tag, abortController.signal))
  } else {
    console.warn(`[MemoryConsolidation][${tag}] Engine ${sdkOptions.engineId} runs no hooks — workspace confinement is by instruction only`)
  }
  return sdkOptions
}

function createMoveServer(ws: ConsolidationWorkspace, signal: AbortSignal, pending: Set<Promise<unknown>>): unknown {
  const memoryMove = tool(
    'memory_move',
    'Move, rename or remove a topic file or category folder. Paths are relative to the topics/ folder ' +
    '(e.g. "halo-product/migration.md"). To remove, omit `to` and give `merged_into`: the topic that now ' +
    'holds the removed content. Every original topic must end up somewhere, so always use this rather ' +
    'than deleting.',
    {
      from: z.string().describe('Existing path, relative to topics/'),
      to: z.string().optional().describe('New path, relative to topics/. Omit to remove.'),
      merged_into: z.string().optional().describe('When removing: the topic (relative to topics/) that absorbed it'),
    },
    async (args) => {
      let operation: Promise<string> | undefined
      try {
        if (signal.aborted) {
          console.warn(`[MemoryConsolidation] Refused memory_move in ${ws.dir}: consolidation is cancelled`)
          signal.throwIfAborted()
        }
        operation = moveWithinWorkspace(ws, args.from, args.to ?? null, args.merged_into)
        pending.add(operation)
        const text = await operation
        return { content: [{ type: 'text' as const, text }] }
      } catch (err) {
        return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }
      } finally {
        if (operation) pending.delete(operation)
      }
    }
  )
  return createSdkMcpServer({ name: MCP_SERVER, version: '1.0.0', tools: [memoryMove] })
}

/**
 * Refuse any file tool aimed outside the workspace: its path arguments, read
 * as the engines read them (`~` included), and the directory a Glob pattern
 * reaches. Compared resolved through links and, where
 * the filesystem ignores case, case-insensitively — the same form the memory
 * write guard uses.
 */
export function confineToWorkspace(root: string, tag: string, signal?: AbortSignal): Record<string, unknown[]> {
  const pre = async (hookInput: { cwd?: string; tool_name?: string; tool_input?: unknown }): Promise<Record<string, unknown>> => {
    if (signal?.aborted) {
      console.warn(`[MemoryConsolidation][${tag}] Refused file tool: consolidation is cancelled`)
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'Memory consolidation has been cancelled.',
        },
      }
    }
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>
    const base = hookInput.cwd ?? root
    const candidates: string[] = []
    for (const key of ['file_path', 'path', 'notebook_path']) {
      const raw = toolInput[key]
      if (typeof raw === 'string' && raw.length > 0) candidates.push(resolveToolPath(raw, base))
    }
    // Grep's pattern is a regex, not a path; only Glob's names files.
    const pattern = hookInput.tool_name === 'Glob' ? toolInput.pattern : undefined
    if (typeof pattern === 'string') {
      const searchBase = typeof toolInput.path === 'string' && toolInput.path ? resolveToolPath(toolInput.path, base) : base
      candidates.push(globSearchRoot(pattern, searchBase))
    }
    const outside = candidates.find(c => !isPathWithin(c, root))
    if (!outside) return {}
    console.warn(`[MemoryConsolidation][${tag}] Refused file tool outside the workspace: ${outside}`)
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Only files in the current working directory may be used.',
      },
    }
  }
  // One entry per tool: the Halo engine does not read `A|B` as alternation.
  return { PreToolUse: TOOLS.map(matcher => ({ matcher, hooks: [pre] })) }
}
