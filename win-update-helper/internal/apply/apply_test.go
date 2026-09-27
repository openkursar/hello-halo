package apply

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
	"github.com/openkursar/hello-halo/win-update-helper/internal/stage"
	"github.com/openkursar/hello-halo/win-update-helper/internal/state"
	"github.com/openkursar/hello-halo/win-update-helper/internal/treetest"
)

type scene struct {
	opts     Options
	original treetest.Tree
	launched []string
}

func newScene(t *testing.T) *scene {
	t.Helper()
	root := t.TempDir()
	installDir := filepath.Join(root, "Halo")
	staged := filepath.Join(root, "staged")

	s := &scene{
		opts: Options{
			InstallDir:     installDir,
			Version:        "2.0.0",
			Staged:         staged,
			Backup:         filepath.Join(root, "backup"),
			StatePath:      filepath.Join(root, "update-state.json"),
			Relaunch:       filepath.Join(installDir, "Halo.exe"),
			ConfirmFile:    filepath.Join(root, "confirm"),
			ConfirmTimeout: 50 * time.Millisecond,
			RetryAfter:     20 * time.Millisecond,
			PollInterval:   time.Millisecond,
		},
		original: treetest.Tree{
			"Halo.exe":           "old-exe",
			"resources/app.asar": "old-asar",
			"Uninstall Halo.exe": "uninstaller",
		},
	}
	treetest.Write(t, installDir, s.original)
	treetest.Write(t, staged, treetest.Tree{
		"Halo.exe":           "new-exe",
		"resources/app.asar": "new-asar",
		stage.CompleteMarker: "2.0.0",
	})
	s.opts.Launch = func(exe string) (int, error) {
		s.launched = append(s.launched, exe)
		return 0, nil
	}
	return s
}

func (s *scene) run(t *testing.T) error {
	t.Helper()
	policy := treetest.FastPolicy()
	return Run(s.opts, &policy, func(string, ...any) {})
}

func TestRunSwapsAndCleansUpOnceConfirmed(t *testing.T) {
	s := newScene(t)
	s.opts.Launch = func(exe string) (int, error) {
		s.launched = append(s.launched, exe)
		return 0, os.WriteFile(s.opts.ConfirmFile, []byte("ok"), 0o644)
	}

	if err := s.run(t); err != nil {
		t.Fatalf("apply: %v", err)
	}

	got := treetest.Snapshot(t, s.opts.InstallDir)
	want := treetest.Tree{
		"Halo.exe":           "new-exe",
		"resources/app.asar": "new-asar",
		"Uninstall Halo.exe": "uninstaller",
	}
	if !treetest.Equal(got, want) {
		t.Fatalf("install dir = %v, want %v", got, want)
	}
	for _, path := range []string{s.opts.Backup, s.opts.Staged, s.opts.StatePath} {
		if fsx.Exists(path) {
			t.Errorf("%s should have been cleaned up", path)
		}
	}
	if len(s.launched) != 1 || s.launched[0] != s.opts.Relaunch {
		t.Errorf("launched %v", s.launched)
	}
}

func TestRunRestoresThePreviousVersionWhenTheNewOneNeverConfirms(t *testing.T) {
	s := newScene(t)

	err := s.run(t)
	if got := exitcode.Of(err); got != exitcode.ConfirmTimeout {
		t.Fatalf("exit code = %d, want %d (%v)", got, exitcode.ConfirmTimeout, err)
	}
	if got := treetest.Snapshot(t, s.opts.InstallDir); !treetest.Equal(got, s.original) {
		t.Fatalf("install dir = %v, want %v", got, s.original)
	}
	if !fsx.Exists(filepath.Join(s.opts.Staged, stage.CompleteMarker)) {
		t.Error("the staged tree should survive so the app can report what failed")
	}
	if fsx.Exists(s.opts.StatePath) {
		t.Error("state file survived a completed reversal")
	}
	// The new version is started, started once more when it stays silent, and
	// finally the old one is put back on screen.
	if len(s.launched) != 3 {
		t.Errorf("launched %v, want the new version twice then the old one", s.launched)
	}
}

func TestRunRefusesAnIncompleteStagedTree(t *testing.T) {
	s := newScene(t)
	if err := os.Remove(filepath.Join(s.opts.Staged, stage.CompleteMarker)); err != nil {
		t.Fatal(err)
	}

	err := s.run(t)
	if got := exitcode.Of(err); got != exitcode.StagedIncomplete {
		t.Fatalf("exit code = %d, want %d (%v)", got, exitcode.StagedIncomplete, err)
	}
	if got := treetest.Snapshot(t, s.opts.InstallDir); !treetest.Equal(got, s.original) {
		t.Fatal("install dir was touched")
	}
	if fsx.Exists(s.opts.StatePath) {
		t.Error("no state file should exist when nothing was moved")
	}
}

// A quit the user cancelled must cost nothing: the app keeps running on the
// version it already has.
func TestRunAbortsWhileTheAppIsStillRunning(t *testing.T) {
	s := newScene(t)
	s.opts.WaitPID = 4242
	s.opts.WaitTimeout = time.Millisecond
	s.opts.WaitForExit = func(int, time.Duration, time.Duration) error {
		return errors.New("still running")
	}

	err := s.run(t)
	if got := exitcode.Of(err); got != exitcode.AppStillRunning {
		t.Fatalf("exit code = %d, want %d (%v)", got, exitcode.AppStillRunning, err)
	}
	if got := treetest.Snapshot(t, s.opts.InstallDir); !treetest.Equal(got, s.original) {
		t.Fatal("install dir was touched")
	}
	if len(s.launched) != 0 {
		t.Error("nothing should have been launched")
	}
}

func TestRunRecordsTheVersionAndPhaseBeforeMoving(t *testing.T) {
	s := newScene(t)
	var observed state.State
	s.opts.Launch = func(exe string) (int, error) {
		observed, _ = state.Read(s.opts.StatePath)
		return 0, os.WriteFile(s.opts.ConfirmFile, []byte("ok"), 0o644)
	}

	if err := s.run(t); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if observed.Phase != state.PhaseAwaitingConfirm {
		t.Errorf("phase at relaunch = %q, want %q", observed.Phase, state.PhaseAwaitingConfirm)
	}
	if observed.Version != "2.0.0" {
		t.Errorf("version = %q", observed.Version)
	}
	if observed.InstallDir != s.opts.InstallDir || observed.Backup != s.opts.Backup {
		t.Errorf("state does not describe the swap: %+v", observed)
	}
	if len(observed.StagedEntries) != 2 {
		t.Errorf("stagedEntries = %v, want the two promoted entries", observed.StagedEntries)
	}
}

// A stale confirm file from an earlier attempt would make a version that never
// starts look like a success.
func TestRunIgnoresAStaleConfirmFile(t *testing.T) {
	s := newScene(t)
	if err := os.WriteFile(s.opts.ConfirmFile, []byte("stale"), 0o644); err != nil {
		t.Fatal(err)
	}

	err := s.run(t)
	if got := exitcode.Of(err); got != exitcode.ConfirmTimeout {
		t.Fatalf("exit code = %d, want %d (%v)", got, exitcode.ConfirmTimeout, err)
	}
	if got := treetest.Snapshot(t, s.opts.InstallDir); !treetest.Equal(got, s.original) {
		t.Fatalf("install dir = %v, want the previous version", got)
	}
}
