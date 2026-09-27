// Command halo-update-packer produces the update archives that
// halo-update-helper's `stage` command consumes. It runs on the build machine.
//
// On success it prints one line of JSON describing the archive; the build
// script feeds those fields straight into the signed update description.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/openkursar/hello-halo/win-update-helper/internal/archive"
)

func main() {
	source := flag.String("source", "", "directory to pack; its base name becomes the archive's top-level directory")
	out := flag.String("out", "", "archive to write")
	level := flag.Int("level", archive.DefaultLevel, "zstd compression level, mapped onto the nearest pure-Go level")
	windowLog := flag.Int("long", archive.WindowLog, "log2 of the compression window")
	verbose := flag.Bool("verbose", false, "report progress on stderr")
	flag.Parse()

	if *source == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: halo-update-packer --source <dir> --out <file.tar.zst> [--level 19] [--long 27]")
		os.Exit(1)
	}

	// Progress goes to stderr so stdout stays a single parseable JSON line.
	logf := func(string, ...any) {}
	if *verbose {
		logf = func(format string, args ...any) {
			fmt.Fprintf(os.Stderr, "[packer] "+format+"\n", args...)
		}
	}

	result, err := archive.Pack(archive.PackOptions{
		Source:    *source,
		Out:       *out,
		Level:     *level,
		WindowLog: *windowLog,
	}, logf)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	blob, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(string(blob))
}
