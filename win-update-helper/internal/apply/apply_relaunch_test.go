package apply

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/stage"
	"github.com/openkursar/hello-halo/win-update-helper/internal/treetest"
)

// When the retry start loses the single-instance lock it exits at once, and
// the process still holding the new version's files is the FIRST one. Stopping
// only the latest pid would reverse the swap around a live process.
func TestBackOutStopsEveryStartedProcess(t *testing.T) {
	s := newScene(t)
	s.opts.ConfirmTimeout = 60 * time.Millisecond
	s.opts.RetryAfter = 5 * time.Millisecond

	next := 100
	s.opts.Launch = func(exe string) (int, error) {
		s.launched = append(s.launched, exe)
		next++
		return next, nil // never confirms
	}
	var terminated []int
	s.opts.Terminate = func(p int, _, _ time.Duration) error {
		terminated = append(terminated, p)
		return nil
	}

	err := s.run(t)
	if exitcode.Of(err) != exitcode.ConfirmTimeout {
		t.Fatalf("exit code = %d, want ConfirmTimeout; err=%v", exitcode.Of(err), err)
	}
	// Two starts of the new version, then one relaunch of the old one.
	if len(s.launched) != 3 {
		t.Fatalf("launched %d times, want 3 (start, retry, previous version)", len(s.launched))
	}
	if len(terminated) != 2 || terminated[0] != 101 || terminated[1] != 102 {
		t.Fatalf("terminated = %v, want [101 102]", terminated)
	}
	if got := readFile(t, s.opts.InstallDir+"/Halo.exe"); got != "old-exe" {
		t.Errorf("Halo.exe = %q after back-out, want the previous version", got)
	}
}

// The app has already quit when the helper finds the staged tree unusable, so
// the previous version must come back rather than leave the user with nothing.
func TestAnIncompleteStagedTreeBringsThePreviousVersionBack(t *testing.T) {
	s := newScene(t)
	if err := os.Remove(filepath.Join(s.opts.Staged, stage.CompleteMarker)); err != nil {
		t.Fatal(err)
	}
	var waited bool
	s.opts.WaitPID = 4242
	s.opts.WaitForExit = func(int, time.Duration, time.Duration) error {
		waited = true
		return nil
	}

	err := s.run(t)
	if got := exitcode.Of(err); got != exitcode.StagedIncomplete {
		t.Fatalf("exit code = %d, want %d (%v)", got, exitcode.StagedIncomplete, err)
	}
	if !waited {
		t.Error("relaunched without waiting for the old process to release the single-instance lock")
	}
	if len(s.launched) != 1 || s.launched[0] != s.opts.Relaunch {
		t.Fatalf("launched = %v, want the previous version once", s.launched)
	}
	if got := treetest.Snapshot(t, s.opts.InstallDir); !treetest.Equal(got, s.original) {
		t.Fatal("install dir was touched")
	}
}

// A swap that failed and was cleanly reversed leaves the previous version
// intact — and the user, who asked for a restart, with no app unless it is
// started again.
func TestAReversedSwapBringsThePreviousVersionBack(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("directory permissions do not block renames on Windows")
	}
	s := newScene(t)
	// A read-only install directory refuses the first move, which the swap
	// reports as failed and fully reversed.
	if err := os.Chmod(s.opts.InstallDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(s.opts.InstallDir, 0o755) })

	err := s.run(t)
	if got := exitcode.Of(err); got != exitcode.SwapReversed {
		t.Fatalf("exit code = %d, want SwapReversed (%d) (%v)", got, exitcode.SwapReversed, err)
	}
	if len(s.launched) != 1 || s.launched[0] != s.opts.Relaunch {
		t.Fatalf("launched = %v, want the previous version once", s.launched)
	}
	if got := treetest.Snapshot(t, s.opts.InstallDir); !treetest.Equal(got, s.original) {
		t.Fatal("install dir no longer holds the previous version")
	}
}

// A quit the user cancelled leaves their running app alone: starting a second
// copy of it would only be refused by the single-instance lock.
func TestACancelledQuitLaunchesNothing(t *testing.T) {
	s := newScene(t)
	s.opts.WaitPID = 4242
	s.opts.WaitForExit = func(int, time.Duration, time.Duration) error {
		return errors.New("still running")
	}
	_ = s.run(t)
	if len(s.launched) != 0 {
		t.Fatalf("launched = %v, want nothing", s.launched)
	}
}
