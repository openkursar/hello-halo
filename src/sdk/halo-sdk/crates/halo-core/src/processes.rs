use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    task::Waker,
    time::{Duration, Instant},
};
use tokio::process::Child;
use tokio_util::sync::CancellationToken;

struct ChildState {
    child: Child,
    waiters: Vec<Waker>,
    #[cfg(windows)]
    stopping_by_handle: bool,
}
#[derive(Clone)]
struct Process {
    generation: u64,
    group: bool,
    child: Arc<Mutex<ChildState>>,
    forced: CancellationToken,
}
#[derive(Default)]
pub(crate) struct OwnedProcesses {
    entries: Mutex<HashMap<u32, Process>>,
    next: AtomicU64,
    closed: AtomicBool,
}
pub(crate) struct OwnedProcess {
    owner: Weak<OwnedProcesses>,
    pid: u32,
    generation: u64,
    group: bool,
    child: Arc<Mutex<ChildState>>,
    active: AtomicBool,
}

const REAP_GRACE: Duration = Duration::from_millis(250);

#[cfg(any(windows, test))]
fn taskkill_result(
    status: std::process::ExitStatus,
    pids: &[u32],
    mut still_running: impl FnMut(u32) -> bool,
) -> std::io::Result<()> {
    if status.success() {
        return Ok(());
    }
    let remaining: Vec<_> = pids.iter().copied().filter(|pid| still_running(*pid)).collect();
    if remaining.is_empty() {
        Ok(())
    } else {
        Err(std::io::Error::other(format!("{status}; remaining PIDs: {remaining:?}")))
    }
}

#[cfg(any(windows, test))]
fn taskkill_args(pids: &[u32]) -> Vec<String> {
    pids.iter()
        .flat_map(|pid| ["/PID".to_owned(), pid.to_string()])
        .chain(["/T".to_owned(), "/F".to_owned()])
        .collect()
}

#[cfg(windows)]
pub(crate) fn windows_system_directory() -> std::io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = [0u16; 260];
    let size = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    match size {
        0 => Err(std::io::Error::last_os_error()),
        size if size < buffer.len() => Ok(std::ffi::OsString::from_wide(&buffer[..size]).into()),
        _ => Err(std::io::Error::other("Windows system directory exceeds the path buffer")),
    }
}

#[cfg(windows)]
fn windows_process_still_running(pid: u32) -> bool {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> RawHandle;
        fn WaitForSingleObject(handle: RawHandle, milliseconds: u32) -> u32;
    }
    const SYNCHRONIZE: u32 = 0x00100000;
    const ERROR_INVALID_PARAMETER: i32 = 87;
    const WAIT_OBJECT_0: u32 = 0;
    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return std::io::Error::last_os_error().raw_os_error() != Some(ERROR_INVALID_PARAMETER);
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    (unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) }) != WAIT_OBJECT_0
}

#[cfg(any(windows, test))]
fn finish_tree_termination(
    pid: u32,
    tree: std::io::Result<()>,
    kill_root: impl FnOnce() -> std::io::Result<()>,
) {
    if let Err(error) = tree {
        tracing::warn!(pid, error=%error, "Owned process tree termination failed; retrying the root by handle");
        if let Err(error) = kill_root() {
            tracing::warn!(pid, error=%error, "Owned process handle termination failed");
        }
    }
}

#[cfg(windows)]
fn kill_windows_tree(root: u32, pids: &[u32]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new(windows_system_directory()?.join("taskkill.exe"))
        .args(taskkill_args(pids))
        .creation_flags(0x08000000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let error = loop {
        match child.try_wait() {
            Ok(Some(status)) => return taskkill_result(status, pids, windows_process_still_running),
            Err(error) => break error,
            Ok(None) if Instant::now() >= deadline => {
                break std::io::Error::new(std::io::ErrorKind::TimedOut, "taskkill timed out");
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(1)),
        }
    };
    if let Err(error) = child.kill() {
        tracing::warn!(pid = root, error=%error, "Taskkill helper could not be stopped");
    }
    Err(error)
}

fn signal(state: &mut ChildState, pid: u32, group: bool, force: bool) {
    if state.child.id().is_none() || pid == 0 || pid == std::process::id() {
        return;
    }
    #[cfg(unix)]
    unsafe {
        let target = if group { -(pid as i32) } else { pid as i32 };
        if libc::kill(target, if force { libc::SIGKILL } else { libc::SIGTERM }) != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                tracing::warn!(pid,error=%error,"Owned process termination failed");
            }
        }
    }
    #[cfg(windows)]
    {
        if state.stopping_by_handle {
            if let Err(error) = state.child.start_kill() {
                tracing::warn!(pid, error=%error, "Owned shell root termination failed");
            }
        } else {
            finish_tree_termination(pid, kill_windows_tree(pid, &[pid]), || state.child.start_kill());
        }
        let _ = (group, force);
    }
}

fn reap(state: &mut ChildState, pid: u32, wake: &mut Vec<Waker>) -> bool {
    match state.child.try_wait() {
        Ok(Some(_)) => {
            wake.append(&mut state.waiters);
            true
        }
        Ok(None) => false,
        Err(error) => {
            tracing::warn!(pid,error=%error,"Owned process exit could not be observed");
            wake.append(&mut state.waiters);
            false
        }
    }
}
fn stop_one(child: &Arc<Mutex<ChildState>>, pid: u32, group: bool, wake: &mut Vec<Waker>) -> bool {
    let mut state = child.lock().unwrap_or_else(|error| error.into_inner());
    signal(&mut state, pid, group, true);
    let deadline = Instant::now() + REAP_GRACE;
    loop {
        if reap(&mut state, pid, wake) {
            return true;
        }
        if Instant::now() >= deadline {
            tracing::warn!(
                pid,
                "Owned process did not exit within synchronous cleanup grace"
            );
            return false;
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

async fn wait_for_retirement<T>(
    wait: impl Future<Output = std::io::Result<T>>,
    forced: &CancellationToken,
) -> std::io::Result<T> {
    tokio::pin!(wait);
    tokio::select! {
        result = &mut wait => result,
        _ = forced.cancelled() => tokio::time::timeout(REAP_GRACE, &mut wait)
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "Owned process exit remained unconfirmed after forced cleanup"))?,
    }
}

impl OwnedProcesses {
    pub(crate) fn count(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len()
    }
    pub(crate) async fn wait_all(self: &Arc<Self>) -> std::io::Result<()> {
        let processes: Vec<_> = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .map(|(&pid, process)| {
                (OwnedProcess {
                    owner: Arc::downgrade(self),
                    pid,
                    generation: process.generation,
                    group: process.group,
                    child: process.child.clone(),
                    active: AtomicBool::new(false),
                }, process.forced.clone())
            })
            .collect();
        futures::future::try_join_all(processes.into_iter().map(|(process, forced)| async move {
            wait_for_retirement(process.wait(), &forced).await
        }))
        .await?;
        Ok(())
    }
    pub(crate) fn track(self: &Arc<Self>, child: Child, group: bool) -> OwnedProcess {
        let pid = child.id().unwrap_or(0);
        let child = Arc::new(Mutex::new(ChildState {
            child,
            waiters: Vec::new(),
            #[cfg(windows)]
            stopping_by_handle: false,
        }));
        let generation = self.next.fetch_add(1, Ordering::Relaxed);
        let active = {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.closed.load(Ordering::Acquire) || pid == 0 {
                false
            } else {
                entries.insert(
                    pid,
                    Process {
                        generation,
                        group,
                        child: child.clone(),
                        forced: CancellationToken::new(),
                    },
                );
                true
            }
        };
        if !active && pid != 0 {
            let mut wake = Vec::new();
            stop_one(&child, pid, group, &mut wake);
            for waiter in wake {
                waiter.wake();
            }
        }
        OwnedProcess {
            owner: Arc::downgrade(self),
            pid,
            generation,
            group,
            child,
            active: AtomicBool::new(active),
        }
    }
    pub(crate) fn abort_now(&self) {
        self.closed.store(true, Ordering::Release);
        let mut wake = Vec::new();
        {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for (&pid, process) in entries.iter() {
                signal(
                    &mut process
                        .child
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()),
                    pid,
                    process.group,
                    true,
                );
            }
            let deadline = Instant::now() + REAP_GRACE;
            loop {
                entries.retain(|pid, process| {
                    !reap(
                        &mut process
                            .child
                            .lock()
                            .unwrap_or_else(|error| error.into_inner()),
                        *pid,
                        &mut wake,
                    )
                });
                if entries.is_empty() {
                    break;
                }
                if Instant::now() >= deadline {
                    tracing::warn!(
                        remaining = entries.len(),
                        "Owned processes did not exit within synchronous cleanup grace"
                    );
                    for process in entries.values() {
                        process.forced.cancel();
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        for waiter in wake {
            waiter.wake();
        }
    }
    fn abort(&self, pid: u32, generation: u64) {
        let mut wake = Vec::new();
        {
            let mut entries = self
                .entries
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if let Some(process) = entries
                .get(&pid)
                .filter(|entry| entry.generation == generation)
                .cloned()
            {
                if stop_one(&process.child, pid, process.group, &mut wake) {
                    entries.remove(&pid);
                } else {
                    process.forced.cancel();
                }
            }
        }
        for waiter in wake {
            waiter.wake();
        }
    }
    fn signal(&self, pid: u32, generation: u64, force: bool) {
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(process) = entries
            .get(&pid)
            .filter(|entry| entry.generation == generation)
        {
            signal(
                &mut process
                    .child
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
                pid,
                process.group,
                force,
            );
        }
    }
}
impl Drop for OwnedProcesses {
    fn drop(&mut self) {
        self.abort_now();
    }
}

impl OwnedProcess {
    pub(crate) fn id(&self) -> Option<u32> {
        self.child
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .child
            .id()
    }
    pub(crate) async fn wait(&self) -> std::io::Result<std::process::ExitStatus> {
        std::future::poll_fn(|context| {
            let owner = self.owner.upgrade();
            let mut entries = owner.as_ref().map(|owner| {
                owner
                    .entries
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
            });
            let mut child = self.child.lock().unwrap_or_else(|error| error.into_inner());
            if !child
                .waiters
                .iter()
                .any(|waiter| waiter.will_wake(context.waker()))
            {
                child.waiters.push(context.waker().clone());
            }
            // Both wait paths update the same Child before its PID can be reused.
            let result = {
                let wait = child.child.wait();
                tokio::pin!(wait);
                wait.as_mut().poll(context)
            };
            let wake = if result.is_ready() {
                if let Some(entries) = entries.as_mut() {
                    if entries
                        .get(&self.pid)
                        .is_some_and(|entry| entry.generation == self.generation)
                    {
                        entries.remove(&self.pid);
                    }
                }
                self.active.store(false, Ordering::Release);
                std::mem::take(&mut child.waiters)
            } else {
                Vec::new()
            };
            drop(child);
            drop(entries);
            for waiter in wake {
                if !waiter.will_wake(context.waker()) {
                    waiter.wake();
                }
            }
            result
        })
        .await
    }
    pub(crate) async fn terminate(&self, force: bool) {
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        #[cfg(unix)]
        owner.signal(self.pid, self.generation, force);
        #[cfg(windows)]
        {
            let pid = self.pid;
            let generation = self.generation;
            if let Err(error) =
                tokio::task::spawn_blocking(move || owner.signal(pid, generation, force)).await
            {
                tracing::warn!(pid,error=%error,"Owned process termination task failed");
            }
        }
    }
    #[cfg(windows)]
    pub(crate) fn stop_windows_root(&self) {
        let mut state = self.child.lock().unwrap_or_else(|error| error.into_inner());
        state.stopping_by_handle = true;
        signal(&mut state, self.pid, self.group, true);
    }

    #[cfg(windows)]
    pub(crate) fn windows_stop_handle(&self) -> std::io::Result<std::os::windows::io::OwnedHandle> {
        use std::os::windows::io::BorrowedHandle;

        let mut state = self.child.lock().unwrap_or_else(|error| error.into_inner());
        state.stopping_by_handle = true;
        let result = state.child.raw_handle().ok_or_else(|| std::io::Error::other("Owned shell handle is no longer available"))
            .and_then(|raw| unsafe { BorrowedHandle::borrow_raw(raw) }.try_clone_to_owned());
        if result.is_err() {
            // Failure to duplicate must not route cleanup back through the numeric PID.
            signal(&mut state, self.pid, self.group, true);
        }
        result
    }

    pub(crate) fn abort_now(&self) {
        if self.active.swap(false, Ordering::AcqRel) {
            if let Some(owner) = self.owner.upgrade() {
                owner.abort(self.pid, self.generation);
            } else {
                let mut wake = Vec::new();
                stop_one(&self.child, self.pid, self.group, &mut wake);
                for waiter in wake {
                    waiter.wake();
                }
            }
        }
    }
}
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        self.abort_now();
    }
}

#[cfg(test)]
mod retirement_tests {
    use super::*;
    use std::io::{Error, ErrorKind};

    #[tokio::test]
    async fn retirement_wait_keeps_waiting_until_forced_then_reports_timeout() {
        let forced = CancellationToken::new();
        let wait = wait_for_retirement(std::future::pending::<std::io::Result<()>>(), &forced);
        tokio::pin!(wait);
        assert!(tokio::time::timeout(REAP_GRACE + Duration::from_millis(20), &mut wait)
            .await
            .is_err());
        forced.cancel();
        let error = tokio::time::timeout(Duration::from_secs(2), &mut wait)
            .await
            .expect("forced retirement must have a deadline")
            .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::TimedOut);
    }

    #[test]
    fn tree_exit_success_skips_root_fallback_and_all_failures_invoke_it() {
        #[cfg(unix)]
        use std::os::unix::process::ExitStatusExt;
        #[cfg(windows)]
        use std::os::windows::process::ExitStatusExt;
        use std::process::ExitStatus;

        let pids = [123, 456, 789];
        assert_eq!(taskkill_args(&pids), ["/PID", "123", "/PID", "456", "/PID", "789", "/T", "/F"]);
        assert!(taskkill_result(ExitStatus::from_raw(0), &pids, |_| panic!("successful taskkill needs no liveness probe")).is_ok());
        let nonzero = ExitStatus::from_raw(256);
        assert!(taskkill_result(nonzero, &pids, |_| false).is_ok());
        let incomplete = taskkill_result(nonzero, &pids, |pid| pid == 456);
        assert!(incomplete.as_ref().unwrap_err().to_string().contains("remaining PIDs: [456]"));
        let mut root_kills = 0;
        for outcome in [
            Ok(()),
            incomplete,
            Err(Error::from(ErrorKind::TimedOut)),
            Err(Error::from(ErrorKind::NotFound)),
        ] {
            finish_tree_termination(123, outcome, || {
                root_kills += 1;
                Ok(())
            });
        }
        assert_eq!(root_kills, 3);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::process::Stdio;
    use tokio::io::{AsyncBufReadExt, BufReader};

    fn sleeping(owner: &Arc<OwnedProcesses>) -> OwnedProcess {
        let child = tokio::process::Command::new("sh")
            .args(["-c", "exec sleep 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        owner.track(child, true)
    }
    fn absent(pid: u32) -> bool {
        unsafe {
            libc::kill(pid as i32, 0) != 0
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }
    #[tokio::test]
    async fn forced_cleanup_reaps_the_owned_child_and_preserves_another_owner() {
        let first = Arc::new(OwnedProcesses::default());
        let other = Arc::new(OwnedProcesses::default());
        let child = sleeping(&first);
        let sibling = sleeping(&other);
        let pid = child.id().unwrap();
        let sibling_pid = sibling.id().unwrap();
        first.abort_now();
        first.abort_now();
        assert!(absent(pid));
        assert!(!absent(sibling_pid));
        assert!(!child.wait().await.unwrap().success());
        assert_eq!(child.id(), None);
        other.abort_now();
        assert!(absent(sibling_pid));
        assert!(!sibling.wait().await.unwrap().success());
    }
    #[test]
    fn forced_cleanup_reaps_without_a_live_async_runtime() {
        let owner = Arc::new(OwnedProcesses::default());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let child = runtime.block_on(async { sleeping(&owner) });
        let pid = child.id().unwrap();
        drop(runtime);
        owner.abort_now();
        assert!(absent(pid));
        assert_eq!(child.id(), None);
    }
    #[tokio::test]
    async fn ordinary_termination_keeps_the_sigterm_handler_and_exit_status() {
        let owner = Arc::new(OwnedProcesses::default());
        let mut child = tokio::process::Command::new("sh")
            .args([
                "-c",
                "trap 'exit 23' TERM; printf 'ready\\n'; while :; do sleep 1; done",
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap()).lines();
        let owned = owner.track(child, true);
        assert_eq!(output.next_line().await.unwrap().as_deref(), Some("ready"));
        owned.terminate(false).await;
        assert_eq!(owned.wait().await.unwrap().code(), Some(23));
    }
}
