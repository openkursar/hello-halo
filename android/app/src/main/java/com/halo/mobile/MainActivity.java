package com.halo.mobile;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import androidx.core.view.WindowCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register custom plugins before super.onCreate()
        registerPlugin(ForegroundServicePlugin.class);
        // Status bar height for the page's layout (see SafeAreaPlugin)
        registerPlugin(SafeAreaPlugin.class);
        super.onCreate(savedInstanceState);

        // Enable edge-to-edge display: let app content draw behind system bars
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);

        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().setDownloadListener(this::handOffDownload);
        }
    }

    /**
     * The WebView cannot save files, so a download it meets (an artifact's
     * download link) goes to the system browser, which fetches it again and
     * saves it under the name the server sends. The URL carries a download
     * ticket, so it is never logged.
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
}
