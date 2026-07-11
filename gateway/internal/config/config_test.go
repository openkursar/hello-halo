package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDefaults(t *testing.T) {
	cfg, err := Load(nil)
	if err != nil {
		t.Fatalf("load defaults: %v", err)
	}
	if cfg.Mode != ModeRelay || cfg.Listen != ":3100" {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.Limits.MaxFrameBytes != 1<<20 || cfg.Limits.SessionFrameRate != 500 {
		t.Fatalf("unexpected limit defaults: %+v", cfg.Limits)
	}
	if cfg.Room.HostRetention != 5*time.Minute || cfg.Room.AdmissionTimeout != 60*time.Second {
		t.Fatalf("unexpected room defaults: %+v", cfg.Room)
	}
	if cfg.Directory.TTL != 90*time.Second || cfg.Directory.MaxClockSkew != 5*time.Minute {
		t.Fatalf("unexpected directory defaults: %+v", cfg.Directory)
	}
}

func TestAuthorityModeRefusesToStart(t *testing.T) {
	_, err := Load([]string{"-mode", "authority"})
	if err == nil || !strings.Contains(err.Error(), "relay mode only") {
		t.Fatalf("authority mode must be rejected with guidance, got: %v", err)
	}
}

func TestPrecedenceFileEnvFlag(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("listen: \":1111\"\nlog:\n  level: debug\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Setenv("HALO_GW_LISTEN", ":2222")
	cfg, err := Load([]string{"-config", path})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Listen != ":2222" {
		t.Fatalf("env should override file: %q", cfg.Listen)
	}
	if cfg.Log.Level != "debug" {
		t.Fatalf("file value lost: %q", cfg.Log.Level)
	}

	cfg, err = Load([]string{"-config", path, "-listen", ":3333"})
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if cfg.Listen != ":3333" {
		t.Fatalf("flag should override env: %q", cfg.Listen)
	}
}

func TestTLSRequiresBoth(t *testing.T) {
	if _, err := Load([]string{"-tls-cert", "/tmp/cert.pem"}); err == nil {
		t.Fatal("cert without key must be rejected")
	}
}
