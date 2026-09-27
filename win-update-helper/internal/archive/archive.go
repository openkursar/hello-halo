// Package archive owns the update archive format: a tar of one top-level
// directory, compressed with zstd. Writer and reader live together because the
// compression window has to agree on both sides — an archive packed with a
// larger window than the shipped decoder allows cannot be opened at all, on
// any user's machine.
package archive

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/klauspost/compress/zstd"

	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
)

// WindowLog is the log2 of the compression window used for update archives.
// The packer refuses to exceed it and the decoder is sized from it.
const WindowLog = 27

// DecoderMaxWindow is what a decoder must allow to open our archives.
const DecoderMaxWindow = 1 << WindowLog

// Extract streams an archive into dest, dropping the single top-level
// directory the archive is built around, and returns the number of files
// written. It never follows a path out of dest.
func Extract(archivePath, dest string, logf func(format string, args ...any)) (int, error) {
	root, err := filepath.Abs(dest)
	if err != nil {
		return 0, err
	}
	f, err := os.Open(archivePath)
	if err != nil {
		return 0, err
	}
	defer f.Close()

	dec, err := zstd.NewReader(f, zstd.WithDecoderMaxWindow(DecoderMaxWindow))
	if err != nil {
		return 0, err
	}
	defer dec.Close()

	tr := tar.NewReader(dec)
	var topLevel string
	count := 0
	for {
		header, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return count, err
		}
		switch header.Typeflag {
		case tar.TypeReg, tar.TypeDir:
		default:
			// A packed Windows Electron tree holds only files and
			// directories; a link or a device means this is not our archive.
			return count, fmt.Errorf("unsupported tar entry %q (type %q)", header.Name, string(header.Typeflag))
		}

		rel, top, err := stripTopLevel(header.Name)
		if err != nil {
			return count, err
		}
		if topLevel == "" {
			topLevel = top
		} else if top != topLevel {
			return count, fmt.Errorf("archive has more than one top-level directory (%q and %q)", topLevel, top)
		}
		if rel == "" {
			if header.Typeflag != tar.TypeDir {
				return count, fmt.Errorf("tar entry %q sits at the archive root, outside the packed tree", header.Name)
			}
			continue
		}

		target := filepath.Join(root, filepath.FromSlash(rel))
		if !fsx.WithinPath(root, target) || fsx.SamePath(root, target) {
			return count, fmt.Errorf("tar entry %q escapes the destination directory", header.Name)
		}

		if header.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return count, err
			}
			continue
		}
		if err := writeFile(tr, target, header.FileInfo().Mode()); err != nil {
			return count, err
		}
		count++
		if count%2000 == 0 && logf != nil {
			logf("stage: %d files extracted", count)
		}
	}
	if topLevel == "" {
		return count, errors.New("archive is empty")
	}
	return count, nil
}

func writeFile(src io.Reader, target string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, permFor(mode))
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, src); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// permFor keeps the executable bit and normalises everything else, so a tree
// packed on a build machine lands with predictable permissions.
func permFor(mode os.FileMode) os.FileMode {
	if mode&0o111 != 0 {
		return 0o755
	}
	return 0o644
}

// stripTopLevel removes the archive's single leading component and rejects any
// name that could resolve outside the destination.
func stripTopLevel(name string) (rel, top string, err error) {
	clean := path.Clean(strings.ReplaceAll(name, `\`, "/"))
	if clean == "." || clean == "/" {
		return "", "", fmt.Errorf("tar entry %q has no usable path", name)
	}
	if path.IsAbs(clean) || strings.HasPrefix(clean, "../") || clean == ".." {
		return "", "", fmt.Errorf("tar entry %q is not a relative path", name)
	}
	if strings.Contains(clean, ":") {
		return "", "", fmt.Errorf("tar entry %q contains a drive specifier", name)
	}
	top, rel, _ = strings.Cut(clean, "/")
	return rel, top, nil
}
