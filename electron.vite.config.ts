import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Telemetry / analytics identifiers are deliberately NOT injected at build
// time. They are per-variant configuration in product.json, read at runtime
// by the analytics service — a missing value is a verify-inputs failure
// (scripts/release/), never a silently-empty constant baked into the bundle.

/**
 * Build-time metadata injected into the renderer bundle
 */
const buildMetaDefine = {
  '__BUILD_TIME__': JSON.stringify(new Date().toISOString()),
}

export default defineConfig({
  main: {
    plugins: [
      // The main process builds to CommonJS because Electron 29's ESM loader rejects
      // named imports from 'electron'. Bundle ESM-only packages (uuid, open,
      // proxy-agent) that cannot be require()'d. @xterm/headless is also bundled
      // for CJS-ESM interop. node-pty and better-sqlite3 stay external (native addons).
      externalizeDepsPlugin({ exclude: ['@xterm/headless', '@electron-toolkit/utils', 'uuid', 'open', 'proxy-agent'] })
    ],
    build: {
      sourcemap: true,
      rollupOptions: {
        external: ['@hello-halo/agent-sdk', '@openai/codex-sdk'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // File watcher worker — runs in a separate child process
          'worker/file-watcher/index': resolve(__dirname, 'src/worker/file-watcher/index.ts'),
          // Pty host worker — owns all terminal ptys in a separate child process
          'worker/pty-host/index': resolve(__dirname, 'src/worker/pty-host/index.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        },
        output: {
          format: 'es',
          entryFileNames: '[name].mjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    server: {
      // Explicit IPv4 bind. Node 17+ on macOS may resolve `localhost` to ::1,
      // making Vite single-stack IPv6 while Electron's Chromium connects via
      // IPv4 → ERR_CONNECTION_REFUSED → blank window. Pinning to 127.0.0.1
      // matches Electron's resolution and stays loopback-only.
      host: '127.0.0.1',
      port: 5173,
      strictPort: true
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    },
    // App.tsx only reaches the page components through React.lazy()/dynamic
    // import(), so Vite's initial esbuild dep scan (which starts from
    // index.html and follows *static* imports) never sees the packages they
    // pull in. The first navigation to one of them then triggers a runtime
    // "missing dependency" re-optimization, which invalidates chunk hashes
    // already in flight and surfaces as "Failed to fetch dynamically
    // imported module" in the window. Listing the pages here makes the
    // initial scan crawl into them too, so their deps are pre-bundled before
    // the window ever loads.
    optimizeDeps: {
      entries: ['src/renderer/index.html', 'src/renderer/pages/*.tsx']
    },
    define: buildMetaDefine,
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer')
      }
    }
  }
})
