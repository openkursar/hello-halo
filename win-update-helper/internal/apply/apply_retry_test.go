package apply

import (
	"os"
	"testing"
	"time"
)

// A version that swapped in but did not come up on the first try must be
// started again before the swap is abandoned. The executable was moved into
// place moments earlier, so the first start can lose to a virus scanner still
// holding it, or to the previous process not yet having released the
// single-instance lock — both clear on their own.
func TestASilentFirstStartIsRetriedBeforeGivingUp(t *testing.T) {
	s := newScene(t)
	s.opts.ConfirmTimeout = 200 * time.Millisecond
	s.opts.RetryAfter = 40 * time.Millisecond
	s.opts.PollInterval = 10 * time.Millisecond

	attempts := 0
	s.opts.Launch = func(exe string) (int, error) {
		attempts++
		s.launched = append(s.launched, exe)
		// The second attempt is the one that takes.
		if attempts == 2 {
			return 2, os.WriteFile(s.opts.ConfirmFile, []byte("ok"), 0o644)
		}
		return 1, nil
	}

	if err := s.run(t); err != nil {
		t.Fatalf("apply should have succeeded on the retry: %v", err)
	}
	if attempts != 2 {
		t.Fatalf("launch attempts = %d, want 2", attempts)
	}
	// The new version stays in place; nothing was reversed.
	if got := readFile(t, s.opts.InstallDir+"/Halo.exe"); got != "new-exe" {
		t.Errorf("Halo.exe = %q, want the new version", got)
	}
}
