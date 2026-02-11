/**		      	    				  	  	  	 		 		       	 	 	         	 	    					 
 * Halo - React Entry Point
 */

// ========================================
// LOGGING INITIALIZATION (must be first)
// ========================================
// Initialize electron-log only in Electron environment.
// In remote browser mode, native console is used since there's no IPC transport.
// Uses the same detection pattern as src/renderer/api/transport.ts:isElectron()
// Non-blocking: don't use top-level await to avoid blocking module graph in Vite dev mode
if (typeof window !== 'undefined' && 'halo' in window) {
  import('electron-log/renderer.js').then(({ default: log }) => {
    Object.assign(console, log.functions)
  })
}

import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'

// i18n configuration - must be imported before App
import './i18n'

// CSS imports - order matters for cascade
import './assets/styles/globals.css'       // Theme, base styles, shared animations
import './assets/styles/syntax-theme.css'  // Code syntax highlighting (highlight.js)
import './assets/styles/canvas-tabs.css'   // VS Code style tab bar
import './assets/styles/browser-task-card.css' // AI Browser sci-fi effects

// Mark React as mounted - disables global error fallback (React handles errors now)
// This flag is checked by the global error handler in index.html
;(window as unknown as { __HALO_APP_MOUNTED__: boolean }).__HALO_APP_MOUNTED__ = true
// __HALO_EGG__
;(() => { const c = [72,101,108,108,111,44,32,73,39,109,32,72,97,108,111,46,32,67,111,110,103,114,97,116,115,44,32,121,111,117,39,118,101,32,102,111,117,110,100,32,116,104,101,32,101,97,115,116,101,114,32,101,103,103,33]; console.log('%c' + String.fromCharCode(...c), 'color:#666;font-style:italic'); })()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
)
