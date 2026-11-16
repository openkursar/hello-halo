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

struct ChildState {
    child: Child,
    waiters: Vec<Waker>,
}
#[derive(Clone)]
struct Process {
    generation: u64,
    group: bool,
    child: Arc<Mutex<ChildState>>,
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
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("taskkill.exe");
        command
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        match command.spawn() {
            Ok(mut child) => {
                let deadline = Instant::now() + Duration::from_secs(2);
                loop {
                    match child.try_wait() {
                        Ok(Some(_)) => break,
                        Err(error) => {
                            tracing::warn!(pid,error=%error,"Owned process tree termination could not be observed");
                            break;
                        }
                        _ => {}
                    }
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        tracing::warn!(pid, "Owned process tree termination timed out");
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(1));
                }
            }
            Err(error) => {
                tracing::warn!(pid,error=%error,"Owned process tree termination could not start");
                if let Err(error) = state.child.start_kill() {
                    tracing::warn!(pid,error=%error,"Owned process handle termination failed");
                }
            }
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
            .map(|(&pid, process)| OwnedProcess {
                owner: Arc::downgrade(self),
                pid,
                generation: process.generation,
                group: process.group,
                child: process.child.clone(),
                active: AtomicBool::new(false),
            })
            .collect();
        for process in processes {
            process.wait().await?;
        }
        Ok(())
    }
    pub(crate) fn track(self: &Arc<Self>, child: Child, group: bool) -> OwnedProcess {
        let pid = child.id().unwrap_or(0);
        let child = Arc::new(Mutex::new(ChildState {
            child,
            waiters: Vec::new(),
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
