package apply

import (
	"os"
	"testing"
	"time"

	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/state"
)

// A version that is slow rather than broken is still running when the confirm
// window closes, still holding its own files open. Reversing without stopping
// it first fails on Windows, turning a recoverable back-out into an install
// the user cannot start — so the back-out must stop what it launched.
func TestBackOutStopsTheUnconfirmedVersionBeforeReversing(t *testing.T) {
	s := newScene(t)
	s.opts.ConfirmTimeout = 30 * time.Millisecond

	const pid = 4242
	var terminated []int
	var terminatedBeforeReversal bool

	s.opts.Launch = func(exe string) (int, error) {
		s.launched = append(s.launched, exe)
		return pid, nil // never writes the confirm file
	}
	s.opts.Terminate = func(p int, _, _ time.Duration) error {
		terminated = append(terminated, p)
		// The install directory must still hold the NEW version at this point:
		// stopping the process has to happen before anything is renamed back.
		terminatedBeforeReversal = readFile(t, s.opts.InstallDir+"/Halo.exe") == "new-exe"
		return nil
	}

	err := s.run(t)
	if exitcode.Of(err) != exitcode.ConfirmTimeout {
		t.Fatalf("exit code = %d, want ConfirmTimeout (%d); err=%v", exitcode.Of(err), exitcode.ConfirmTimeout, err)
	}
	if len(terminated) != 1 || terminated[0] != pid {
		t.Fatalf("terminated = %v, want exactly [%d]", terminated, pid)
	}
	if !terminatedBeforeReversal {
		t.Error("the launched version was stopped after the reversal had already begun")
	}
	// And the old version must be back.
	if got := readFile(t, s.opts.InstallDir+"/Halo.exe"); got != "old-exe" {
		t.Errorf("Halo.exe = %q after back-out, want the previous version", got)
	}
	if _, err := state.Read(s.opts.StatePath); err == nil {
		t.Error("state file survived a completed back-out")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}
