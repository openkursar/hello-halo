# services/updater — Design Decisions

## 1. Why this is a module and not a file

It used to be one file driving electron-updater. It became a module when Windows
gained a second way to apply an update, because the two paths differ in
everything except the moment the user clicks a button.

```
updater/
  index.ts        coordinator: scheduling, which path runs, IPC surface
  status.ts       the announced update + what the renderer is told
  legacy.ts       electron-updater (macOS, Linux, Windows installer path)
  version.ts      semver precedence
  staged/         Windows background-unpack path
    manifest.ts   signed update description: verify, then validate
    download.ts   fetching the package
    helper.ts     invoking the native helper, and its exit codes
    layout.ts     where staging files live, and why they live there
    index.ts      check / prepare / apply / recover
```

Public surface is `index.ts`. Nothing outside the module imports `staged/*` or
`legacy.ts`.

## 2. The two paths

| | legacy | staged |
|---|---|---|
| platforms | macOS, Linux, Windows | Windows only |
| feed | `latest.yml` via electron-updater | signed description at `/staged/<platform>-<arch>.json` |
| cost at click | full NSIS install (~30 s) | directory rename + relaunch |
| applies by | `autoUpdater.quitAndInstall` | native helper swaps directories |

Selection happens once at init from `updateConfig.windowsMode` and is cached.
Re-deriving it per event would let one update start on one path and finish on
the other.

On a staged build electron-updater never installs on quit
(`autoInstallOnAppQuit` off). It is only a fallback there, and a quit that
also ran a downloaded installer would have NSIS and the swap helper writing
the same install directory at once. The user's click decides which one runs.

**The staged path declines rather than fails.** Missing helper, unverifiable
description, no disk space, unreachable feed — all return "no staged update"
and let electron-updater handle the check. Staying on the current version is
always acceptable; a half-applied update is not.

## 3. Why the description is signed, and why the server cannot sign it

The internal feed is plain HTTP and Windows builds carry no code signature. A
staged update unpacks an archive and then runs it, so something has to
authenticate the thing naming that archive. That is the Ed25519 signature,
verified against a public key baked into product.json.

Signing happens on the build machine. A release server able to sign could mint
updates, which is the exact attack the signature exists to stop. The server
stores the signed blob as an ordinary asset and serves it byte-for-byte.

`windowsMode: 'staged'` without `manifestPublicKey` resolves to `legacy` — an
unverifiable staged path is worse than a slow one.

A valid signature is necessary, not sufficient. It proves the description came
from our build machine; it does not prove the server served the *current* one,
or one meant for this product, channel, platform or version. Those are checked
separately in `manifest.ts`, which is what makes serving an old-but-validly-
signed description useless as a downgrade attack.

## 4. The swap, and what makes it reversible

The install directory is **never renamed or moved**: the uninstaller path in the
registry and every shortcut point inside it. Only its contents are exchanged.

Everything staging touches lives inside the install directory under a
dot-prefixed scratch directory, because a rename is only instant when both
sides are on the same volume. Staging to userData would silently turn the fast
path back into a ~1 GB copy.

Applying is: quit → helper moves the current contents aside → moves the staged
contents in → relaunches → waits for the new version to confirm it started. No
confirmation means the moves are reversed and the old version comes back. The
helper journals every rename so the reversal is exact.

**The back-out stops every version it launched before reversing.** A new version
that is slow rather than broken is still running when the confirm window
closes, still holding its own executable and DLLs open — and those are exactly
the files the reversal renames. Reversing around a live process fails on
Windows, which would turn a slow machine into the one outcome that leaves the
app unstartable. The helper owns those process ids because it started them,
so it terminates them first — all of them, since when the retry start loses
the single-instance lock it is the first process that is still alive. This is the only case where the helper kills anything; the
process it *waits* for on the way in is never touched, because that quit may
have been cancelled by the user.

The helper is a separate native binary (`win-update-helper/`, repo root, Go)
because by the time it runs, the Electron runtime that would host this code has
already been moved aside. The copy that runs is placed in the dot-prefixed work
directory, which the swap skips — not %TEMP%, where antivirus and AppLocker
routinely block executables. The app quits only after the helper process has
actually started; a blocked spawn is an ordinary error that falls back to the
installer path.

Every exit taken after the app has quit relaunches the version left in
place — a reversed swap, an unusable staged tree, a failed confirmation. The
user clicked "restart"; an app that simply stays gone is the one outcome they
cannot act on. Only a swap that could not be reversed leaves nothing to start.

**Startup recovery also runs from the helper.** A state file found at startup
means an apply was interrupted. Recovery moves this app's own executable and
resources, which Windows will not rename while they are open, so the app
hands `rollback --wait-pid --relaunch` to a detached helper and quits. It
does nothing while the apply helper recorded in the state file is still
alive (a user relaunching mid-swap must not race it), and stops retrying
after three attempts, since each attempt is a restart.

## 5. Health confirmation is version-keyed

The restarted app writes `confirmed-<its own version>.ok`. The helper waits for
`confirmed-<the version it installed>.ok`. If a failed swap leaves the *old*
version running, it writes a filename the helper is not waiting for, and the
timeout does the right thing without anyone comparing versions.

The startup reconciliation does still read the helper's state file, because
"swap succeeded, new version starting" and "swap succeeded, wrong version
starting" both present as phase `awaiting-confirm`. Telling them apart needs
the target version, which is why the state file carries it. Getting this wrong
rolls back every successful update on its first launch — the common case would
be the broken one.

## 6. Exit codes cross a language boundary

`staged/helper.ts` mirrors `win-update-helper/internal/exitcode/exitcode.go`.
Nothing but `tests/unit/services/updater/helper-exit-codes.test.ts` couples
them, and it exists because an inserted code once shifted every later value by
one — which reported a cleanly reversed swap as an install needing reinstalling.

## 7. Measured behaviour (real installs, Windows)

Numbers from actual updates, not estimates. They are the baseline to compare
against if this path is ever changed.

| Step | Time |
|---|---|
| app exits | ~1 s |
| swap (37 renames) | < 1 s |
| **starting the new process** | **3–5 s** |
| app init to confirmation | ~3 s |
| **click → window visible** | **~8–12 s** |

Almost all of the remaining cost is the freshly written tree being started for
the first time; the swap itself is negligible. A prewarm was built, shipped and
measured — running the staged binary once while it was still just a directory —
and it made no measurable difference (4.2 s spent, no gain), because the file is
renamed into place afterwards and the real start additionally loads Chromium and
the 330 MB `app.asar`, which a Node-mode run never touches. It was removed.
Do not re-add it without a measurement that shows it working.

## 8. Channels

`updateConfig.channel` is build-time only. A runtime-switchable channel could
walk a user from the stable feed onto prereleases without anyone publishing
anything.

Stable and preview builds deliberately share `dataFolderName`, so they share
one data directory, one single-instance lock, and one database. That sharing is
what `platform/store`'s schema guard and `foundation/running-instance` exist to
make survivable — read those before changing either identity field.
