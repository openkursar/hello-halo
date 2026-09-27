// Package state persists what an in-flight swap is doing. It is the only
// thing that survives a power loss between the first and the last rename, and
// therefore the only way a later run can tell an interrupted update from a
// healthy install.
package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

const (
	// CurrentStateVersion guards against a helper reading a layout it predates.
	CurrentStateVersion = 1

	PhaseSwapping        = "swapping"
	PhaseAwaitingConfirm = "awaiting-confirm"
)

type State struct {
	StateVersion int    `json:"stateVersion"`
	Phase        string `json:"phase"`
	// Version is the version being installed. During awaiting-confirm the app
	// compares it against its own to tell "the new version is starting, write
	// the confirm file" from "the helper died and the old version came back".
	Version    string `json:"version"`
	InstallDir string `json:"installDir"`
	Staged     string `json:"staged"`
	Backup     string `json:"backup"`
	Relaunch   string `json:"relaunch"`
	UpdatedAt  string `json:"updatedAt"`
	// StagedEntries is the top-level listing of the staged tree taken before
	// any rename. Without it, a recovery run cannot tell a file the new
	// version added from a file the old version owned and never gave up.
	StagedEntries []string `json:"stagedEntries"`
	// HelperPID is the helper performing this apply. An app started while it
	// is still running must leave the install directory alone: the helper is
	// mid-swap or waiting for a confirmation, and will finish or reverse on
	// its own.
	HelperPID int `json:"helperPid,omitempty"`
}

// Write replaces the state file atomically and flushes it, so a crash leaves
// either the previous state or the new one, never a truncated file. A torn
// write at the moment of a power cut is the exact scenario this file exists for.
func Write(path string, s State) error {
	s.StateVersion = CurrentStateVersion
	s.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	blob, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(blob); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	return os.Rename(tmp, path)
}

var ErrNotFound = errors.New("no state file")

func Read(path string) (State, error) {
	blob, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return State{}, ErrNotFound
		}
		return State{}, err
	}
	var s State
	if err := json.Unmarshal(blob, &s); err != nil {
		return State{}, fmt.Errorf("state file %s is unreadable: %w", path, err)
	}
	if s.StateVersion > CurrentStateVersion {
		return State{}, fmt.Errorf("state file %s was written by a newer helper (state version %d)", path, s.StateVersion)
	}
	return s, nil
}

func Remove(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}
