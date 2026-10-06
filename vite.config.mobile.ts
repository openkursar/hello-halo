/**
 * Vite configuration for Capacitor mobile build.
 *
 * Independent from electron-vite to avoid pulling in Electron dependencies.
 * Builds the same React SPA from src/renderer/ into dist-mobile/.
 */
import { resolve } from 'path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Artifact images load straight from the Halo computer, which a LAN serves
// over plain http; the page policy shared with the desktop allows remote
// images only over https.
export const allowHttpImages: Plugin = {
  name: 'halo-mobile-http-images',
  transformIndexHtml: (html) => html.replace(/img-src [^;"]*/, (directive) => `${directive} http:`)
}

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',

  define: {
    // Mark as Capacitor build so code can detect at compile time
    '__CAPACITOR__': JSON.stringify(true),
    '__BUILD_TIME__': JSON.stringify(new Date().toISOString()),
    // Disable analytics define placeholders (not used in mobile)
    '__HALO_GA_MEASUREMENT_ID__': JSON.stringify(''),
    '__HALO_GA_API_SECRET__': JSON.stringify(''),
    '__HALO_BAIDU_SITE_ID__': JSON.stringify('')
  },

  plugins: [react(), allowHttpImages],

  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      // Stub out electron-only modules that may be imported
      'electron-log/renderer.js': resolve(__dirname, 'src/renderer/lib/empty-module.ts'),
      'electron-log/renderer': resolve(__dirname, 'src/renderer/lib/empty-module.ts'),
      'electron-log': resolve(__dirname, 'src/renderer/lib/empty-module.ts')
    }
  },

  build: {
    outDir: resolve(__dirname, 'dist-mobile'),
    emptyOutDir: true,
    // Optimize chunk splitting for mobile
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html')
      },
      // Externalize electron-specific modules
      external: [
        'electron',
        'electron-log',
        'electron-log/renderer',
        'electron-log/renderer.js'
      ]
    },
    // Smaller chunks for faster mobile loading
    chunkSizeWarningLimit: 1000
  },

  // CSS processing uses the same postcss/tailwind config
  css: {
    postcss: resolve(__dirname, 'postcss.config.cjs')
  }
})
