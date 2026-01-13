/**
 * Halo Overlay - Separate SPA for floating UI elements
 *
 * This SPA runs in a separate WebContentsView that renders above
 * BrowserViews (the AI Browser). It handles all floating UI elements
 * like the chat capsule, dialogs, menus, tooltips, etc.
 *
 * Architecture:
 * - Main Window (BrowserWindow)
 *   └── contentView (root)
 *       ├── Main UI WebContentsView (chat, canvas, etc.)
 *       ├── BrowserView(s) for AI Browser tabs
 *       └── Overlay WebContentsView (this SPA) - topmost layer
 *
 * Communication:
 * - Receives route/state changes via IPC from main UI
 * - Sends user interactions back via IPC
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { OverlayApp } from './overlay/OverlayApp'
// Initialize shared i18n for the overlay experience
import './i18n'
// NOTE: Don't import globals.css here - it sets body background color
// which breaks transparency. Overlay needs transparent background.
import './overlay/overlay.css'

const rootElement = document.getElementById('root')

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<OverlayApp />)
}
