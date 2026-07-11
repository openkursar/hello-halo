// Package config loads gateway configuration from a YAML file, HALO_GW_*
// environment variables, and command-line flags, in ascending precedence
// (flags > env > file > defaults).
package config

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"time"

	"gopkg.in/yaml.v3"
)

const (
	ModeRelay     = "relay"
	ModeAuthority = "authority"
)

type TLS struct {
	Cert string `yaml:"cert"`
	Key  string `yaml:"key"`
}

type Log struct {
	Level  string `yaml:"level"`  // debug | info | warn | error
	Format string `yaml:"format"` // json | text
}

type Limits struct {
	MaxFrameBytes    int64   `yaml:"maxFrameBytes"`
	ConnPerIPRate    float64 `yaml:"connPerIPRate"`
	ConnPerIPBurst   int     `yaml:"connPerIPBurst"`
	SessionFrameRate float64 `yaml:"sessionFrameRate"`
}

type Room struct {
	HostRetention    time.Duration `yaml:"hostRetention"`
	AdmissionTimeout time.Duration `yaml:"admissionTimeout"`
}

type Directory struct {
	TTL          time.Duration `yaml:"ttl"`
	MaxClockSkew time.Duration `yaml:"maxClockSkew"`
}

type Config struct {
	Mode      string    `yaml:"mode"`
	Listen    string    `yaml:"listen"`
	TLS       TLS       `yaml:"tls"`
	Log       Log       `yaml:"log"`
	Limits    Limits    `yaml:"limits"`
	Room      Room      `yaml:"room"`
	Directory Directory `yaml:"directory"`
}

// Defaults returns the built-in configuration (spec §9 values).
func Defaults() Config {
	return Config{
		Mode:   ModeRelay,
		Listen: ":3100",
		Log:    Log{Level: "info", Format: "json"},
		Limits: Limits{
			MaxFrameBytes:    1 << 20,
			ConnPerIPRate:    10,
			ConnPerIPBurst:   20,
			SessionFrameRate: 500,
		},
		Room: Room{
			HostRetention:    5 * time.Minute,
			AdmissionTimeout: 60 * time.Second,
		},
		Directory: Directory{
			TTL:          90 * time.Second,
			MaxClockSkew: 5 * time.Minute,
		},
	}
}

// Load resolves the effective configuration from args (a flag list, normally
// os.Args[1:]) and the process environment.
func Load(args []string) (Config, error) {
	fs := flag.NewFlagSet("gateway", flag.ContinueOnError)
	configPath := fs.String("config", "", "path to YAML config file")
	listen := fs.String("listen", "", "listen address, e.g. :3100")
	mode := fs.String("mode", "", "gateway mode (relay)")
	tlsCert := fs.String("tls-cert", "", "TLS certificate file")
	tlsKey := fs.String("tls-key", "", "TLS private key file")
	logLevel := fs.String("log-level", "", "log level: debug|info|warn|error")
	logFormat := fs.String("log-format", "", "log format: json|text")
	if err := fs.Parse(args); err != nil {
		return Config{}, err
	}

	cfg := Defaults()

	path := *configPath
	if path == "" {
		path = os.Getenv("HALO_GW_CONFIG")
	}
	if path != "" {
		raw, err := os.ReadFile(path)
		if err != nil {
			return Config{}, fmt.Errorf("config: read %s: %w", path, err)
		}
		if err := yaml.Unmarshal(raw, &cfg); err != nil {
			return Config{}, fmt.Errorf("config: parse %s: %w", path, err)
		}
	}

	applyEnv(&cfg)
	applyFlag(&cfg.Listen, *listen)
	applyFlag(&cfg.Mode, *mode)
	applyFlag(&cfg.TLS.Cert, *tlsCert)
	applyFlag(&cfg.TLS.Key, *tlsKey)
	applyFlag(&cfg.Log.Level, *logLevel)
	applyFlag(&cfg.Log.Format, *logFormat)

	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func applyEnv(cfg *Config) {
	applyFlag(&cfg.Listen, os.Getenv("HALO_GW_LISTEN"))
	applyFlag(&cfg.Mode, os.Getenv("HALO_GW_MODE"))
	applyFlag(&cfg.TLS.Cert, os.Getenv("HALO_GW_TLS_CERT"))
	applyFlag(&cfg.TLS.Key, os.Getenv("HALO_GW_TLS_KEY"))
	applyFlag(&cfg.Log.Level, os.Getenv("HALO_GW_LOG_LEVEL"))
	applyFlag(&cfg.Log.Format, os.Getenv("HALO_GW_LOG_FORMAT"))
}

func applyFlag(dst *string, v string) {
	if v != "" {
		*dst = v
	}
}

// Validate rejects unsupported or inconsistent configuration.
func (c Config) Validate() error {
	switch c.Mode {
	case ModeRelay:
	case ModeAuthority:
		return errors.New("config: mode \"authority\" is not supported: v1-gw implements relay mode only; authority mode is a later milestone (M3)")
	default:
		return fmt.Errorf("config: unknown mode %q (supported: relay)", c.Mode)
	}
	if (c.TLS.Cert == "") != (c.TLS.Key == "") {
		return errors.New("config: tls.cert and tls.key must be set together")
	}
	if c.Listen == "" {
		return errors.New("config: listen must not be empty")
	}
	if c.Limits.MaxFrameBytes <= 0 || c.Limits.ConnPerIPRate <= 0 ||
		c.Limits.ConnPerIPBurst <= 0 || c.Limits.SessionFrameRate <= 0 {
		return errors.New("config: limits must be positive")
	}
	if c.Room.HostRetention <= 0 || c.Room.AdmissionTimeout <= 0 {
		return errors.New("config: room durations must be positive")
	}
	if c.Directory.TTL <= 0 || c.Directory.MaxClockSkew <= 0 {
		return errors.New("config: directory durations must be positive")
	}
	return nil
}
