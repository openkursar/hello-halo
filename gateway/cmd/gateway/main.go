// Halo federation gateway (relay mode): a dumb relay + discovery directory +
// invite landing page for enterprise intranet deployments. See §9 of the
// federation wire protocol for the normative behavior.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/openkursar/hello-halo/gateway/internal/config"
	"github.com/openkursar/hello-halo/gateway/internal/directory"
	"github.com/openkursar/hello-halo/gateway/internal/httpapi"
	"github.com/openkursar/hello-halo/gateway/internal/metrics"
	"github.com/openkursar/hello-halo/gateway/internal/room"
	"github.com/openkursar/hello-halo/gateway/internal/session"
)

// Set via -ldflags at build time.
var (
	version = "dev"
	commit  = "unknown"
)

func main() {
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		slog.Error("configuration error", "err", err)
		os.Exit(1)
	}
	log := newLogger(cfg.Log)

	m := metrics.New()
	dir := directory.New(directory.Options{
		TTL:          cfg.Directory.TTL,
		MaxClockSkew: cfg.Directory.MaxClockSkew,
	})
	hub := room.NewHub(room.Config{
		AdmissionTimeout: cfg.Room.AdmissionTimeout,
		HostRetention:    cfg.Room.HostRetention,
	}, dir, log, m)

	api := httpapi.New(httpapi.Options{
		Hub:     hub,
		Metrics: m,
		Logger:  log,
		Version: httpapi.VersionInfo{
			Name:    "halo-gateway",
			Version: version,
			Commit:  commit,
			Mode:    cfg.Mode,
		},
		SessionOptions: session.Options{
			MaxFrameBytes: cfg.Limits.MaxFrameBytes,
			FrameRate:     cfg.Limits.SessionFrameRate,
		},
		ConnPerIPRate:  cfg.Limits.ConnPerIPRate,
		ConnPerIPBurst: cfg.Limits.ConnPerIPBurst,
	})

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("gateway listening",
			"addr", cfg.Listen, "mode", cfg.Mode, "tls", cfg.TLS.Cert != "",
			"version", version, "commit", commit)
		if cfg.TLS.Cert != "" {
			errCh <- server.ListenAndServeTLS(cfg.TLS.Cert, cfg.TLS.Key)
		} else {
			errCh <- server.ListenAndServe()
		}
	}()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server failed", "err", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		log.Info("shutdown signal received; draining")
		api.BeginShutdown()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Warn("forcing close after shutdown timeout", "err", err)
			_ = server.Close()
		}
		log.Info("gateway stopped")
	}
}

func newLogger(cfg config.Log) *slog.Logger {
	var level slog.Level
	switch cfg.Level {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: level}
	var handler slog.Handler
	if cfg.Format == "text" {
		handler = slog.NewTextHandler(os.Stderr, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stderr, opts)
	}
	log := slog.New(handler)
	slog.SetDefault(log)
	return log
}
