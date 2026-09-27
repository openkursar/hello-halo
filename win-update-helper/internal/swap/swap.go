// Package swap exchanges the contents of the install directory with a staged
// tree.
//
// The install directory itself is never renamed or moved: the uninstaller path
// recorded in the registry and every Start Menu shortcut point inside it, so
// only its contents may change.
//
// Every rename is journalled before the next one starts. As long as the
// journal is honoured in exact reverse order, the install directory can always
// be returned to the state it had when Run was called.
package swap

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
)

// FS is the set of mutations a swap is allowed to perform. Narrow on purpose:
// a swap may move and it may delete, and nothing else.
type FS interface {
	MoveWithRetry(src, dst string) error
	RemoveWithRetry(path string) error
}

type movement struct {
	from string
	to   string
}

// Error reports a swap that could not complete. Reversed distinguishes the
// recoverable outcome (install directory restored) from the one that leaves a
// user unable to start the app.
type Error struct {
	Cause       error
	Reversed    bool
	ReverseErrs []error
}

func (e *Error) Error() string {
	if e.Reversed {
		return fmt.Sprintf("swap failed and was reversed: %v", e.Cause)
	}
	return fmt.Sprintf("swap failed and could NOT be fully reversed: %v (reversal errors: %v)", e.Cause, e.ReverseErrs)
}

func (e *Error) Unwrap() error { return e.Cause }

type Swapper struct {
	fs      FS
	logf    func(format string, args ...any)
	journal []movement
}

func New(fs FS, logf func(format string, args ...any)) *Swapper {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Swapper{fs: fs, logf: logf}
}

// Run moves the install directory's contents into backup, then promotes the
// staged contents into the install directory. On any failure it reverses
// everything it did and returns an *Error.
func (s *Swapper) Run(installDir, staged, backup string) error {
	if err := os.MkdirAll(backup, 0o755); err != nil {
		return &Error{Cause: err, Reversed: true}
	}

	retiring, err := SwappableNames(installDir, staged, backup)
	if err != nil {
		return &Error{Cause: err, Reversed: true}
	}
	promoting, err := PromotableNames(staged)
	if err != nil {
		return &Error{Cause: err, Reversed: true}
	}

	s.logf("swap: retiring %d entries, promoting %d entries", len(retiring), len(promoting))

	for _, name := range retiring {
		if err := s.move(filepath.Join(installDir, name), filepath.Join(backup, name)); err != nil {
			return s.failed(err)
		}
	}
	for _, name := range promoting {
		if err := s.move(filepath.Join(staged, name), filepath.Join(installDir, name)); err != nil {
			return s.failed(err)
		}
	}
	return nil
}

// Reverse undoes every journalled move, newest first. It is used both to abort
// a failed swap and to back out a completed one whose new version never
// started. Moves that succeed leave the journal; moves that fail stay on it so
// a later attempt retries exactly them.
func (s *Swapper) Reverse() []error {
	var errs []error
	var stuck []movement
	for i := len(s.journal) - 1; i >= 0; i-- {
		m := s.journal[i]
		if err := s.fs.MoveWithRetry(m.to, m.from); err != nil {
			errs = append(errs, fmt.Errorf("reverse %s -> %s: %w", m.to, m.from, err))
			stuck = append(stuck, m)
		}
	}
	// stuck was collected newest-first; store it back in journal order.
	for i, j := 0, len(stuck)-1; i < j; i, j = i+1, j-1 {
		stuck[i], stuck[j] = stuck[j], stuck[i]
	}
	s.journal = stuck
	return errs
}

// Moved reports how many renames are currently journalled.
func (s *Swapper) Moved() int { return len(s.journal) }

func (s *Swapper) move(from, to string) error {
	if err := s.fs.MoveWithRetry(from, to); err != nil {
		return err
	}
	s.journal = append(s.journal, movement{from: from, to: to})
	return nil
}

func (s *Swapper) failed(cause error) error {
	s.logf("swap: %v", cause)
	s.logf("swap: reversing %d completed moves", len(s.journal))
	errs := s.Reverse()
	return &Error{Cause: cause, Reversed: len(errs) == 0, ReverseErrs: errs}
}

// SwappableNames lists the install directory entries a swap may move aside.
func SwappableNames(installDir, staged, backup string) ([]string, error) {
	names, err := fsx.TopLevelNames(installDir)
	if err != nil {
		return nil, err
	}
	kept := make([]string, 0, len(names))
	for _, name := range names {
		if Skip(installDir, staged, backup, name) {
			continue
		}
		kept = append(kept, name)
	}
	return kept, nil
}

// Skip reports entries that must stay where they are: our own scratch
// directories (which may be nested inside the install directory) and the
// uninstaller, whose path is recorded in the registry and would orphan the
// Add/Remove Programs entry if it moved.
func Skip(installDir, staged, backup, name string) bool {
	if strings.HasPrefix(name, ".") {
		return true
	}
	if isUninstaller(name) {
		return true
	}
	full := filepath.Join(installDir, name)
	return fsx.WithinPath(full, staged) || fsx.WithinPath(full, backup)
}

func isUninstaller(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "uninstall") && strings.HasSuffix(lower, ".exe")
}

// PromotableNames lists the staged entries that belong in the install
// directory, leaving behind the bookkeeping the staging step wrote for itself.
func PromotableNames(staged string) ([]string, error) {
	names, err := fsx.TopLevelNames(staged)
	if err != nil {
		return nil, err
	}
	kept := make([]string, 0, len(names))
	for _, name := range names {
		if strings.HasPrefix(name, ".") {
			continue
		}
		kept = append(kept, name)
	}
	return kept, nil
}
