// Package apply performs the swap the user waits for: quit, rename, relaunch.
// It runs after the app has exited and is the only command that can leave a
// user unable to start Halo, so every step is ordered to be undoable.
package apply

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

const (
	// How long the new version has to report in before the swap is backed out.
	//
	// Nobody waits this out in the normal case — the window appears in a few
	// seconds and reports in immediately, and the helper finishes right after.
	// This is the budget for deciding a version genuinely cannot start, and it
	// is the only case where the user is looking at a missing app, so it is
	// kept short enough to recover from rather than generous.
	DefaultConfirmTimeout = 60 * time.Second

	// When to start the new version a second time if the first attempt made no
	// sound. Early, because the usual causes — a scanner holding the freshly
	// moved executable, the previous process not yet off the single-instance
	// lock — clear in seconds.
	DefaultRetryAfter   = 20 * time.Second
	DefaultWaitTimeout  = 60 * time.Second
	defaultPollInterval = 250 * time.Millisecond
)

type Options struct {
	InstallDir     string
	Version        string
	Staged         string
	Backup         string
	StatePath      string
	Relaunch       string
	ConfirmFile    string
	WaitPID        int
	ConfirmTimeout time.Duration
	RetryAfter     time.Duration
	WaitTimeout    time.Duration
	PollInterval   time.Duration

	// Seams so the swap itself can be exercised without a real app process.
	WaitForExit func(pid int, timeout, interval time.Duration) error
	Launch      func(exe string) (int, error)
	Terminate   func(pid int, timeout, interval time.Duration) error
}

func (o *Options) applyDefaults() {
	if o.ConfirmTimeout <= 0 {
		o.ConfirmTimeout = DefaultConfirmTimeout
	}
	if o.RetryAfter <= 0 {
		o.RetryAfter = DefaultRetryAfter
	}
	if o.WaitTimeout <= 0 {
		o.WaitTimeout = DefaultWaitTimeout
	}
	if o.PollInterval <= 0 {
		o.PollInterval = defaultPollInterval
	}
	if o.WaitForExit == nil {
		o.WaitForExit = proc.WaitForExit
	}
	if o.Launch == nil {
		o.Launch = proc.LaunchDetached
	}
	if o.Terminate == nil {
		o.Terminate = proc.Terminate
	}
}

func Run(opts Options, fs *fsx.Policy, logf func(format string, args ...any)) error {
	opts.applyDefaults()

	if opts.WaitPID > 0 {
		logf("apply: waiting up to %s for pid %d to exit", opts.WaitTimeout, opts.WaitPID)
		if err := opts.WaitForExit(opts.WaitPID, opts.WaitTimeout, opts.PollInterval); err != nil {
			// The user may have cancelled the quit. Nothing has been touched
			// yet, so abandoning the update is free.
			return exitcode.Wrap(exitcode.AppStillRunning,
				fmt.Errorf("pid %d did not exit: %w", opts.WaitPID, err))
		}
		logf("apply: pid %d has exited", opts.WaitPID)
	}

	// From here the app has quit on our account, so every exit that leaves the
	// previous version in place must also put it back on screen — the user
	// clicked "restart now", and an app that simply vanishes is the one
	// outcome they cannot act on. Checked after the wait for the same reason:
	// relaunching while the old process still holds the single-instance lock
	// would start nothing.
	marker := filepath.Join(opts.Staged, stage.CompleteMarker)
	if !fsx.Exists(marker) {
		relaunchPrevious(opts, logf)
		return exitcode.Wrap(exitcode.StagedIncomplete,
			fmt.Errorf("staged tree %s has no %s marker", opts.Staged, stage.CompleteMarker))
	}

	stagedEntries, err := stagedTopLevel(opts.Staged)
	if err != nil {
		relaunchPrevious(opts, logf)
		return exitcode.Wrap(exitcode.Usage, err)
	}

	current := state.State{
		Phase:         state.PhaseSwapping,
		Version:       opts.Version,
		InstallDir:    opts.InstallDir,
		Staged:        opts.Staged,
		Backup:        opts.Backup,
		Relaunch:      opts.Relaunch,
		StagedEntries: stagedEntries,
		HelperPID:     os.Getpid(),
	}
	// Written before the first rename: from here on, an interrupted run is
	// recoverable by the rollback command at next startup.
	if err := state.Write(opts.StatePath, current); err != nil {
		relaunchPrevious(opts, logf)
		return exitcode.Wrap(exitcode.Usage, fmt.Errorf("cannot record update state: %w", err))
	}

	if err := fs.RemoveWithRetry(opts.Backup); err != nil {
		// Nothing has moved yet, so the state file would only send the next
		// startup into a rollback with nothing to undo.
		if rmErr := state.Remove(opts.StatePath); rmErr != nil {
			logf("apply: could not remove state file: %v", rmErr)
		}
		relaunchPrevious(opts, logf)
		return exitcode.Wrap(exitcode.Usage, fmt.Errorf("cannot clear backup directory: %w", err))
	}

	swapper := swap.New(fs, logf)
	if err := swapper.Run(opts.InstallDir, opts.Staged, opts.Backup); err != nil {
		return finishFailedSwap(opts, err, logf)
	}
	logf("apply: swap complete (%d moves)", swapper.Moved())

	current.Phase = state.PhaseAwaitingConfirm
	if err := state.Write(opts.StatePath, current); err != nil {
		logf("apply: could not update state file: %v", err)
	}

	// A confirm file left over from an earlier attempt would look like an
	// instant success for a version that never started.
	if err := os.Remove(opts.ConfirmFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		logf("apply: could not clear stale confirm file: %v", err)
	}

	launchedPIDs, confirmed, err := relaunchUntilConfirmed(opts, logf)
	if err != nil {
		return backOut(opts, swapper, launchedPIDs, err, logf)
	}
	if confirmed {
		logf("apply: new version confirmed")
		cleanup(opts, fs, logf)
		return nil
	}

	return backOut(opts, swapper, launchedPIDs, fmt.Errorf("new version did not confirm within %s", opts.ConfirmTimeout), logf)
}

// relaunchPrevious starts the version that is still installed. Failure is
// logged and not escalated: the exit code already says why the update did not
// happen, and there is nothing further this process can do about a launch.
func relaunchPrevious(opts Options, logf func(format string, args ...any)) {
	logf("apply: relaunching the previous version %s", opts.Relaunch)
	if _, err := opts.Launch(opts.Relaunch); err != nil {
		logf("apply: could not relaunch the previous version: %v", err)
	}
}

// finishFailedSwap turns a swap error into the exit code that tells the app
// whether the install directory is usable.
func finishFailedSwap(opts Options, err error, logf func(format string, args ...any)) error {
	var swapErr *swap.Error
	if errors.As(err, &swapErr) && !swapErr.Reversed {
		for _, e := range swapErr.ReverseErrs {
			logf("apply: REVERSAL FAILED: %v", e)
		}
		logf("apply: install directory is INCOMPLETE; state file %s kept for recovery", opts.StatePath)
		return exitcode.Wrap(exitcode.SwapNotReversed, err)
	}
	logf("apply: install directory restored to the previous version")
	if rmErr := state.Remove(opts.StatePath); rmErr != nil {
		logf("apply: could not remove state file: %v", rmErr)
	}
	relaunchPrevious(opts, logf)
	return exitcode.Wrap(exitcode.SwapReversed, err)
}

// backOut undoes a completed swap whose new version never reported in, and
// puts the old version back on screen.
func backOut(opts Options, swapper *swap.Swapper, launchedPIDs []int, cause error, logf func(format string, args ...any)) error {
	logf("apply: %v", cause)

	// A version that never reported in may still be running and holding its own
	// files open. On Windows the reversal renames exactly those files, so
	// leaving it alive turns a recoverable back-out into an install directory
	// the user cannot start from. Every start is stopped, not just the last:
	// when the retry loses the single-instance lock it is the FIRST process
	// that is still alive.
	stopped := map[int]bool{}
	for _, pid := range launchedPIDs {
		if pid <= 0 || stopped[pid] {
			continue
		}
		stopped[pid] = true
		logf("apply: stopping unconfirmed version (pid %d) before reversing", pid)
		if err := opts.Terminate(pid, opts.WaitTimeout, opts.PollInterval); err != nil {
			logf("apply: could not stop pid %d (%v); reversal may fail", pid, err)
		}
	}

	logf("apply: reversing %d moves and restoring the previous version", swapper.Moved())

	errs := swapper.Reverse()
	if len(errs) > 0 {
		for _, e := range errs {
			logf("apply: REVERSAL FAILED: %v", e)
		}
		logf("apply: install directory is INCOMPLETE; state file %s kept for recovery", opts.StatePath)
		return exitcode.Wrap(exitcode.SwapNotReversed, cause)
	}

	// Recorded before the relaunch so the returning version can already see it.
	if err := recordFailedVersion(filepath.Dir(opts.StatePath), opts.Version); err != nil {
		logf("apply: could not record %s as failed (it may be retried): %v", opts.Version, err)
	} else {
		logf("apply: recorded %s as unable to start on this machine", opts.Version)
	}

	relaunchPrevious(opts, logf)
	if err := state.Remove(opts.StatePath); err != nil {
		logf("apply: could not remove state file: %v", err)
	}
	return exitcode.Wrap(exitcode.ConfirmTimeout, cause)
}

// cleanup runs after the new version is confirmed. Everything it removes is
// disposable, so failures are logged and forgiven.
func cleanup(opts Options, fs *fsx.Policy, logf func(format string, args ...any)) {
	if err := fs.RemoveWithRetry(opts.Backup); err != nil {
		logf("apply: could not remove backup %s: %v", opts.Backup, err)
	}
	if err := fs.RemoveWithRetry(opts.Staged); err != nil {
		logf("apply: could not remove staged tree %s: %v", opts.Staged, err)
	}
	if err := state.Remove(opts.StatePath); err != nil {
		logf("apply: could not remove state file %s: %v", opts.StatePath, err)
	}
}

func stagedTopLevel(staged string) ([]string, error) {
	names, err := swap.PromotableNames(staged)
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		return nil, fmt.Errorf("staged tree %s is empty", staged)
	}
	return names, nil
}

// relaunchUntilConfirmed starts the new version and waits for it to report in,
// starting it a second time if the first attempt produced nothing.
//
// The executable was moved into place moments earlier, so the first start can
// lose to a virus scanner still holding it, or to the previous process not yet
// having released the single-instance lock it shares with this install. Both
// clear on their own; giving up after one attempt turns a transient condition
// into a version that swapped successfully and then never opened.
//
// Every pid started is reported whether or not the version confirmed, because
// a process that started and stayed silent still holds the files a back-out
// has to move.
func relaunchUntilConfirmed(opts Options, logf func(format string, args ...any)) (pids []int, confirmed bool, err error) {
	deadline := time.Now().Add(opts.ConfirmTimeout)
	retryAt := time.Now().Add(opts.RetryAfter)

	logf("apply: relaunching %s", opts.Relaunch)
	pid, err := opts.Launch(opts.Relaunch)
	if err != nil {
		logf("apply: relaunch failed: %v", err)
		return nil, false, fmt.Errorf("relaunch failed: %w", err)
	}
	pids = append(pids, pid)
	logf("apply: waiting up to %s for %s", opts.ConfirmTimeout, opts.ConfirmFile)

	retried := false
	for {
		if fsx.Exists(opts.ConfirmFile) {
			return pids, true, nil
		}
		if time.Now().After(deadline) {
			return pids, false, nil
		}
		if !retried && time.Now().After(retryAt) {
			retried = true
			logf("apply: no confirmation yet, starting %s once more", opts.Relaunch)
			if again, retryErr := opts.Launch(opts.Relaunch); retryErr != nil {
				logf("apply: second start failed: %v", retryErr)
			} else {
				pids = append(pids, again)
			}
		}
		time.Sleep(opts.PollInterval)
	}
}
