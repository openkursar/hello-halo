// Command halo-update-helper unpacks a Halo update beside the install
// directory while the app runs, and swaps it in once the app has quit.
//
// The install directory is never renamed or moved — the uninstaller path in
// the registry and every shortcut point inside it — so an update is a swap of
// that directory's contents and nothing more.
//
// Exit codes:
//
//	0  success
//	1  usage error, or a failure before anything was modified
//	2  archive checksum did not match
//	3  staging failed (download unreadable, extraction error, disk full)
//	4  staged tree has no completion marker; nothing was touched
//	5  the app did not exit in time; nothing was touched
//	6  swap failed and the install directory was fully restored
//	7  swap failed and the install directory could NOT be fully restored —
//	   the app is unlikely to start; run `rollback` with the state file
//	8  the new version never confirmed; the previous version was restored
//	9  rollback could not complete
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/openkursar/hello-halo/win-update-helper/internal/apply"
	"github.com/openkursar/hello-halo/win-update-helper/internal/exitcode"
	"github.com/openkursar/hello-halo/win-update-helper/internal/fsx"
	"github.com/openkursar/hello-halo/win-update-helper/internal/logx"
	"github.com/openkursar/hello-halo/win-update-helper/internal/rollback"
	"github.com/openkursar/hello-halo/win-update-helper/internal/stage"
)

// protocolVersion is what the app checks before trusting this binary.
const protocolVersion = 1

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(exitcode.Usage)
	}

	command, args := os.Args[1], os.Args[2:]
	if command == "version" {
		fmt.Println(protocolVersion)
		return
	}

	run, err := commandFor(command, args)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		usage()
		os.Exit(exitcode.Usage)
	}

	if err := run(); err != nil {
		os.Exit(exitcode.Of(err))
	}
}

type runner func() error

func commandFor(command string, args []string) (runner, error) {
	switch command {
	case "stage":
		return stageCommand(args)
	case "apply":
		return applyCommand(args)
	case "rollback":
		return rollbackCommand(args)
	default:
		return nil, fmt.Errorf("unknown command %q", command)
	}
}

func stageCommand(args []string) (runner, error) {
	fs := flag.NewFlagSet("stage", flag.ContinueOnError)
	archive := fs.String("archive", "", "path to the tar.zst update archive")
	dest := fs.String("dest", "", "directory to extract into (replaced if it exists)")
	sum := fs.String("expect-sha512", "", "base64 of the archive's sha512 digest")
	version := fs.String("version", "", "version string recorded in the completion marker")
	logPath := fs.String("log", "", "append progress to this file")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := logBadInvocation(*logPath, required(map[string]string{
		"archive": *archive, "dest": *dest, "expect-sha512": *sum, "version": *version,
	})); err != nil {
		return nil, err
	}

	return func() error {
		log := logx.New(*logPath)
		defer log.Close()
		policy := newPolicy(log)
		return report(log, stage.Run(stage.Options{
			Archive:      *archive,
			Dest:         *dest,
			ExpectSHA512: *sum,
			Version:      *version,
		}, &policy, log.Infof))
	}, nil
}

func applyCommand(args []string) (runner, error) {
	fs := flag.NewFlagSet("apply", flag.ContinueOnError)
	installDir := fs.String("install-dir", "", "the live install directory; its contents are swapped")
	staged := fs.String("staged", "", "directory holding the extracted new version")
	backup := fs.String("backup", "", "directory to hold the previous version")
	statePath := fs.String("state", "", "where to record the in-flight swap")
	relaunch := fs.String("relaunch", "", "executable to start once the swap is done")
	confirmFile := fs.String("confirm-file", "", "file the new version creates to prove it started")
	version := fs.String("version", "", "version being installed")
	waitPID := fs.Int("wait-pid", 0, "wait for this process to exit before swapping")
	confirmTimeout := fs.Int("confirm-timeout", int(apply.DefaultConfirmTimeout/time.Second), "seconds to wait for the confirm file")
	waitTimeout := fs.Int("wait-timeout", int(apply.DefaultWaitTimeout/time.Second), "seconds to wait for wait-pid to exit")
	logPath := fs.String("log", "", "append progress to this file")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := logBadInvocation(*logPath, required(map[string]string{
		"install-dir": *installDir, "staged": *staged, "backup": *backup,
		"state": *statePath, "relaunch": *relaunch, "confirm-file": *confirmFile,
		"version": *version,
	})); err != nil {
		return nil, err
	}

	return func() error {
		log := logx.New(*logPath)
		defer log.Close()
		policy := newPolicy(log)
		return report(log, apply.Run(apply.Options{
			InstallDir:     *installDir,
			Version:        *version,
			Staged:         *staged,
			Backup:         *backup,
			StatePath:      *statePath,
			Relaunch:       *relaunch,
			ConfirmFile:    *confirmFile,
			WaitPID:        *waitPID,
			ConfirmTimeout: time.Duration(*confirmTimeout) * time.Second,
			WaitTimeout:    time.Duration(*waitTimeout) * time.Second,
		}, &policy, log.Infof))
	}, nil
}

func rollbackCommand(args []string) (runner, error) {
	fs := flag.NewFlagSet("rollback", flag.ContinueOnError)
	statePath := fs.String("state", "", "state file written by a previous apply")
	waitPID := fs.Int("wait-pid", 0, "wait for this process to exit before rolling back")
	relaunch := fs.String("relaunch", "", "executable to start once the rollback is over")
	waitTimeout := fs.Int("wait-timeout", int(apply.DefaultWaitTimeout/time.Second), "seconds to wait for wait-pid to exit")
	logPath := fs.String("log", "", "append progress to this file")
	if err := fs.Parse(args); err != nil {
		return nil, err
	}
	if err := logBadInvocation(*logPath, required(map[string]string{"state": *statePath})); err != nil {
		return nil, err
	}

	return func() error {
		log := logx.New(*logPath)
		defer log.Close()
		policy := newPolicy(log)
		return report(log, rollback.RunAfterExit(rollback.AfterExitOptions{
			StatePath:   *statePath,
			WaitPID:     *waitPID,
			WaitTimeout: time.Duration(*waitTimeout) * time.Second,
			Relaunch:    *relaunch,
		}, &policy, log.Infof))
	}, nil
}

func newPolicy(log *logx.Logger) fsx.Policy {
	policy := fsx.Default()
	policy.Logf = log.Infof
	return policy
}

func report(log *logx.Logger, err error) error {
	if err == nil {
		log.Infof("done")
		return nil
	}
	log.Errorf("exit %d: %v", exitcode.Of(err), err)
	return err
}

// logBadInvocation records a bad invocation into the log file before giving up.
// Without it a caller passing the wrong flags leaves no trace, which from the
// outside looks the same as the helper never having started.
func logBadInvocation(logPath string, err error) error {
	if err == nil || logPath == "" {
		return err
	}
	log := logx.New(logPath)
	defer log.Close()
	log.Infof("ERROR bad invocation: %v", err)
	return err
}

func required(flags map[string]string) error {
	var missing []string
	for name, value := range flags {
		if value == "" {
			missing = append(missing, "--"+name)
		}
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return errors.New("missing required flags: " + strings.Join(missing, ", "))
	}
	return nil
}

func usage() {
	fmt.Fprint(os.Stderr, `halo-update-helper <command> [flags]

  stage     --archive <file> --dest <dir> --expect-sha512 <base64> --version <string>
  apply     --install-dir <dir> --staged <dir> --backup <dir> --state <path>
            --relaunch <exe> --confirm-file <path> --version <string>
            [--wait-pid <pid>] [--confirm-timeout <seconds>] [--wait-timeout <seconds>]
  rollback  --state <path> [--wait-pid <pid>] [--relaunch <exe>] [--wait-timeout <seconds>]
  version

  All commands accept --log <path>.
`)
}
