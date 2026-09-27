package archive

import (
	"os"
	"path/filepath"
	"testing"
)

// The product tree is assembled on macOS and npm leaves symlinks in
// node_modules, so a packer that refuses them cannot pack the real app.
func TestPackResolvesSymlinks(t *testing.T) {
	src := t.TempDir()
	if err := os.MkdirAll(filepath.Join(src, "tree", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(src, "tree", "nested", "real.js")
	if err := os.WriteFile(real, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("nested", "real.js"), filepath.Join(src, "tree", "link.js")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	out := filepath.Join(t.TempDir(), "p.tar.zst")
	if _, err := Pack(PackOptions{Source: filepath.Join(src, "tree"), Out: out}, nil); err != nil {
		t.Fatalf("pack refused a tree containing a symlink: %v", err)
	}

	dest := t.TempDir()
	if _, err := Extract(out, dest, nil); err != nil {
		t.Fatalf("extract: %v", err)
	}

	// The link must arrive as a plain file holding the target's bytes: Windows
	// cannot be relied on to recreate a link without elevation.
	linked := filepath.Join(dest, "link.js")
	info, err := os.Lstat(linked)
	if err != nil {
		t.Fatalf("link.js missing after extract: %v", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatal("link.js was extracted as a symlink; it must be a regular file")
	}
	body, err := os.ReadFile(linked)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "payload" {
		t.Fatalf("link.js content = %q, want %q", body, "payload")
	}
}
