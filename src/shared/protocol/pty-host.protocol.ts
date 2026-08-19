/**
 * Pty Host protocol — message contract between the main process (ai-terminal
 * host client) and the pty-host worker process.
 *
 * The worker owns the ptys and their @xterm/headless interpretation; the main
 * process owns policy (shell resolution, space scoping, flow-control decisions,
 * UI fan-out). Requests are correlated by requestId; events are unsolicited.
 *
 * Follows the file-watcher.protocol.ts conventions (discriminated unions over
 * child_process IPC).
 */

import type {
  ResolvedShellSpec,
  TerminalInfo,
  TerminalOwner,
  TerminalReadMode,
  TerminalReadResult,
  TerminalSearchResult,
  TerminalWaitOutcome,
  TerminalWriteResult
} from '../types/terminal'

/** Fully-resolved session spec the worker can execute without any policy. */
export interface CreateSessionSpec {
  shell: ResolvedShellSpec
  cwd: string
  cols?: number
  rows?: number
  title?: string
  owner: TerminalOwner
  spaceId?: string
}

// ============================================
// Main → Worker
// ============================================

/** Request messages (expect a matching Response with the same requestId). */
export type PtyHostRequest =
  | { type: 'create'; requestId: string; spec: CreateSessionSpec }
  | { type: 'write'; requestId: string; sessionId: string; input: string; timeoutMs: number; submit: boolean }
  | { type: 'read'; requestId: string; sessionId: string; mode: TerminalReadMode; lines?: number; offset?: number }
  | { type: 'search'; requestId: string; sessionId: string; pattern: string; context?: number }
  | { type: 'wait-for'; requestId: string; sessionId: string; text: string; timeoutMs: number }
  | { type: 'replay'; requestId: string; sessionId: string }
  | { type: 'mark-ai-touched'; requestId: string; sessionId: string }

/** Fire-and-forget messages (no response; latency-sensitive or terminal). */
export type PtyHostNotification =
  | { type: 'input'; sessionId: string; data: string }
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  | { type: 'kill'; sessionId: string }
  /** Flow control (decided in main from viewer acks): pause/resume the pty. */
  | { type: 'pause'; sessionId: string }
  | { type: 'resume'; sessionId: string }
  | { type: 'shutdown' }

export type MainToPtyHostMessage = PtyHostRequest | PtyHostNotification

// ============================================
// Worker → Main
// ============================================

/** Per-request result payloads, keyed by the request's type. */
export interface PtyHostResponsePayloads {
  create: { info: TerminalInfo }
  write: TerminalWriteResult
  read: TerminalReadResult
  search: TerminalSearchResult
  'wait-for': {
    outcome: TerminalWaitOutcome
    /** Context for the tool reply: screen (found) or recent output (otherwise). */
    content: string
  }
  replay: { info: TerminalInfo; data: string }
  'mark-ai-touched': { flipped: boolean; info: TerminalInfo }
}

export type PtyHostResponse =
  | { type: 'response'; requestId: string; ok: true; data: PtyHostResponsePayloads[keyof PtyHostResponsePayloads] }
  | { type: 'response'; requestId: string; ok: false; error: string }

/** Unsolicited events. `info` snapshots are authoritative (worker-owned). */
export type PtyHostEvent =
  | { type: 'data'; sessionId: string; data: string }
  | { type: 'exit'; sessionId: string; exitCode: number; info: TerminalInfo }
  /** An exited session was pruned from the worker's replay retention. */
  | { type: 'evicted'; sessionId: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type PtyHostToMainMessage = PtyHostResponse | PtyHostEvent
