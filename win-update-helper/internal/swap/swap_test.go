package swap

import (
	"errors"
	"path/filepath"
	"sort"
	"testing"

	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
	"github.com/openkursar/hello-halo/win-update-helper/internal/treetest"
)

// failingFS fails one named move so a reversal can be observed end to end.
type failingFS struct {
	fsx.Policy
	failOn string
	moves  []string
}

func (f *failingFS) MoveWithRetry(src, dst string) error {
	if filepath.Base(src) == f.failOn {
		return errors.New("simulated lock")
	}
	f.moves = append(f.moves, filepath.Base(src))
	return f.Policy.MoveWithRetry(src, dst)
}

func setup(t *testing.T) (installDir, staged, backup string) {
	t.Helper()
	root := t.TempDir()
	installDir = filepath.Join(root, "Halo")
	staged = filepath.Join(root, "staged")
	backup = filepath.Join(root, "backup")

	treetest.Write(t, installDir, treetest.Tree{
		"Halo.exe":                 "old-exe",
		"resources/app.asar":       "old-asar",
		"locales/en-US.pak":        "old-pak",
		"gone-in-new.dll":          "old-only",
		"Uninstall Halo.exe":       "uninstaller",
		".halo-update/scratch.txt": "scratch",
	})
	treetest.Write(t, staged, treetest.Tree{
		"Halo.exe":           "new-exe",
		"resources/app.asar": "new-asar",
		"locales/en-US.pak":  "new-pak",
		"brand-new.dll":      "new-only",
		".stage-complete":    "2.0.0",
	})
	return installDir, staged, backup
}

func TestRunSwapsContentsAndKeepsUninstaller(t *testing.T) {
	installDir, staged, backup := setup(t)
	before := treetest.Snapshot(t, installDir)

	s := New(treetest.FastPolicy(), nil)
	if err := s.Run(installDir, staged, backup); err != nil {
		t.Fatalf("swap: %v", err)
	}

	after := treetest.Snapshot(t, installDir)
	want := treetest.Tree{
		"Halo.exe":                 "new-exe",
		"resources/app.asar":       "new-asar",
		"locales/en-US.pak":        "new-pak",
		"brand-new.dll":            "new-only",
		"Uninstall Halo.exe":       "uninstaller",
		".halo-update/scratch.txt": "scratch",
	}
	if !treetest.Equal(after, want) {
		t.Fatalf("install dir after swap = %v, want %v", after, want)
	}

	backedUp := treetest.Snapshot(t, backup)
	for _, name := range []string{"Halo.exe", "gone-in-new.dll", "resources/app.asar"} {
		if _, ok := backedUp[name]; !ok {
			t.Errorf("backup is missing %s (have %v)", name, backedUp)
		}
	}
	if backedUp["Halo.exe"] != before["Halo.exe"] {
		t.Error("backup holds the wrong Halo.exe")
	}
	if _, ok := backedUp["Uninstall Halo.exe"]; ok {
		t.Error("the uninstaller must never move: its path is recorded in the registry")
	}
	if !fsx.Exists(filepath.Join(staged, ".stage-complete")) {
		t.Error("the staging marker was promoted into the install directory")
	}
}

func TestRunReversesEveryMoveWhenAMoveFails(t *testing.T) {
	// One failure point in each phase, plus one before anything has moved.
	for _, failOn := range []string{"Halo.exe", "locales", "brand-new.dll"} {
		t.Run(failOn, func(t *testing.T) {
			installDir, staged, backup := setup(t)
			installBefore := treetest.Snapshot(t, installDir)
			stagedBefore := treetest.Snapshot(t, staged)

			s := New(&failingFS{Policy: treetest.FastPolicy(), failOn: failOn}, nil)
			err := s.Run(installDir, staged, backup)
			if err == nil {
				t.Fatal("expected the swap to fail")
			}
			var swapErr *Error
			if !errors.As(err, &swapErr) {
				t.Fatalf("expected *swap.Error, got %T", err)
			}
			if !swapErr.Reversed {
				t.Fatalf("swap was not reversed: %v", swapErr.ReverseErrs)
			}
			if s.Moved() != 0 {
				t.Errorf("journal still holds %d moves after a full reversal", s.Moved())
			}
			if got := treetest.Snapshot(t, installDir); !treetest.Equal(got, installBefore) {
				t.Errorf("install dir not restored:\n got %v\nwant %v", got, installBefore)
			}
			if got := treetest.Snapshot(t, staged); !treetest.Equal(got, stagedBefore) {
				t.Errorf("staged tree not restored:\n got %v\nwant %v", got, stagedBefore)
			}
			if got := treetest.Snapshot(t, backup); len(got) != 0 {
				t.Errorf("backup should be empty after a reversal, has %v", got)
			}
		})
	}
}

func TestReverseUndoesACompletedSwapInExactReverseOrder(t *testing.T) {
	installDir, staged, backup := setup(t)
	installBefore := treetest.Snapshot(t, installDir)
	stagedBefore := treetest.Snapshot(t, staged)

	fs := &failingFS{Policy: treetest.FastPolicy()}
	s := New(fs, nil)
	if err := s.Run(installDir, staged, backup); err != nil {
		t.Fatalf("swap: %v", err)
	}
	forward := append([]string(nil), fs.moves...)

	fs.moves = nil
	if errs := s.Reverse(); len(errs) > 0 {
		t.Fatalf("reverse: %v", errs)
	}

	if len(fs.moves) != len(forward) {
		t.Fatalf("reversed %d moves, forward did %d", len(fs.moves), len(forward))
	}
	for i := range forward {
		if fs.moves[i] != forward[len(forward)-1-i] {
			t.Fatalf("reverse order mismatch at %d: got %v, forward was %v", i, fs.moves, forward)
		}
	}
	if got := treetest.Snapshot(t, installDir); !treetest.Equal(got, installBefore) {
		t.Errorf("install dir not restored: %v", got)
	}
	if got := treetest.Snapshot(t, staged); !treetest.Equal(got, stagedBefore) {
		t.Errorf("staged tree not restored: %v", got)
	}
}

// A reversal that cannot finish must keep the unreversed moves on the journal,
// so a later attempt retries exactly those and nothing else.
func TestReverseKeepsStuckMovesOnTheJournal(t *testing.T) {
	installDir, staged, backup := setup(t)
	fs := &failingFS{Policy: treetest.FastPolicy()}
	s := New(fs, nil)
	if err := s.Run(installDir, staged, backup); err != nil {
		t.Fatalf("swap: %v", err)
	}
	total := s.Moved()

	fs.failOn = "Halo.exe"
	errs := s.Reverse()
	if len(errs) == 0 {
		t.Fatal("expected the reversal to report a failure")
	}
	if s.Moved() != len(errs) {
		t.Fatalf("journal holds %d moves, %d failed", s.Moved(), len(errs))
	}
	if s.Moved() >= total {
		t.Fatalf("journal did not shrink: %d of %d", s.Moved(), total)
	}

	fs.failOn = ""
	if errs := s.Reverse(); len(errs) > 0 {
		t.Fatalf("retrying the reversal failed: %v", errs)
	}
	if s.Moved() != 0 {
		t.Errorf("journal still holds %d moves", s.Moved())
	}
}

func TestSkip(t *testing.T) {
	installDir := filepath.FromSlash("/apps/Halo")
	staged := filepath.Join(installDir, ".halo-update", "staged")
	backup := filepath.Join(installDir, ".halo-update", "backup")

	for _, name := range []string{".halo-update", "Uninstall Halo.exe", "uninstall halo.exe", ".stage-complete"} {
		if !Skip(installDir, staged, backup, name) {
			t.Errorf("Skip(%q) = false, want true", name)
		}
	}
	for _, name := range []string{"Halo.exe", "resources", "ffmpeg.dll", "uninstaller-notes.txt"} {
		if Skip(installDir, staged, backup, name) {
			t.Errorf("Skip(%q) = true, want false", name)
		}
	}
}

func TestSwappableNames(t *testing.T) {
	root := t.TempDir()
	installDir := filepath.Join(root, "Halo")
	staged, backup := filepath.Join(root, "staged"), filepath.Join(root, "backup")

	names, err := SwappableNames(installDir, staged, backup)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("a missing install dir should yield no names, got %v", names)
	}

	treetest.Write(t, installDir, treetest.Tree{"a.dll": "a", "b.dll": "b", "Uninstall Halo.exe": "u"})
	names, err = SwappableNames(installDir, staged, backup)
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != "a.dll" || names[1] != "b.dll" {
		t.Fatalf("got %v", names)
	}
}
