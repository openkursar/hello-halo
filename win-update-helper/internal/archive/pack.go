package archive

import (
	"archive/tar"
	"crypto/sha512"
	"encoding/base64"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/klauspost/compress/zstd"
)

// DefaultLevel is the zstd level the update pipeline asks for. The pure-Go
// encoder has four discrete levels and maps anything above ~11 onto its best
// one, so asking for more than this changes nothing.
//
// Measured on the real 985 MiB Windows tree: 292 MiB archive, 82 s to pack,
// 14 s to verify and unpack. The CLI at -19 reaches 263 MiB on the same tree,
// so the pure-Go encoder costs ~11% in size — paid once per release, in the
// background, and worth not shelling out to a tool the build machine may not
// have. For reference the NSIS installer of the same build is 214 MiB.
const DefaultLevel = 19

type PackOptions struct {
	Source    string
	Out       string
	Level     int
	WindowLog int
}

// Result is consumed verbatim by the build script that publishes the update.
type Result struct {
	Size         int64  `json:"size"`
	SHA512       string `json:"sha512"`
	UnpackedSize int64  `json:"unpackedSize"`
}

// Pack writes the contents of Source into Out as a tar.zst holding a single
// top-level directory named after Source, which is the shape Extract expects.
func Pack(opts PackOptions, logf func(format string, args ...any)) (Result, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if opts.Level == 0 {
		opts.Level = DefaultLevel
	}
	if opts.WindowLog == 0 {
		opts.WindowLog = WindowLog
	}
	if opts.WindowLog > WindowLog {
		return Result{}, fmt.Errorf("window log %d exceeds what the shipped decoder accepts (%d); every client would fail to open the archive",
			opts.WindowLog, WindowLog)
	}
	source, err := filepath.Abs(opts.Source)
	if err != nil {
		return Result{}, err
	}
	info, err := os.Stat(source)
	if err != nil {
		return Result{}, err
	}
	if !info.IsDir() {
		return Result{}, fmt.Errorf("%s is not a directory", source)
	}

	out, err := os.Create(opts.Out)
	if err != nil {
		return Result{}, err
	}
	digest := sha512.New()
	sink := io.MultiWriter(out, digest)

	enc, err := zstd.NewWriter(sink,
		zstd.WithEncoderLevel(zstd.EncoderLevelFromZstd(opts.Level)),
		zstd.WithWindowSize(1<<opts.WindowLog))
	if err != nil {
		out.Close()
		os.Remove(opts.Out)
		return Result{}, err
	}

	unpacked, files, err := writeTar(enc, source, filepath.Base(source), logf)
	if err != nil {
		enc.Close()
		out.Close()
		os.Remove(opts.Out)
		return Result{}, err
	}
	if err := enc.Close(); err != nil {
		out.Close()
		os.Remove(opts.Out)
		return Result{}, err
	}
	if err := out.Close(); err != nil {
		os.Remove(opts.Out)
		return Result{}, err
	}

	packed, err := os.Stat(opts.Out)
	if err != nil {
		return Result{}, err
	}
	logf("pack: %d files, %d bytes unpacked, %d bytes packed", files, unpacked, packed.Size())
	return Result{
		Size:         packed.Size(),
		SHA512:       base64.StdEncoding.EncodeToString(digest.Sum(nil)),
		UnpackedSize: unpacked,
	}, nil
}

// writeTar walks source in lexical order so two packs of the same tree produce
// the same archive.
func writeTar(w io.Writer, source, top string, logf func(format string, args ...any)) (unpacked int64, files int, err error) {
	tw := tar.NewWriter(w)
	walkErr := filepath.WalkDir(source, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		name := top
		if rel != "." {
			name = top + "/" + filepath.ToSlash(rel)
		}

		info, err := d.Info()
		if err != nil {
			return err
		}

		// Windows builds are assembled on a macOS build machine, and npm leaves
		// symlinks inside node_modules (the agent SDK's cli.js is one). Windows
		// cannot be relied on to recreate a symlink without elevation, so the
		// link is resolved here and its target stored as an ordinary file —
		// which is what the packaged app needs to find at that path anyway.
		// Extract still refuses link entries, so an archive can never create one.
		if info.Mode()&fs.ModeSymlink != 0 {
			target, statErr := os.Stat(path)
			if statErr != nil {
				return fmt.Errorf("symlink %s does not resolve: %w", path, statErr)
			}
			if target.IsDir() {
				// Would need the walk to descend through the link, which invites
				// cycles and duplicated subtrees. No such link exists in the
				// product tree, so refuse rather than guess.
				return fmt.Errorf("%s is a symlink to a directory, which is not supported", path)
			}
			info = target
		}

		switch {
		case d.IsDir():
			header, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			header.Name = name + "/"
			header.Mode = 0o755
			return tw.WriteHeader(header)
		case info.Mode().IsRegular():
			header, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			header.Name = name
			header.Mode = int64(permFor(info.Mode()))
			if err := tw.WriteHeader(header); err != nil {
				return err
			}
			f, openErr := os.Open(path)
			if openErr != nil {
				return openErr
			}
			written, copyErr := io.Copy(tw, f)
			f.Close()
			if copyErr != nil {
				return copyErr
			}
			unpacked += written
			files++
			if files%2000 == 0 {
				logf("pack: %d files added", files)
			}
			return nil
		default:
			// Extract rejects these, so refusing here keeps the failure on the
			// build machine instead of on a user's.
			return fmt.Errorf("%s is neither a regular file nor a directory (%s)", path, info.Mode())
		}
	})
	if walkErr != nil {
		return 0, 0, walkErr
	}
	if err := tw.Close(); err != nil {
		return 0, 0, err
	}
	return unpacked, files, nil
}
