// Package fsx holds every filesystem mutation the helper performs, so the
// retry policy for Windows file locks exists in exactly one place.
package fsx

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// Windows error codes seen when antivirus scanners or child processes still
// hold a handle on a file moments after the app exits. They clear on their own.
const (
	winAccessDenied     = 5
	winSharingViolation = 32
	winLockViolation    = 33
)

type Policy struct {
	Attempts int
	Base     time.Duration
	Max      time.Duration
	Sleep    func(time.Duration)
	Logf     func(format string, args ...any)
}

func Default() Policy {
	return Policy{Attempts: 10, Base: 200 * time.Millisecond, Max: 2 * time.Second}
}

// MoveWithRetry renames src onto dst. dst must not exist: rename is the only
// primitive that makes a swap reversible, and silently clobbering dst would
// destroy the copy a reversal needs.
func (p Policy) MoveWithRetry(src, dst string) error {
	return p.retry(fmt.Sprintf("move %s -> %s", src, dst), func() error {
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return err
		}
		return os.Rename(src, dst)
	})
}

func (p Policy) RemoveWithRetry(path string) error {
	return p.retry("remove "+path, func() error {
		err := os.RemoveAll(path)
		if err != nil {
			clearReadOnly(path)
		}
		return err
	})
}

func (p Policy) retry(what string, op func() error) error {
	attempts := p.Attempts
	if attempts < 1 {
		attempts = 1
	}
	delay := p.Base
	var err error
	for attempt := 1; attempt <= attempts; attempt++ {
		if err = op(); err == nil {
			return nil
		}
		if !IsTransient(err) || attempt == attempts {
			break
		}
		p.logf("%s: locked (attempt %d/%d), retrying in %s", what, attempt, attempts, delay)
		p.sleep(delay)
		if delay = delay * 3 / 2; p.Max > 0 && delay > p.Max {
			delay = p.Max
		}
	}
	return fmt.Errorf("%s: %w", what, err)
}

func (p Policy) sleep(d time.Duration) {
	if p.Sleep != nil {
		p.Sleep(d)
		return
	}
	time.Sleep(d)
}

func (p Policy) logf(format string, args ...any) {
	if p.Logf != nil {
		p.Logf(format, args...)
	}
}

// IsTransient reports whether err is the kind of lock contention that clears
// on its own. Anything else (missing file, cross-volume rename) is permanent
// and must fail immediately so the caller can reverse.
func IsTransient(err error) bool {
	if err == nil || errors.Is(err, fs.ErrNotExist) {
		return false
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		if runtime.GOOS == "windows" {
			switch uintptr(errno) {
			case winAccessDenied, winSharingViolation, winLockViolation:
				return true
			}
			return false
		}
		return errors.Is(errno, syscall.EBUSY) || errors.Is(errno, syscall.EACCES) ||
			errors.Is(errno, syscall.EPERM) || errors.Is(errno, syscall.ETXTBSY)
	}
	return errors.Is(err, fs.ErrPermission)
}

// clearReadOnly strips the Windows read-only attribute, which survives an
// uninstall/reinstall and makes RemoveAll fail with access denied.
func clearReadOnly(root string) {
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		mode := fs.FileMode(0o600)
		if d.IsDir() {
			mode = 0o700
		}
		_ = os.Chmod(path, mode)
		return nil
	})
}

// TopLevelNames lists the immediate children of dir. A missing dir yields no
// names rather than an error: callers treat "nothing there" as "nothing to do".
func TopLevelNames(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names, nil
}

func Exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// SamePath compares two paths the way the host filesystem would. Windows paths
// are case-insensitive, and the install directory is routinely referred to with
// different casing by the registry, shortcuts and the running process.
func SamePath(a, b string) bool {
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// WithinPath reports whether child is parent or lives underneath it.
func WithinPath(parent, child string) bool {
	if SamePath(parent, child) {
		return true
	}
	rel, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}
