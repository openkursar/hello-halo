package apply

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// FailedVersionsFile is where a version that swapped in and then could not
// start is recorded, beside the staging directories it belongs to.
const FailedVersionsFile = "failed-versions.txt"

// recordFailedVersion notes that version was installed and never reported in.
//
// Without it the app finds the same release on its next check, stages it,
// swaps it, waits, rolls back, and starts over — a loop the user cannot leave
// because every attempt ends where it began. One line per version, appended,
// so a file damaged by a power cut costs at most the newest entry.
func recordFailedVersion(stateDir, version string) error {
	if version == "" {
		return nil
	}
	path := filepath.Join(stateDir, FailedVersionsFile)
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(version + "\n")
	return err
}

// ReadFailedVersions lists versions previously recorded as unable to start.
func ReadFailedVersions(stateDir string) []string {
	f, err := os.Open(filepath.Join(stateDir, FailedVersionsFile))
	if err != nil {
		return nil
	}
	defer f.Close()

	var out []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			out = append(out, line)
		}
	}
	return out
}
