// Package stage unpacks an update archive next to the install directory while
// the app is still running. It touches nothing the running app owns.
package stage

import (
	"crypto/sha512"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/openkursar/hello-halo/win-update-helper/internal/archive"
	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
)

// CompleteMarker marks a staged tree as fully extracted. Its absence is what
// stops apply from swapping in a partial download.
const CompleteMarker = ".stage-complete"

type Options struct {
	Archive      string
	Dest         string
	ExpectSHA512 string
	Version      string
}

// Run verifies, extracts, and marks the staged tree. Any failure removes Dest
// entirely, so a half-written tree can never be mistaken for a finished one.
func Run(opts Options, fs *fsx.Policy, logf func(format string, args ...any)) error {
	logf("stage: verifying %s", opts.Archive)
	if err := verifySHA512(opts.Archive, opts.ExpectSHA512); err != nil {
		return exitcode.Wrap(exitcode.BadHash, err)
	}
	logf("stage: checksum ok")

	logf("stage: clearing %s", opts.Dest)
	if err := fs.RemoveWithRetry(opts.Dest); err != nil {
		return exitcode.Wrap(exitcode.StageFailed, err)
	}
	if err := os.MkdirAll(opts.Dest, 0o755); err != nil {
		return exitcode.Wrap(exitcode.StageFailed, err)
	}

	count, err := archive.Extract(opts.Archive, opts.Dest, logf)
	if err != nil {
		logf("stage: extraction failed, discarding %s", opts.Dest)
		if rmErr := fs.RemoveWithRetry(opts.Dest); rmErr != nil {
			logf("stage: could not discard %s: %v", opts.Dest, rmErr)
		}
		return exitcode.Wrap(exitcode.StageFailed, err)
	}
	logf("stage: extracted %d entries", count)

	marker := filepath.Join(opts.Dest, CompleteMarker)
	if err := os.WriteFile(marker, []byte(opts.Version), 0o644); err != nil {
		if rmErr := fs.RemoveWithRetry(opts.Dest); rmErr != nil {
			logf("stage: could not discard %s: %v", opts.Dest, rmErr)
		}
		return exitcode.Wrap(exitcode.StageFailed, err)
	}
	logf("stage: complete (version %s)", opts.Version)
	return nil
}

func verifySHA512(archive, expect string) error {
	if expect == "" {
		return errors.New("no expected sha512 given")
	}
	want, err := base64.StdEncoding.DecodeString(expect)
	if err != nil {
		return fmt.Errorf("expected sha512 is not base64: %w", err)
	}
	if len(want) != sha512.Size {
		return fmt.Errorf("expected sha512 is %d bytes, want %d", len(want), sha512.Size)
	}
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()

	sum := sha512.New()
	if _, err := io.Copy(sum, f); err != nil {
		return err
	}
	got := sum.Sum(nil)
	if base64.StdEncoding.EncodeToString(got) != base64.StdEncoding.EncodeToString(want) {
		return fmt.Errorf("checksum mismatch for %s: got %s", archive,
			base64.StdEncoding.EncodeToString(got))
	}
	return nil
}
