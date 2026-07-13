/**
 * AI Terminal - Global event bus
 *
 * The global (main-chat) terminal context forwards its per-session data and
 * lifecycle events here. Transport layers (ipc/terminal.ts) subscribe once at
 * startup — before any session exists — and fan events out to the renderer and
 * remote WebSocket clients. Scoped (automation) contexts do NOT forward here;
 * they have no UI.
 */

import { EventEmitter } from 'events'
import type { TerminalDataEvent, TerminalLifecycleEvent } from './types'

class TerminalEventBus extends EventEmitter {}

export const terminalEventBus = new TerminalEventBus()
// pty data is high-frequency; avoid MaxListeners warnings across many sessions.
terminalEventBus.setMaxListeners(0)

export function emitTerminalData(event: TerminalDataEvent): void {
  terminalEventBus.emit('data', event)
}

export function emitTerminalLifecycle(event: TerminalLifecycleEvent): void {
  terminalEventBus.emit('lifecycle', event)
}

export function onTerminalData(handler: (e: TerminalDataEvent) => void): () => void {
  terminalEventBus.on('data', handler)
  return () => terminalEventBus.off('data', handler)
}

export function onTerminalLifecycle(handler: (e: TerminalLifecycleEvent) => void): () => void {
  terminalEventBus.on('lifecycle', handler)
  return () => terminalEventBus.off('lifecycle', handler)
}
