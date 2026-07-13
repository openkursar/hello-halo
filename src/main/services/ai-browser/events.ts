/**
 * AI Browser - Global event bus
 *
 * The global (main-chat) BrowserContext forwards its view-lifecycle signals
 * here. The transport layer (ipc/ai-browser.ts) subscribes once at startup —
 * before any AI browser view exists — and fans events out to the renderer and
 * remote WebSocket clients.
 *
 * This decouples the context from any BrowserWindow reference: the context only
 * emits, and whoever owns the window/WS clients does the delivery. Scoped
 * (automation) contexts have no UI and never forward here.
 *
 * Modeled on services/ai-terminal/events.ts.
 */

import { EventEmitter } from 'events'

/** The AI's active view changed (created or selected). */
export interface BrowserActiveViewEvent {
  viewId: string
  url: string | null
  title: string | null
}

/** An AI-driven view was destroyed and is no longer available to reveal. */
export interface BrowserViewGoneEvent {
  viewId: string
}

class BrowserEventBus extends EventEmitter {}

export const browserEventBus = new BrowserEventBus()
// Views come and go across long sessions; avoid MaxListeners warnings.
browserEventBus.setMaxListeners(0)

export function emitBrowserActiveView(event: BrowserActiveViewEvent): void {
  browserEventBus.emit('active-view', event)
}

export function emitBrowserViewGone(event: BrowserViewGoneEvent): void {
  browserEventBus.emit('gone', event)
}

export function onBrowserActiveView(handler: (e: BrowserActiveViewEvent) => void): () => void {
  browserEventBus.on('active-view', handler)
  return () => browserEventBus.off('active-view', handler)
}

export function onBrowserViewGone(handler: (e: BrowserViewGoneEvent) => void): () => void {
  browserEventBus.on('gone', handler)
  return () => browserEventBus.off('gone', handler)
}
