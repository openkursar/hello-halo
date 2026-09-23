package fsx

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func testPolicy() Policy {
	p := Default()
	p.Base = time.Millisecond
	p.Max = time.Millisecond
	p.Sleep = func(time.Duration) {}
	return p
}

func TestMoveWithRetryRetriesOnlyTransientFailures(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "a.dll")
	if err := os.WriteFile(src, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	p := testPolicy()
	attempts := 0
	p.Sleep = func(time.Duration) { attempts++ }

	// A missing source is permanent: retrying it would only delay a reversal.
	if err := p.MoveWithRetry(filepath.Join(root, "missing"), filepath.Join(root, "b.dll")); err == nil {
		t.Fatal("expected a failure")
	}
	if attempts != 0 {
		t.Errorf("slept %d times for a permanent failure", attempts)
	}

	if err := p.MoveWithRetry(src, filepath.Join(root, "sub", "a.dll")); err != nil {
		t.Fatalf("move: %v", err)
	}
	if Exists(src) || !Exists(filepath.Join(root, "sub", "a.dll")) {
		t.Error("file did not move")
	}
}

func TestRemoveWithRetry(t *testing.T) {
	root := t.TempDir()
	tree := filepath.Join(root, "staged", "resources")
	if err := os.MkdirAll(tree, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tree, "app.asar"), []byte("x"), 0o444); err != nil {
		t.Fatal(err)
	}

	p := testPolicy()
	if err := p.RemoveWithRetry(filepath.Join(root, "staged")); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if Exists(filepath.Join(root, "staged")) {
		t.Error("tree survived")
	}
	// Removing what is already gone is how a retry finishes.
	if err := p.RemoveWithRetry(filepath.Join(root, "staged")); err != nil {
		t.Fatalf("second remove: %v", err)
	}
}

func TestIsTransient(t *testing.T) {
	if IsTransient(nil) {
		t.Error("nil is not transient")
	}
	if IsTransient(fs.ErrNotExist) {
		t.Error("a missing file is permanent")
	}
	if IsTransient(errors.New("boom")) {
		t.Error("an unclassified error is permanent")
	}
	if !IsTransient(&os.LinkError{Err: syscall.EACCES}) {
		t.Error("a lock-like errno should be retried")
	}
}

func TestWithinPath(t *testing.T) {
	root := filepath.FromSlash("/apps/Halo")
	inside := []string{root, filepath.Join(root, "resources"), filepath.Join(root, "a", "b")}
	for _, path := range inside {
		if !WithinPath(root, path) {
			t.Errorf("WithinPath(%q, %q) = false", root, path)
		}
	}
	outside := []string{filepath.FromSlash("/apps"), filepath.FromSlash("/apps/HaloOther"), filepath.FromSlash("/tmp/x")}
	for _, path := range outside {
		if WithinPath(root, path) {
			t.Errorf("WithinPath(%q, %q) = true", root, path)
		}
	}
}
