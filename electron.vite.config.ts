import { resolve } from 'path'
import { readFileSync, existsSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * Load environment variables from .env.local
 * These will be injected at build time via `define`
 */
function loadEnvLocal(): Record<string, string> {
  const envPath = resolve(__dirname, '.env.local')
  const env: Record<string, string> = {}

  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith('#')) continue

      const eqIndex = trimmed.indexOf('=')
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim()
        let value = trimmed.slice(eqIndex + 1).trim()
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        env[key] = value
      }
    }
  }

  return env
}

const envLocal = loadEnvLocal()

/**
 * Build-time injected analytics config
 * In open-source builds without .env.local, these will be empty strings (analytics disabled)
 */
const analyticsDefine = {
  '__HALO_GA_MEASUREMENT_ID__': JSON.stringify(envLocal.HALO_GA_MEASUREMENT_ID || ''),
  '__HALO_GA_API_SECRET__': JSON.stringify(envLocal.HALO_GA_API_SECRET || ''),
  '__HALO_BAIDU_SITE_ID__': JSON.stringify(envLocal.HALO_BAIDU_SITE_ID || ''),
  // Self-hosted telemetry endpoint + bearer key.
  // When either value is empty the TelemetryProvider is disabled (default in open-source builds).
  '__HALO_TELEMETRY_ENDPOINT__': JSON.stringify(envLocal.HALO_TELEMETRY_ENDPOINT || ''),
  '__HALO_TELEMETRY_API_KEY__': JSON.stringify(envLocal.HALO_TELEMETRY_API_KEY || ''),
}

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
    define: analyticsDefine,
    build: {
      sourcemap: true,
      rollupOptions: {
        external: ['@hello-halo/agent-sdk', '@openai/codex-sdk'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // File watcher worker — runs in a separate child process
          'worker/file-watcher/index': resolve(__dirname, 'src/worker/file-watcher/index.ts')
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
