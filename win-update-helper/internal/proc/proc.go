// Package proc watches the app process and relaunches it.
//
// It never terminates the process it was asked to *wait* for — a quit the user
// cancelled must leave the install untouched. It does terminate a process it
// started itself, and only when backing that launch out again.
package proc

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

var ErrStillRunning = errors.New("process is still running")

// Alive reports whether pid belongs to a live process.
func Alive(pid int) bool { return alive(pid) }

// WaitForExit polls until pid is gone or timeout elapses.
func WaitForExit(pid int, timeout, interval time.Duration) error {
	if interval <= 0 {
		interval = 250 * time.Millisecond
	}
	deadline := time.Now().Add(timeout)
	for {
		if !alive(pid) {
			return nil
		}
		if time.Now().After(deadline) {
			return ErrStillRunning
		}
		time.Sleep(interval)
	}
}

// LaunchDetached starts exe without waiting for it, and without tying its
// lifetime to this helper: the helper exits long before the app finishes
// starting up.
//
// Returns the new process id so a caller that later has to undo the launch can
// stop what it started.
func LaunchDetached(exe string) (int, error) {
	cmd := exec.Command(exe)
	cmd.Dir = filepath.Dir(exe)
	cmd.SysProcAttr = detachAttr()
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := cmd.Process.Pid
	return pid, cmd.Process.Release()
}

// Terminate stops a process this helper started, and waits for it to actually
// go away.
//
// Reversing a swap means renaming files the running process has open. On
// Windows those renames fail while it holds them, so a version that was
// launched and never reported in has to be stopped before the reversal is
// attempted — otherwise a merely slow machine produces the one outcome that
// leaves the app unstartable.
func Terminate(pid int, timeout, interval time.Duration) error {
	if pid <= 0 {
		return nil
	}
	// A process that is already gone is the outcome this function exists to
	// produce, not a failure. Reporting it as an error made a clean back-out
	// log "could not stop ...; reversal may fail" immediately before a
	// reversal that worked perfectly.
	if !alive(pid) {
		return nil
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		// Windows resolves the pid here, so a process that exited between the
		// liveness check and now lands in this branch.
		if !alive(pid) {
			return nil
		}
		return err
	}
	if err := p.Kill(); err != nil && alive(pid) {
		return err
	}
	return WaitForExit(pid, timeout, interval)
}
