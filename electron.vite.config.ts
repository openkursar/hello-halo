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
      // Bundle @xterm/headless (pure-JS CommonJS) instead of externalizing it —
      // its named exports are not reachable via ESM interop when left external.
      // node-pty stays external (native addon).
      externalizeDepsPlugin({ exclude: ['@xterm/headless'] })
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
          format: 'es',
          entryFileNames: '[name].mjs'
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
    define: buildMetaDefine,
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer')
      }
    }
  }
})
