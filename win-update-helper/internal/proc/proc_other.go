//go:build !windows

package proc

import (
	"errors"
	"syscall"
)

// Signal 0 probes for existence only. EPERM means the process exists but is
// owned by someone else.
func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func detachAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{Setsid: true}
}
