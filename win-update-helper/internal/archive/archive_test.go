package archive

import (
	"archive/tar"
	"bytes"
	"crypto/sha512"
	"encoding/base64"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"
)

// TestPackExtractRoundTrip is the contract between the build machine and the
// user's machine: what goes in comes back out, executable bits included.
func TestPackExtractRoundTrip(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "win-unpacked")
	files := map[string]fs.FileMode{
		"Halo.exe":                         0o755,
		"ffmpeg.dll":                       0o644,
		"resources/app.asar":               0o644,
		"resources/app.asar.unpacked/x.js": 0o644,
		"locales/en-US.pak":                0o644,
		"tools/postinstall.sh":             0o755,
	}
	for name, mode := range files {
		path := filepath.Join(source, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("contents of "+name), mode); err != nil {
			t.Fatal(err)
		}
	}
	// An empty directory must survive too: Electron ships a few.
	if err := os.MkdirAll(filepath.Join(source, "swiftshader"), 0o755); err != nil {
		t.Fatal(err)
	}

	out := filepath.Join(root, "update.tar.zst")
	if _, err := Pack(PackOptions{Source: source, Out: out}, nil); err != nil {
		t.Fatalf("pack: %v", err)
	}

	dest := filepath.Join(root, "staged")
	if _, err := Extract(out, dest, nil); err != nil {
		t.Fatalf("extract: %v", err)
	}

	for name, mode := range files {
		path := filepath.Join(dest, filepath.FromSlash(name))
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if string(body) != "contents of "+name {
			t.Errorf("%s = %q", name, body)
		}
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		// Windows has no executable bit to preserve; Go reports every file as 0666.
		if runtime.GOOS != "windows" && executable(info.Mode()) != executable(mode) {
			t.Errorf("%s mode = %v, want executable=%v", name, info.Mode(), executable(mode))
		}
	}
	if info, err := os.Stat(filepath.Join(dest, "swiftshader")); err != nil || !info.IsDir() {
		t.Errorf("empty directory did not survive: %v", err)
	}
	// The top-level directory is stripped, not recreated.
	if _, err := os.Stat(filepath.Join(dest, "win-unpacked")); err == nil {
		t.Error("top-level directory was not stripped")
	}
}

func TestPackResultDescribesTheArchive(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "win-unpacked")
	if err := os.MkdirAll(filepath.Join(source, "resources"), 0o755); err != nil {
		t.Fatal(err)
	}
	bodies := map[string]string{"Halo.exe": "0123456789", "resources/app.asar": "abc"}
	var unpacked int64
	for name, body := range bodies {
		if err := os.WriteFile(filepath.Join(source, filepath.FromSlash(name)), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		unpacked += int64(len(body))
	}

	out := filepath.Join(root, "update.tar.zst")
	result, err := Pack(PackOptions{Source: source, Out: out}, nil)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}

	if result.UnpackedSize != unpacked {
		t.Errorf("unpackedSize = %d, want %d", result.UnpackedSize, unpacked)
	}
	blob, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if result.Size != int64(len(blob)) {
		t.Errorf("size = %d, want %d", result.Size, len(blob))
	}
	// The client rejects a digest that is not 88 base64 characters over 64 bytes.
	if len(result.SHA512) != 88 {
		t.Errorf("sha512 is %d characters, want 88", len(result.SHA512))
	}
	raw, err := base64.StdEncoding.DecodeString(result.SHA512)
	if err != nil || len(raw) != sha512.Size {
		t.Fatalf("sha512 does not decode to %d bytes: %v", sha512.Size, err)
	}
	want := sha512.Sum512(blob)
	if !bytes.Equal(raw, want[:]) {
		t.Error("sha512 does not match the archive on disk")
	}
}

func TestPackRefusesAWindowTheDecoderCannotOpen(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "win-unpacked")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(root, "update.tar.zst")
	if _, err := Pack(PackOptions{Source: source, Out: out, WindowLog: WindowLog + 1}, nil); err == nil {
		t.Fatal("expected an oversized window to be refused")
	}
	if _, err := os.Stat(out); err == nil {
		t.Error("a refused pack must not leave an archive behind")
	}
}

func TestPackRefusesSymlinkedDirectories(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "win-unpacked")
	if err := os.MkdirAll(filepath.Join(source, "real"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real", filepath.Join(source, "alias")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// Following one would mean walking through the link, which invites cycles
	// and duplicated subtrees. Symlinked *files* are resolved instead — see
	// TestPackResolvesSymlinks.
	if _, err := Pack(PackOptions{Source: source, Out: filepath.Join(root, "update.tar.zst")}, nil); err == nil {
		t.Fatal("expected a symlink to a directory to be refused")
	}
}

type entry struct {
	name     string
	body     string
	typeflag byte
	linkname string
}

func buildArchive(t *testing.T, entries []entry) string {
	t.Helper()
	var raw bytes.Buffer
	enc, err := zstd.NewWriter(&raw)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(enc)
	for _, e := range entries {
		flag := e.typeflag
		if flag == 0 {
			flag = tar.TypeReg
		}
		header := &tar.Header{
			Name:     e.name,
			Mode:     0o644,
			Size:     int64(len(e.body)),
			Typeflag: flag,
			Linkname: e.linkname,
			ModTime:  time.Unix(0, 0),
		}
		if flag != tar.TypeReg {
			header.Size = 0
		}
		if err := tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if header.Size > 0 {
			if _, err := tw.Write([]byte(e.body)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "hostile.tar.zst")
	if err := os.WriteFile(path, raw.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractRejectsHostileArchives(t *testing.T) {
	cases := map[string][]entry{
		"parent traversal":          {{name: "win-unpacked/../../evil.txt", body: "x"}},
		"deep traversal":            {{name: "win-unpacked/resources/../../../evil.txt", body: "x"}},
		"absolute path":             {{name: "/etc/passwd", body: "x"}},
		"backslash traversal":       {{name: `win-unpacked\..\..\evil.txt`, body: "x"}},
		"drive letter":              {{name: "win-unpacked/C:/evil.txt", body: "x"}},
		"symlink":                   {{name: "win-unpacked/link", typeflag: tar.TypeSymlink, linkname: "../../secret"}},
		"hardlink":                  {{name: "win-unpacked/link", typeflag: tar.TypeLink, linkname: "win-unpacked/Halo.exe"}},
		"two top-level directories": {{name: "win-unpacked/Halo.exe", body: "a"}, {name: "other/Halo.exe", body: "b"}},
		"file at archive root":      {{name: "loose.txt", body: "x"}},
		"empty archive":             {},
	}

	for name, entries := range cases {
		t.Run(name, func(t *testing.T) {
			dest := filepath.Join(t.TempDir(), "staged")
			if _, err := Extract(buildArchive(t, entries), dest, nil); err == nil {
				t.Fatal("expected the archive to be rejected")
			}
			if _, err := os.Stat(filepath.Join(dest, "evil.txt")); err == nil {
				t.Error("a rejected entry was written")
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(dest), "evil.txt")); err == nil {
				t.Error("a rejected entry escaped the destination")
			}
		})
	}
}

func TestStripTopLevel(t *testing.T) {
	rel, top, err := stripTopLevel("win-unpacked/resources/app.asar")
	if err != nil || rel != "resources/app.asar" || top != "win-unpacked" {
		t.Fatalf("got (%q, %q, %v)", rel, top, err)
	}
	if rel, _, err := stripTopLevel("win-unpacked/"); err != nil || rel != "" {
		t.Fatalf("top-level dir entry: (%q, %v)", rel, err)
	}
	if _, _, err := stripTopLevel(".."); err == nil {
		t.Fatal("expected .. to be rejected")
	}
}

func executable(mode fs.FileMode) bool { return mode&0o111 != 0 }
