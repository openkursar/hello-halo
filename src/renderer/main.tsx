/**
 * Halo - React Entry Point
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// i18n configuration - must be imported before App
import './i18n'

// CSS imports - order matters for cascade
import './assets/styles/globals.css'       // Theme, base styles, shared animations
import './assets/styles/syntax-theme.css'  // Code syntax highlighting (highlight.js)
import './assets/styles/canvas-tabs.css'   // VS Code style tab bar
import './assets/styles/browser-task-card.css' // AI Browser sci-fi effects


ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
