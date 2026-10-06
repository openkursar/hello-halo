package com.halo.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    /**
     * Bridge / WebView readiness retry budget for safe-area injection.
     * 10 attempts × 200 ms = up to 2 s. If the WebView is not ready by then
     * we give up — the JS-side fallbacks (Capacitor SystemBars on Android 16+,
     * or the renderer's visualViewport listener) will still set the variable
     * later when the page actually mounts.
     */
    private static final int SAFE_AREA_RETRY_MAX = 10;
    private static final long SAFE_AREA_RETRY_DELAY_MS = 200L;

    /** Default status bar height assumption (24dp) when all measurements fail. */
    private static final int DEFAULT_STATUS_BAR_DP = 24;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate()
        registerPlugin(ForegroundServicePlugin.class);
        super.onCreate(savedInstanceState);

        // Enable edge-to-edge display: let app content draw behind system bars
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setDownloadListener(this::handOffDownload);
        }

        // Inject status bar height as CSS variable for safe area padding.
        // Capacitor's built-in SystemBars plugin only injects CSS variables
        // on Android 16+ (VANILLA_ICE_CREAM). On earlier versions (including
        // MIUI 14 / Android 13-14), we handle it here so CSS env(safe-area-inset-top)
        // fallback (which returns 0 on Android WebView) is replaced with real values.
        injectSafeAreaInsets();
    }

    private void injectSafeAreaInsets() {
        getWindow().getDecorView().post(new Runnable() {
            private int attempts = 0;

            @Override
            public void run() {
                if (bridge == null || bridge.getWebView() == null) {
                    if (++attempts >= SAFE_AREA_RETRY_MAX) {
                        // Give up. Renderer-side fallbacks (visualViewport listener,
                        // Capacitor SystemBars on Android 16+) will still recover.
                        android.util.Log.w("Halo", "Safe-area injection skipped: WebView not ready after "
                                + SAFE_AREA_RETRY_MAX + " attempts");
                        return;
                    }
                    getWindow().getDecorView().postDelayed(this, SAFE_AREA_RETRY_DELAY_MS);
                    return;
                }

                int statusBarHeightPx = getStatusBarHeight();
                float density = getResources().getDisplayMetrics().density;
                int statusBarDp = Math.round(statusBarHeightPx / density);

                WebView webView = bridge.getWebView();
                String script = "try {"
                        + "document.documentElement.style.setProperty('--safe-area-inset-top', '"
                        + statusBarDp + "px');"
                        + "} catch(e) { console.warn('safe-area-inset-top injection failed:', e); }";
                webView.evaluateJavascript(script, null);
            }
        });
    }

    /**
     * The WebView cannot save files, so a download it meets (an artifact's
     * download link) goes to the system browser, which fetches it again and
     * saves it under the name the server sends. The URL carries the access
     * token, so it is never logged.
     */
    private void handOffDownload(String url, String userAgent, String contentDisposition, String mimeType, long contentLength) {
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            Log.w("Halo", "Download not handed off: unsupported scheme " + scheme);
            return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Log.w("Halo", "Download not handed off: no app opens web links");
        }
    }

    private int getStatusBarHeight() {
        // Method 1: Get from WindowInsets (most accurate, requires API 30+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
            if (insets != null) {
                int topInset = insets.getInsets(android.view.WindowInsets.Type.statusBars()).top;
                if (topInset > 0) return topInset;
            }
        }

        // Method 2: Get from Android resource system (works on all API levels)
        int resourceId = getResources().getIdentifier("status_bar_height", "dimen", "android");
        if (resourceId > 0) {
            int px = getResources().getDimensionPixelSize(resourceId);
            if (px > 0) return px;
        }

        // Method 3: Fallback - compute from display metrics (~24dp)
        float density = getResources().getDisplayMetrics().density;
        return Math.round(DEFAULT_STATUS_BAR_DP * density);
    }
}
