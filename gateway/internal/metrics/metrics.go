// Package metrics is a dependency-free Prometheus text exporter backed by
// atomic counters and gauges.
package metrics

import (
	"fmt"
	"io"
	"sync/atomic"
)

// Metrics holds every counter the gateway exposes at /metrics.
type Metrics struct {
	ConnectionsTotal     atomic.Int64
	SessionsActive       atomic.Int64
	RoomsActive          atomic.Int64
	AuthFailuresTotal    atomic.Int64
	RateLimitedTotal     atomic.Int64
	FramesRejectedTotal  atomic.Int64
	FramesForwardedTotal [3]atomic.Int64 // indexed by wire.Plane
	FramesDroppedTotal   [3]atomic.Int64
	AnnouncesTotal       atomic.Int64
	AnnounceRejectsTotal atomic.Int64
	EvictionsTotal       atomic.Int64
	HostTakeoversTotal   atomic.Int64
}

func New() *Metrics { return &Metrics{} }

var planeNames = [3]string{"control", "stream", "artifact"}

// WritePrometheus renders all metrics in the Prometheus text exposition format.
func (m *Metrics) WritePrometheus(w io.Writer) {
	gauge := func(name, help string, v int64) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s gauge\n%s %d\n", name, help, name, name, v)
	}
	counter := func(name, help string, v int64) {
		fmt.Fprintf(w, "# HELP %s %s\n# TYPE %s counter\n%s %d\n", name, help, name, name, v)
	}

	counter("halo_gw_connections_total", "Total accepted WebSocket connections.", m.ConnectionsTotal.Load())
	gauge("halo_gw_sessions_active", "Currently authenticated sessions.", m.SessionsActive.Load())
	gauge("halo_gw_rooms_active", "Currently active rooms.", m.RoomsActive.Load())
	counter("halo_gw_auth_failures_total", "Failed authentication attempts.", m.AuthFailuresTotal.Load())
	counter("halo_gw_rate_limited_total", "Sessions or connections rejected by rate limits.", m.RateLimitedTotal.Load())
	counter("halo_gw_frames_rejected_total", "Frames dropped for protocol violations (e.g. fromNode mismatch).", m.FramesRejectedTotal.Load())
	counter("halo_gw_announces_total", "Accepted directory announcements.", m.AnnouncesTotal.Load())
	counter("halo_gw_announce_rejects_total", "Rejected directory announcements.", m.AnnounceRejectsTotal.Load())
	counter("halo_gw_evictions_total", "Member sessions evicted by hosts.", m.EvictionsTotal.Load())
	counter("halo_gw_host_takeovers_total", "Rooms taken over by a different host identity after the retention window.", m.HostTakeoversTotal.Load())

	fmt.Fprintf(w, "# HELP halo_gw_frames_forwarded_total Frames forwarded per plane.\n# TYPE halo_gw_frames_forwarded_total counter\n")
	for i, name := range planeNames {
		fmt.Fprintf(w, "halo_gw_frames_forwarded_total{plane=%q} %d\n", name, m.FramesForwardedTotal[i].Load())
	}
	fmt.Fprintf(w, "# HELP halo_gw_frames_dropped_total Frames dropped by plane queue overflow.\n# TYPE halo_gw_frames_dropped_total counter\n")
	for i, name := range planeNames {
		fmt.Fprintf(w, "halo_gw_frames_dropped_total{plane=%q} %d\n", name, m.FramesDroppedTotal[i].Load())
	}
}
