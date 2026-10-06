package com.halo.mobile;

import android.content.res.Resources;
import android.os.Build;
import android.webkit.WebView;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Gives the page the status bar height as `--safe-area-inset-top`, which its
 * layout keeps clear of (see globals.css).
 *
 * Below Android 15 nothing else does: the WebView reports
 * env(safe-area-inset-top) as 0, and the built-in SystemBars plugin only
 * writes these variables from Android 15 on, where this plugin stays out of
 * its way. The value lives in the document's inline style and goes away with
 * the document, so it is written again whenever a page finishes loading, the
 * app comes back to the foreground or the insets change (rotation, split
 * screen). A page that starts before any of that asks with getInsets().
 */
@CapacitorPlugin(name = "SafeArea")
public class SafeAreaPlugin extends Plugin {

    /** Assumed when the system reports no insets yet. */
    private static final int DEFAULT_STATUS_BAR_DP = 24;

    /** What the current page was last given, so unchanged insets write nothing. */
    private int writtenTopDp = -1;

    @Override
    public void load() {
        super.load();
        if (handledBySystemBars()) return;

        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView webView) {
                writeTop(currentTopDp());
            }
        });
        ViewCompat.setOnApplyWindowInsetsListener(getBridge().getWebView(), (view, insets) -> {
            int top = topDp(insets);
            if (top != writtenTopDp) writeTop(top);
            return ViewCompat.onApplyWindowInsets(view, insets);
        });
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!handledBySystemBars()) writeTop(currentTopDp());
    }

    /** Resolves `{ top }` in CSS pixels; without `top` from Android 15 on, where SystemBars writes it. */
    @PluginMethod
    public void getInsets(PluginCall call) {
        getBridge().executeOnMainThread(() -> {
            JSObject result = new JSObject();
            if (!handledBySystemBars()) result.put("top", currentTopDp());
            call.resolve(result);
        });
    }

    private static boolean handledBySystemBars() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM;
    }

    private int currentTopDp() {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getBridge().getWebView());
        if (insets != null) return topDp(insets);
        Resources resources = getContext().getResources();
        int resourceId = resources.getIdentifier("status_bar_height", "dimen", "android");
        if (resourceId > 0) return toDp(resources.getDimensionPixelSize(resourceId));
        return DEFAULT_STATUS_BAR_DP;
    }

    // The same area SystemBars measures: the status bar, or a notch reaching below it.
    private int topDp(WindowInsetsCompat insets) {
        return toDp(insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()).top);
    }

    private int toDp(int px) {
        return Math.round(px / getContext().getResources().getDisplayMetrics().density);
    }

    private void writeTop(int dp) {
        writtenTopDp = dp;
        getBridge().getWebView().evaluateJavascript(
            "document.documentElement.style.setProperty('--safe-area-inset-top', '" + dp + "px')",
            null
        );
    }
}
