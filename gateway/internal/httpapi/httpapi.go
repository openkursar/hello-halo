// Package httpapi assembles the gateway's HTTP surface (§9.5): /ws upgrade,
// probes, version, Prometheus metrics, and the invite landing page.
package httpapi

import (
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"

	"github.com/openkursar/hello-halo/gateway/internal/invite"
	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/room"
	"github.com/openkursar/hello-halo/gateway/internal/session"
)

// VersionInfo is served at /version.
type VersionInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Mode    string `json:"mode"`
}

// Server wires sessions to the hub and exposes the HTTP endpoints.
type Server struct {
	hub       *room.Hub
	metrics   *metrics.Metrics
	log       *slog.Logger
	version   VersionInfo
	ipLimiter *session.IPLimiter
	sessOpts  session.Options
	upgrader  websocket.Upgrader

	ready    atomic.Bool
	mu       sync.Mutex
	sessions map[*session.Session]struct{}
}

// Options for the server; session options are passed through to each accepted
// connection.
type Options struct {
	Hub            *room.Hub
	Metrics        *metrics.Metrics
	Logger         *slog.Logger
	Version        VersionInfo
	SessionOptions session.Options
	ConnPerIPRate  float64
	ConnPerIPBurst int
}

func New(opts Options) *Server {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Metrics == nil {
		opts.Metrics = metrics.New()
	}
	if opts.ConnPerIPRate == 0 {
		opts.ConnPerIPRate = 10
	}
	if opts.ConnPerIPBurst == 0 {
		opts.ConnPerIPBurst = 20
	}
	s := &Server{
		hub:       opts.Hub,
		metrics:   opts.Metrics,
		log:       opts.Logger,
		version:   opts.Version,
		ipLimiter: session.NewIPLimiter(opts.ConnPerIPRate, opts.ConnPerIPBurst),
		sessOpts:  opts.SessionOptions,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			// Clients are native Halo nodes, not browsers; browser pages have
			// no credentials to ride on, so cross-origin upgrades are harmless.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
	s.ready.Store(true)
	s.sessions = make(map[*session.Session]struct{})
	return s
}

// Handler returns the root HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	invitePage := invite.Handler()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		invitePage.ServeHTTP(w, r)
	})
	mux.Handle("/invite", invitePage)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if !s.ready.Load() {
			http.Error(w, "shutting down", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/version", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.version)
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		s.metrics.WritePrometheus(w)
	})
	mux.HandleFunc("/ws", s.handleWS)
	return mux
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	if !s.ready.Load() {
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if !s.ipLimiter.Allow(ip, time.Now()) {
		s.metrics.RateLimitedTotal.Add(1)
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	s.metrics.ConnectionsTotal.Add(1)

	queue := room.NewPlaneQueue(s.metrics)
	opts := s.sessOpts
	opts.Logger = s.log
	opts.Metrics = s.metrics
	sess := session.New(conn, queue, s.hub, opts)

	s.mu.Lock()
	s.sessions[sess] = struct{}{}
	s.mu.Unlock()

	go func() {
		sess.Run()
		s.mu.Lock()
		delete(s.sessions, sess)
		s.mu.Unlock()
	}()
}

// BeginShutdown flips readiness off and closes every live session.
func (s *Server) BeginShutdown() {
	s.ready.Store(false)
	s.hub.Shutdown()
	s.mu.Lock()
	live := make([]*session.Session, 0, len(s.sessions))
	for sess := range s.sessions {
		live = append(live, sess)
	}
	s.mu.Unlock()
	for _, sess := range live {
		sess.Close()
	}
}
