package stage

import (
	"crypto/sha512"
	"encoding/base64"
	"os"
	"path/filepath"
	"testing"

	"github.com/openkursar/hello-halo/win-update-helper/internal/archive"
	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
	"github.com/openkursar/hello-halo/win-update-helper/internal/treetest"
)

// packArchive builds a real update archive, so staging is tested against what
// the build machine actually produces.
func packArchive(t *testing.T) (path, digest string) {
	t.Helper()
	root := t.TempDir()
	source := filepath.Join(root, "win-unpacked")
	treetest.Write(t, source, treetest.Tree{
		"Halo.exe":           "exe",
		"resources/app.asar": "asar",
	})
	if err := os.Chmod(filepath.Join(source, "Halo.exe"), 0o755); err != nil {
		t.Fatal(err)
	}

	path = filepath.Join(root, "update.tar.zst")
	result, err := archive.Pack(archive.PackOptions{Source: source, Out: path}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return path, result.SHA512
}

func run(t *testing.T, archivePath, dest, sum string) error {
	t.Helper()
	policy := treetest.FastPolicy()
	return Run(Options{Archive: archivePath, Dest: dest, ExpectSHA512: sum, Version: "2.0.0"},
		&policy, func(string, ...any) {})
}

func TestRunExtractsAndMarksComplete(t *testing.T) {
	archivePath, digest := packArchive(t)
	dest := filepath.Join(t.TempDir(), "staged")
	// A leftover tree from an earlier attempt must not survive.
	if err := os.MkdirAll(filepath.Join(dest, "stale"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := run(t, archivePath, dest, digest); err != nil {
		t.Fatalf("stage: %v", err)
	}

	if fsx.Exists(filepath.Join(dest, "stale")) {
		t.Error("stale content survived staging")
	}
	got := treetest.Snapshot(t, dest)
	want := treetest.Tree{
		"Halo.exe":           "exe",
		"resources/app.asar": "asar",
		CompleteMarker:       "2.0.0",
	}
	if !treetest.Equal(got, want) {
		t.Fatalf("staged tree = %v, want %v", got, want)
	}
	info, err := os.Stat(filepath.Join(dest, "Halo.exe"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&0o111 == 0 {
		t.Errorf("executable bit lost: %v", info.Mode())
	}
}

func TestRunRejectsChecksumMismatch(t *testing.T) {
	archivePath, _ := packArchive(t)
	dest := filepath.Join(t.TempDir(), "staged")
	other := sha512.Sum512([]byte("a different archive"))

	err := run(t, archivePath, dest, base64.StdEncoding.EncodeToString(other[:]))
	if got := exitcode.Of(err); got != exitcode.BadHash {
		t.Fatalf("exit code = %d, want %d (%v)", got, exitcode.BadHash, err)
	}
	if fsx.Exists(dest) {
		t.Error("a checksum failure must not create the destination")
	}
}

func TestRunRejectsMalformedExpectedDigest(t *testing.T) {
	archivePath, _ := packArchive(t)
	dest := filepath.Join(t.TempDir(), "staged")
	for _, sum := range []string{"", "not base64!!", base64.StdEncoding.EncodeToString([]byte("short"))} {
		if got := exitcode.Of(run(t, archivePath, dest, sum)); got != exitcode.BadHash {
			t.Errorf("expect-sha512 %q: exit code = %d, want %d", sum, got, exitcode.BadHash)
		}
	}
}

// A tree that fails halfway must not be left behind: apply would otherwise
// find a marker-less directory and the app would keep retrying against it.
func TestRunDiscardsTheDestinationWhenExtractionFails(t *testing.T) {
	root := t.TempDir()
	truncated := filepath.Join(root, "update.tar.zst")
	archivePath, _ := packArchive(t)
	blob, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(truncated, blob[:len(blob)/2], 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha512.Sum512(blob[:len(blob)/2])

	dest := filepath.Join(root, "staged")
	err = run(t, truncated, dest, base64.StdEncoding.EncodeToString(sum[:]))
	if got := exitcode.Of(err); got != exitcode.StageFailed {
		t.Fatalf("exit code = %d, want %d (%v)", got, exitcode.StageFailed, err)
	}
	if fsx.Exists(dest) {
		t.Error("a failed extraction must leave no destination behind")
	}
}
