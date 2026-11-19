/**
 * AI Browser - Global event bus
 *
 * Every conversation-bound BrowserContext (space chat and digital-human chat)
 * plus the user's singleton forward their view-lifecycle signals here. The
 * transport layer (ipc/ai-browser.ts) subscribes once at startup — before any
 * AI browser view exists — and fans events out to the renderer and remote
 * WebSocket clients.
 *
 * This decouples the context from any BrowserWindow reference: the context only
 * emits, and whoever owns the window/WS clients does the delivery. Automation
 * contexts (scoped, no conversation) have no UI and never forward.
 *
 * Modeled on services/ai-terminal/events.ts.
 */

import { EventEmitter } from 'events'
import type { AIBrowserActiveView, AIBrowserConversationReleased, AIBrowserOperating, AIBrowserPageOpened, AIBrowserViewGone } from '../../../shared/types/ai-browser'

export type BrowserActiveViewEvent = AIBrowserActiveView
export type BrowserViewGoneEvent = AIBrowserViewGone
export type BrowserConversationReleasedEvent = AIBrowserConversationReleased
export type BrowserOperatingEvent = AIBrowserOperating

class BrowserEventBus extends EventEmitter {}

export const browserEventBus = new BrowserEventBus()
// Views come and go across long sessions; avoid MaxListeners warnings.
browserEventBus.setMaxListeners(0)

export function emitBrowserActiveView(event: BrowserActiveViewEvent): void {
  browserEventBus.emit('active-view', event)
}

export function emitBrowserPageOpened(event: AIBrowserPageOpened): void {
  browserEventBus.emit('page-opened', event)
}

export function onBrowserPageOpened(handler: (event: AIBrowserPageOpened) => void): () => void {
  browserEventBus.on('page-opened', handler)
  return () => browserEventBus.off('page-opened', handler)
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

export function emitBrowserConversationReleased(event: BrowserConversationReleasedEvent): void {
  browserEventBus.emit('released', event)
}

export function onBrowserConversationReleased(handler: (e: BrowserConversationReleasedEvent) => void): () => void {
  browserEventBus.on('released', handler)
  return () => browserEventBus.off('released', handler)
}

export function emitBrowserOperating(event: BrowserOperatingEvent): void {
  browserEventBus.emit('operating', event)
}

export function onBrowserOperating(handler: (e: BrowserOperatingEvent) => void): () => void {
  browserEventBus.on('operating', handler)
  return () => browserEventBus.off('operating', handler)
}
