// Package invite serves the office-invite landing page (§9.4). The page is
// fully self-contained (no external resources) and the invite token is never
// echoed into the HTML: the halo://join deep link is assembled client-side
// from location.search, so the served body carries no secret.
package invite

import (
	_ "embed"
	"net/http"
)

//go:embed page.html
var page []byte

// Handler serves the landing page.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
		_, _ = w.Write(page)
	})
}
