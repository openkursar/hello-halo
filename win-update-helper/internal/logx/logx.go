// Package logx writes one line per step to stdout and, when configured, to a
// log file. The Electron main process reads stdout live; the file is what a
// user can attach to a bug report after a failed update.
package logx

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const prefix = "[helper]"

type Logger struct {
	mu   sync.Mutex
	out  io.Writer
	file *os.File
}

// New always returns a usable logger: a log file that cannot be opened is
// reported and then ignored, because losing the log must not fail an update.
func New(path string) *Logger {
	l := &Logger{out: os.Stdout}
	if path == "" {
		return l
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		l.Errorf("log directory unavailable (%s): %v", path, err)
		return l
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		l.Errorf("log file unavailable (%s): %v", path, err)
		return l
	}
	l.file = f
	l.out = io.MultiWriter(os.Stdout, f)
	return l
}

func (l *Logger) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
		l.out = os.Stdout
	}
}

func (l *Logger) Infof(format string, args ...any) { l.write("", format, args...) }

func (l *Logger) Errorf(format string, args ...any) { l.write("ERROR ", format, args...) }

func (l *Logger) write(level, format string, args ...any) {
	line := fmt.Sprintf("%s %s %s%s\n", prefix, time.Now().Format(time.RFC3339), level, fmt.Sprintf(format, args...))
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = io.WriteString(l.out, line)
	if l.file != nil {
		_ = l.file.Sync()
	}
}

// Discard is for tests and for code paths that run before flags are parsed.
func Discard() *Logger { return &Logger{out: io.Discard} }
