// Package rollback recovers an install directory from an apply that never
// finished — a power loss or a killed task between the first and the last
// rename. It runs at app startup whenever a state file is found.
package rollback

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
	"github.com/openkursar/hello-halo/win-update-helper/internal/proc"
	"github.com/openkursar/hello-halo/win-update-helper/internal/stage"
	"github.com/openkursar/hello-halo/win-update-helper/internal/state"
	"github.com/openkursar/hello-halo/win-update-helper/internal/swap"
)

// AfterExitOptions describe a rollback requested by the app it recovers.
type AfterExitOptions struct {
	StatePath string
	// WaitPID is the app that asked. Its own executable and resources are among
	// the files being moved back, and Windows refuses to rename a file a live
	// process holds — so nothing moves until it has gone.
	WaitPID      int
	WaitTimeout  time.Duration
	PollInterval time.Duration
	// Relaunch is started once the attempt is over, whatever its outcome: the
	// app quit so this could run, and must not simply stay gone.
	Relaunch string

	WaitForExit func(pid int, timeout, interval time.Duration) error
	Launch      func(exe string) (int, error)
}

// RunAfterExit waits for the requesting app to exit, rolls back, and starts
// the app again.
func RunAfterExit(opts AfterExitOptions, fs *fsx.Policy, logf func(format string, args ...any)) error {
	if opts.WaitForExit == nil {
		opts.WaitForExit = proc.WaitForExit
	}
	if opts.Launch == nil {
		opts.Launch = proc.LaunchDetached
	}
	if opts.WaitTimeout <= 0 {
		opts.WaitTimeout = 60 * time.Second
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = 250 * time.Millisecond
	}

	if opts.WaitPID > 0 {
		logf("rollback: waiting up to %s for pid %d to exit", opts.WaitTimeout, opts.WaitPID)
		if err := opts.WaitForExit(opts.WaitPID, opts.WaitTimeout, opts.PollInterval); err != nil {
			// Nothing has moved; the app will ask again on its next start.
			return exitcode.Wrap(exitcode.AppStillRunning, fmt.Errorf("pid %d did not exit: %w", opts.WaitPID, err))
		}
	}

	err := Run(opts.StatePath, fs, logf)

	if opts.Relaunch != "" {
		logf("rollback: relaunching %s", opts.Relaunch)
		if _, launchErr := opts.Launch(opts.Relaunch); launchErr != nil {
			logf("rollback: could not relaunch: %v", launchErr)
		}
	}
	return err
}

// Run restores the previous version. It is idempotent: with nothing left in
// the backup directory it only clears the state file.
func Run(statePath string, fs *fsx.Policy, logf func(format string, args ...any)) error {
	current, err := state.Read(statePath)
	if errors.Is(err, state.ErrNotFound) {
		logf("rollback: no state file at %s, nothing to recover", statePath)
		return nil
	}
	if err != nil {
		return exitcode.Wrap(exitcode.RollbackFailed, err)
	}
	logf("rollback: recovering %s, interrupted during %q", current.InstallDir, current.Phase)

	backedUp, err := fsx.TopLevelNames(current.Backup)
	if err != nil {
		return exitcode.Wrap(exitcode.RollbackFailed, err)
	}
	if len(backedUp) == 0 {
		logf("rollback: backup %s is empty, install directory already holds the previous version", current.Backup)
		return clearState(statePath, logf)
	}

	if err := os.MkdirAll(current.Staged, 0o755); err != nil {
		return exitcode.Wrap(exitcode.RollbackFailed, err)
	}
	// The staged tree failed to take over; make sure nothing can apply it
	// again without re-staging it first.
	if err := os.Remove(filepath.Join(current.Staged, stage.CompleteMarker)); err != nil && !errors.Is(err, os.ErrNotExist) {
		logf("rollback: could not invalidate the staged tree: %v", err)
	}

	if err := evictNewVersion(current, backedUp, fs, logf); err != nil {
		return exitcode.Wrap(exitcode.RollbackFailed, err)
	}
	if err := restoreBackup(current, backedUp, fs, logf); err != nil {
		return exitcode.Wrap(exitcode.RollbackFailed, err)
	}

	if remaining, _ := fsx.TopLevelNames(current.Backup); len(remaining) == 0 {
		if err := fs.RemoveWithRetry(current.Backup); err != nil {
			logf("rollback: could not remove empty backup %s: %v", current.Backup, err)
		}
	}
	logf("rollback: previous version restored")
	return clearState(statePath, logf)
}

// evictNewVersion moves back to the staged tree every install-directory entry
// that came from it. An entry is the new version's when the backup holds an
// older namesake, or when it was listed in the staged tree before the swap and
// is no longer there.
func evictNewVersion(current state.State, backedUp []string, fs *fsx.Policy, logf func(format string, args ...any)) error {
	inBackup := index(backedUp)
	wasStaged := index(current.StagedEntries)
	stagedNow, err := fsx.TopLevelNames(current.Staged)
	if err != nil {
		return err
	}
	isStagedNow := index(stagedNow)

	installed, err := fsx.TopLevelNames(current.InstallDir)
	if err != nil {
		return err
	}
	for _, name := range installed {
		if swap.Skip(current.InstallDir, current.Staged, current.Backup, name) {
			continue
		}
		if !inBackup[name] && !(wasStaged[name] && !isStagedNow[name]) {
			continue
		}
		dst := filepath.Join(current.Staged, name)
		if fsx.Exists(dst) {
			if err := fs.RemoveWithRetry(dst); err != nil {
				return fmt.Errorf("cannot clear %s: %w", dst, err)
			}
		}
		if err := fs.MoveWithRetry(filepath.Join(current.InstallDir, name), dst); err != nil {
			return err
		}
		logf("rollback: returned %s to the staged tree", name)
	}
	return nil
}

func restoreBackup(current state.State, backedUp []string, fs *fsx.Policy, logf func(format string, args ...any)) error {
	for _, name := range backedUp {
		dst := filepath.Join(current.InstallDir, name)
		if fsx.Exists(dst) {
			return fmt.Errorf("cannot restore %s: %s is still occupied", name, dst)
		}
		if err := fs.MoveWithRetry(filepath.Join(current.Backup, name), dst); err != nil {
			return err
		}
		logf("rollback: restored %s", name)
	}
	return nil
}

func clearState(statePath string, logf func(format string, args ...any)) error {
	if err := state.Remove(statePath); err != nil {
		logf("rollback: could not remove state file %s: %v", statePath, err)
		return exitcode.Wrap(exitcode.RollbackFailed, err)
	}
	return nil
}

func index(names []string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, name := range names {
		set[name] = true
	}
	return set
}
