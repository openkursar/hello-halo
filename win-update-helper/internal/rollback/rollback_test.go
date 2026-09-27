package rollback

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
	"github.com/openkursar/hello-halo/win-update-helper/internal/stage"
	"github.com/openkursar/hello-halo/win-update-helper/internal/state"
	"github.com/openkursar/hello-halo/win-update-helper/internal/swap"
	"github.com/openkursar/hello-halo/win-update-helper/internal/treetest"
)

type scene struct {
	installDir string
	staged     string
	backup     string
	statePath  string
	original   treetest.Tree
	newVersion treetest.Tree
}

func newScene(t *testing.T) *scene {
	t.Helper()
	root := t.TempDir()
	s := &scene{
		installDir: filepath.Join(root, "Halo"),
		staged:     filepath.Join(root, "staged"),
		backup:     filepath.Join(root, "backup"),
		statePath:  filepath.Join(root, "update-state.json"),
		original: treetest.Tree{
			"Halo.exe":           "old-exe",
			"resources/app.asar": "old-asar",
			"locales/en-US.pak":  "old-pak",
			"gone-in-new.dll":    "old-only",
			"Uninstall Halo.exe": "uninstaller",
		},
		newVersion: treetest.Tree{
			"Halo.exe":           "new-exe",
			"resources/app.asar": "new-asar",
			"locales/en-US.pak":  "new-pak",
			"brand-new.dll":      "new-only",
		},
	}
	treetest.Write(t, s.installDir, s.original)
	treetest.Write(t, s.staged, s.newVersion)
	treetest.Write(t, s.staged, treetest.Tree{stage.CompleteMarker: "2.0.0"})
	return s
}

// interrupt replays an apply move by move and stops after n of them, which is
// what a power cut or a killed task leaves behind.
func (s *scene) interrupt(t *testing.T, n int) {
	t.Helper()
	if err := os.MkdirAll(s.backup, 0o755); err != nil {
		t.Fatal(err)
	}
	retiring, err := swap.SwappableNames(s.installDir, s.staged, s.backup)
	if err != nil {
		t.Fatal(err)
	}
	promoting, err := swap.PromotableNames(s.staged)
	if err != nil {
		t.Fatal(err)
	}

	done := 0
	for _, name := range retiring {
		if done == n {
			return
		}
		if err := os.Rename(filepath.Join(s.installDir, name), filepath.Join(s.backup, name)); err != nil {
			t.Fatal(err)
		}
		done++
	}
	for _, name := range promoting {
		if done == n {
			return
		}
		if err := os.Rename(filepath.Join(s.staged, name), filepath.Join(s.installDir, name)); err != nil {
			t.Fatal(err)
		}
		done++
	}
}

// writeState records the staged listing the way apply does: before any move.
func (s *scene) writeState(t *testing.T, phase string, stagedEntries []string) {
	t.Helper()
	if err := state.Write(s.statePath, state.State{
		Phase:         phase,
		Version:       "2.0.0",
		InstallDir:    s.installDir,
		Staged:        s.staged,
		Backup:        s.backup,
		Relaunch:      filepath.Join(s.installDir, "Halo.exe"),
		StagedEntries: stagedEntries,
	}); err != nil {
		t.Fatal(err)
	}
}

// stagedEntries is the listing apply captures before the first rename.
func (s *scene) stagedEntries(t *testing.T) []string {
	t.Helper()
	names, err := swap.PromotableNames(s.staged)
	if err != nil {
		t.Fatal(err)
	}
	return names
}

func (s *scene) run(t *testing.T) error {
	t.Helper()
	policy := treetest.FastPolicy()
	return Run(s.statePath, &policy, func(string, ...any) {})
}

func TestRunRestoresTheInstallDirectoryFromAnyInterruptionPoint(t *testing.T) {
	// 4 entries move aside (the uninstaller stays), then 4 are promoted.
	const totalMoves = 8
	for stopAfter := 1; stopAfter <= totalMoves; stopAfter++ {
		t.Run(fmt.Sprintf("stop-after-%d", stopAfter), func(t *testing.T) {
			s := newScene(t)
			phase := state.PhaseSwapping
			if stopAfter == totalMoves {
				phase = state.PhaseAwaitingConfirm
			}
			entries := s.stagedEntries(t)
			s.interrupt(t, stopAfter)
			s.writeState(t, phase, entries)

			if err := s.run(t); err != nil {
				t.Fatalf("rollback: %v", err)
			}

			got := treetest.Snapshot(t, s.installDir)
			if !treetest.Equal(got, s.original) {
				t.Fatalf("install dir after rollback:\n got %v\nwant %v", got, s.original)
			}
			if fsx.Exists(s.statePath) {
				t.Error("state file survived a successful rollback")
			}
			if fsx.Exists(filepath.Join(s.staged, stage.CompleteMarker)) {
				t.Error("the staged tree that failed must not stay applicable")
			}
		})
	}
}

func TestRunIsIdempotent(t *testing.T) {
	s := newScene(t)
	entries := s.stagedEntries(t)
	s.interrupt(t, 7)
	s.writeState(t, state.PhaseSwapping, entries)

	if err := s.run(t); err != nil {
		t.Fatalf("first rollback: %v", err)
	}
	first := treetest.Snapshot(t, s.installDir)

	// A second run finds no state file at all.
	if err := s.run(t); err != nil {
		t.Fatalf("second rollback: %v", err)
	}
	// A third run with the state file restored must still be a no-op, because
	// the backup is gone and there is nothing left to undo.
	s.writeState(t, state.PhaseSwapping, entries)
	if err := s.run(t); err != nil {
		t.Fatalf("third rollback: %v", err)
	}

	if got := treetest.Snapshot(t, s.installDir); !treetest.Equal(got, first) {
		t.Fatalf("repeated rollbacks changed the install dir:\n got %v\nwant %v", got, first)
	}
	if !treetest.Equal(first, s.original) {
		t.Fatalf("install dir is not the previous version: %v", first)
	}
	if fsx.Exists(s.statePath) {
		t.Error("state file survived")
	}
}

func TestRunWithoutStateFileDoesNothing(t *testing.T) {
	s := newScene(t)
	before := treetest.Snapshot(t, s.installDir)
	if err := s.run(t); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if got := treetest.Snapshot(t, s.installDir); !treetest.Equal(got, before) {
		t.Fatal("rollback touched the install dir without a state file")
	}
}

func TestRunAfterACompletedSwapRestoresTheOldVersion(t *testing.T) {
	s := newScene(t)
	entries := s.stagedEntries(t)
	if err := swap.New(treetest.FastPolicy(), nil).Run(s.installDir, s.staged, s.backup); err != nil {
		t.Fatalf("swap: %v", err)
	}
	s.writeState(t, state.PhaseAwaitingConfirm, entries)

	if err := s.run(t); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if got := treetest.Snapshot(t, s.installDir); !treetest.Equal(got, s.original) {
		t.Fatalf("install dir after rollback:\n got %v\nwant %v", got, s.original)
	}
	// The new version goes back where it came from, uninstallable marker aside.
	staged := treetest.Snapshot(t, s.staged)
	for name, body := range s.newVersion {
		if staged[name] != body {
			t.Errorf("staged %s = %q, want %q", name, staged[name], body)
		}
	}
}
