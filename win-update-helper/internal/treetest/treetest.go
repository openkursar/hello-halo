// Package treetest builds and compares small directory trees so the swap,
// rollback and staging tests can assert on whole install directories instead
// of file by file.
package treetest

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
)

// Tree maps a slash-separated relative path to its contents.
type Tree map[string]string

func Write(t *testing.T, root string, files Tree) {
	t.Helper()
	for name, body := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// Snapshot reads every file under root. A missing root is an empty tree.
func Snapshot(t *testing.T, root string) Tree {
	t.Helper()
	got := Tree{}
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		got[filepath.ToSlash(rel)] = string(body)
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return got
}

func Equal(a, b Tree) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if other, ok := b[k]; !ok || other != v {
			return false
		}
	}
	return true
}

// FastPolicy keeps the retry behaviour but removes the waiting, so tests that
// deliberately fail a move do not sleep through the backoff.
func FastPolicy() fsx.Policy {
	p := fsx.Default()
	p.Attempts = 2
	p.Base = time.Millisecond
	p.Max = time.Millisecond
	p.Sleep = func(time.Duration) {}
	return p
}
