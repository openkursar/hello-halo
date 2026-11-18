#!/bin/sh
# Halo Server entrypoint.
#
# Halo cannot run displayless. Under --ozone-platform=headless, constructing any
# BrowserWindow dereferences a null pointer and the process dies with SIGSEGV
# (exit 139) — show:true, show:false and paintWhenInitiallyHidden:false crash
# identically, because it is window *construction* that fails, not rendering.
# Measured the same on Electron 29 (Chromium 122) and 43 (Chromium 150), so do
# not read a version bump as a reason to retry. The AI Browser hosts its page
# guests inside a host BrowserWindow, so a display is not optional.
#
# The answer is an in-memory X server: Xvfb has no physical output of any kind —
# nothing is ever rendered to a screen — but Chromium gets the display surface it
# needs for compositing and screenshots.
#
# The flags on the exec line below MUST be on the real command line, not applied
# from inside the app with app.commandLine.appendSwitch(). Both Ozone's platform
# selection and Electron's "running as root" check read argv before the main
# script runs; an in-process switch only changes what getSwitchValue() reports.
# Without --no-sandbox here the process dies at
# electron_main_delegate.cc with exit 133 before a single line of Halo runs.
set -eu

DISPLAY_NUM="${HALO_XVFB_DISPLAY:-99}"
SCREEN_GEOM="${HALO_XVFB_SCREEN:-1920x1080x24}"
X_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"

# PID of this shell. After the `exec` below this is Halo's PID, which is what
# the watchdog signals.
MAIN_PID=$$

# Is Xvfb still running?
#
# NOT `kill -0`: Xvfb is a child of this shell, and after the `exec` below this
# shell is replaced by Halo, which gives no guarantee of reaping it. A dead but
# unreaped child stays a zombie, and signalling a zombie succeeds — so `kill -0`
# would report Xvfb alive forever. Read the process state out of /proc instead
# and treat Z as dead. Field 3 of /proc/<pid>/stat is the state code; it is
# located by skipping past the comm field, which is parenthesised and may itself
# contain spaces.
xvfb_alive() {
    _stat=$(cat "/proc/${XVFB_PID}/stat" 2>/dev/null) || return 1
    [ -n "${_stat}" ] || return 1
    _state=${_stat#*') '}
    _state=${_state%% *}
    [ "${_state}" != "Z" ]
}

# With a data directory configured (normally a mounted volume), keep the app's
# own data there too — global skills, the AI engine's conversation records and
# the built-in browser profile live under HOME, not under HALO_DATA_DIR.
if [ -n "${HALO_DATA_DIR:-}" ] && [ "${HOME:-}" = "/tmp" ]; then
  export HOME="$HALO_DATA_DIR/home"
  mkdir -p "$HOME"
fi

# A library the base image lacks would otherwise surface as an opaque crash.
missing=$(ldd /app/linux-unpacked/halo 2>/dev/null | grep 'not found' || true)
if [ -n "$missing" ]; then
  echo "[halo-entrypoint] missing shared libraries:" >&2
  echo "$missing" >&2
fi

# Clear any leftovers from a previous run. /tmp survives `docker start`, and a
# stale /tmp/.X99-lock makes Xvfb refuse to start ("Server is already active for
# display 99") while a stale socket makes the readiness check below pass
# instantly — so the container would come up with no X server at all and
# Chromium would abort with "Missing X server or $DISPLAY". Nothing else in the
# container owns this display, so unlinking is unconditionally safe.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "${X_SOCKET}"

# Geometry is deliberately larger than the 1280x720 host window: h5 emulation
# and custom viewports can request more, and a screen smaller than the window
# clips the captured frame.
#
# -extension GLX: Xvfb links libGL, so a GLX request would make mesa load a
# software GPU driver from /usr/lib/*/dri and JIT through libLLVM. Nothing needs
# that here: Chromium runs with --disable-gpu and serves WebGL from its own
# bundled ANGLE+SwiftShader (measured: renderer reports "SwiftShader Device
# (Subzero)", never llvmpipe). Turning the extension off keeps a stray request
# from quietly pulling in that second, slower renderer.
echo "[halo-entrypoint] starting Xvfb :${DISPLAY_NUM} (${SCREEN_GEOM})"
Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN_GEOM}" -nolisten tcp -extension GLX &
XVFB_PID=$!

i=0
while [ ! -e "${X_SOCKET}" ]; do
    if ! xvfb_alive; then
        echo "[halo-entrypoint] FATAL: Xvfb exited during startup" >&2
        exit 1
    fi
    i=$((i + 1))
    if [ "${i}" -gt 150 ]; then
        echo "[halo-entrypoint] FATAL: Xvfb did not create ${X_SOCKET} within 15s" >&2
        kill "${XVFB_PID}" 2>/dev/null || true
        exit 1
    fi
    sleep 0.1
done
echo "[halo-entrypoint] Xvfb ready on :${DISPLAY_NUM} (pid ${XVFB_PID})"

export DISPLAY=":${DISPLAY_NUM}"

# The container runs as root, and the Claude Code CLI that Halo spawns refuses to
# start as root ("--dangerously-skip-permissions cannot be used with root/sudo
# privileges") unless this is set — it exits 1 and the agent produces nothing at
# all. Exported rather than passed to Halo, because the CLI is a grandchild that
# inherits the environment. The container IS the sandbox here: it is the isolation
# boundary the flag is asking about.
export IS_SANDBOX=1

# Without a display Halo does not degrade, it crashes. If Xvfb ever dies, bring
# the container down so the platform restarts it cleanly instead of leaving a
# Halo that segfaults on the next browser call.
(
    while xvfb_alive; do
        sleep 5
    done
    echo "[halo-entrypoint] FATAL: Xvfb died - terminating Halo" >&2
    kill -TERM "${MAIN_PID}" 2>/dev/null || true
) &

# --enable-unsafe-swiftshader is what makes WebGL work at all here. Since M112
# Chromium refuses to silently fall back to software WebGL: without the flag a
# page's getContext("webgl") returns null and the canvas never paints (measured:
# renderer "none"). The flag opts into the bundled SwiftShader rasterizer, after
# which the renderer reports "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
# (Subzero)), SwiftShader driver)" and GL pixels composite into captures.
#
# --disable-gpu must STAY. Dropping it does not help WebGL — there is no GPU to
# find, and Chromium then blocklists GL outright (ContextResult::kFatalFailure:
# WebGL1 blocklisted), which is strictly worse than the flag. "unsafe" refers to
# exposing a software GL implementation that was not security-hardened for
# untrusted content; the cost otherwise is CPU, since every GL frame is rasterized
# on the CPU. Pages that do not use WebGL are unaffected.
exec /app/linux-unpacked/halo \
    --ozone-platform=x11 --no-sandbox --disable-gpu --disable-dev-shm-usage \
    --enable-unsafe-swiftshader "$@"
