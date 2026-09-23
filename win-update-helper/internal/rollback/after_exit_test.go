package rollback

import (
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/state"
	"github.com/openkursar/hello-halo/win-update-helper/internal/treetest"
)

// The app requesting recovery holds its own executable and resources open, and
// those are among the files being moved back — so nothing may move until it
// has exited, and once the attempt is over it has to be started again.
func TestRunAfterExitWaitsThenRestoresThenRelaunches(t *testing.T) {
	s := newScene(t)
	s.writeState(t, state.PhaseSwapping, s.stagedEntries(t))
	s.interrupt(t, 5)

	var order []string
	relaunch := filepath.Join(s.installDir, "Halo.exe")
	policy := treetest.FastPolicy()
	err := RunAfterExit(AfterExitOptions{
		StatePath: s.statePath,
		WaitPID:   4242,
		Relaunch:  relaunch,
		WaitForExit: func(pid int, _, _ time.Duration) error {
			if got := treetest.Snapshot(t, s.installDir); treetest.Equal(got, s.original) {
				t.Error("install directory was restored before the app exited")
			}
			order = append(order, "wait")
			return nil
		},
		Launch: func(exe string) (int, error) {
			if exe != relaunch {
				t.Errorf("relaunched %q, want %q", exe, relaunch)
			}
			if got := treetest.Snapshot(t, s.installDir); !treetest.Equal(got, s.original) {
				t.Error("relaunched before the previous version was restored")
			}
			order = append(order, "launch")
			return 1, nil
		},
	}, &policy, func(string, ...any) {})
	if err != nil {
		t.Fatalf("rollback failed: %v", err)
	}
	if len(order) != 2 || order[0] != "wait" || order[1] != "launch" {
		t.Fatalf("order = %v, want [wait launch]", order)
	}
}

// If the app never exits (the quit was cancelled), nothing moves and nothing
// is started — the running app is still the one the user has.
func TestRunAfterExitTouchesNothingWhileTheAppIsAlive(t *testing.T) {
	s := newScene(t)
	s.writeState(t, state.PhaseSwapping, s.stagedEntries(t))
	s.interrupt(t, 3)
	before := treetest.Snapshot(t, s.installDir)

	launched := false
	policy := treetest.FastPolicy()
	err := RunAfterExit(AfterExitOptions{
		StatePath:   s.statePath,
		WaitPID:     4242,
		Relaunch:    filepath.Join(s.installDir, "Halo.exe"),
		WaitForExit: func(int, time.Duration, time.Duration) error { return errors.New("still running") },
		Launch:      func(string) (int, error) { launched = true; return 1, nil },
	}, &policy, func(string, ...any) {})
	if exitcode.Of(err) != exitcode.AppStillRunning {
		t.Fatalf("exit code = %d, want AppStillRunning (%v)", exitcode.Of(err), err)
	}
	if launched {
		t.Error("started a second copy of an app that is still running")
	}
	if got := treetest.Snapshot(t, s.installDir); !treetest.Equal(got, before) {
		t.Error("install directory changed while the app was still running")
	}
}
