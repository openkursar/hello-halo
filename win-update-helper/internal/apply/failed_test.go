package apply

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A version that swapped in and never started must be remembered, or the next
// check finds the same release and the machine loops: stage, swap, wait, roll
// back, repeat — with no way out except never updating again.
func TestAFailedVersionIsRecordedSoItIsNotRetried(t *testing.T) {
	s := newScene(t)
	s.opts.ConfirmTimeout = 60 * time.Millisecond
	s.opts.RetryAfter = 20 * time.Millisecond
	s.opts.Launch = func(exe string) (int, error) {
		s.launched = append(s.launched, exe)
		return 0, nil // never confirms
	}

	if err := s.run(t); err == nil {
		t.Fatal("expected the apply to fail")
	}

	recorded := ReadFailedVersions(filepath.Dir(s.opts.StatePath))
	if len(recorded) != 1 || recorded[0] != s.opts.Version {
		t.Fatalf("recorded = %v, want [%s]", recorded, s.opts.Version)
	}
}

func TestReadFailedVersionsToleratesNoFile(t *testing.T) {
	if got := ReadFailedVersions(t.TempDir()); got != nil {
		t.Fatalf("got %v, want nil for a directory with no record", got)
	}
}

// A successful update must leave no mark; only a version that actually failed
// should ever be skipped.
func TestASuccessfulApplyRecordsNothing(t *testing.T) {
	s := newScene(t)
	s.opts.Launch = func(exe string) (int, error) {
		s.launched = append(s.launched, exe)
		return 0, os.WriteFile(s.opts.ConfirmFile, []byte("ok"), 0o644)
	}
	if err := s.run(t); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if got := ReadFailedVersions(filepath.Dir(s.opts.StatePath)); got != nil {
		t.Fatalf("a successful update recorded %v", got)
	}
}
