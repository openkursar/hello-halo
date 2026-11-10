import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.halo.mobile',
  appName: 'Halo',
  // Vite mobile build output directory
  webDir: 'dist-mobile',
  // Server configuration: load from local assets (not a remote URL)
  server: {
    // Use http scheme to avoid mixed-content CORS preflight failures on Android WebView.
    // With 'https', POST requests (which trigger OPTIONS preflight) to http:// LAN servers
    // are intermittently blocked by Android WebView's mixed-content policy.
    androidScheme: 'http',
    // Allow navigation to any origin (needed for WebSocket connections)
    allowNavigation: ['*']
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 500,
      backgroundColor: '#0a0a0a',
      showSpinner: false
    },
    Keyboard: {
      // Resize the WebView itself, not document.body. globals.css pins #root
      // with position: fixed, which ignores body height, so a 'body' resize
      // never lifts the bottom-anchored composer above the keyboard.
      resize: 'native' as any,
      resizeOnFullScreen: true
    },
    LocalNotifications: {
      // Use default notification channel
      smallIcon: 'ic_notification',
      iconColor: '#3b82f6'
    }
  },
  android: {
    // Enable edge-to-edge display to prevent statusbar overlap
    edgeToEdge: true,
    // Allow cleartext traffic for LAN connections (http://)
    allowMixedContent: true,
    // Background mode: keep WebSocket alive
    backgroundColor: '#0a0a0a'
  }
}

export default config
