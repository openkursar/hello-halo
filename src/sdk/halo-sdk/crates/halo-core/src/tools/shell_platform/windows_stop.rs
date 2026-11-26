//! A request-local Toolhelp snapshot and optional MSYS table establish shell ancestry.
//! Each edge has its own sampling fence; owned handles bind identity, termination, and exit.
//! Bounded native rescans follow observed parent exits. Missing ancestry, late arrivals,
//! or an exhausted budget leave shutdown unconfirmed.

use super::{
    capture_process_table,
    windows_ancestry::{
        confirmation_after_stop, has_trusted_msys_root, walk, Edge, Lifetime, MsysTable, Pid, Proof,
    },
    windows_ps_executable,
};
use crate::processes::OwnedProcess;
use std::{
    collections::HashMap,
    io,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::Path,
    time::Duration,
};
use tokio::time::Instant;
use windows_sys::Win32::{
    Foundation::{
        ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
        WAIT_OBJECT_0, WAIT_TIMEOUT,
    },
    System::{
        Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        SystemInformation::GetSystemTimePreciseAsFileTime,
        Threading::{
            GetProcessId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
            TerminateProcess, WaitForSingleObject, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        },
    },
};

pub(in crate::tools) const WINDOWS_STOP_BUDGET: Duration = Duration::from_secs(4);
const MSYS_PS_BUDGET: Duration = Duration::from_secs(2);
const MAX_SCANS: usize = 4;

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

fn now_filetime() -> u64 {
    let mut time = FILETIME::default();
    unsafe { GetSystemTimePreciseAsFileTime(&mut time) };
    ticks(time)
}

struct Member(OwnedHandle);

impl Member {
    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle()
    }

    fn open(pid: Pid) -> io::Result<Option<Self>> {
        let raw = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                pid,
            )
        };
        if raw.is_null() {
            let error = io::Error::last_os_error();
            return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        Ok(Some(Self(unsafe { OwnedHandle::from_raw_handle(raw) })))
    }

    fn stopped(&self) -> io::Result<bool> {
        match unsafe { WaitForSingleObject(self.raw(), 0) } {
            WAIT_OBJECT_0 => Ok(true),
            WAIT_TIMEOUT => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }

    fn lifetime(&self) -> io::Result<Lifetime> {
        let stopped = self.stopped()?;
        let (mut created, mut exited, mut kernel, mut user) = (
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
            FILETIME::default(),
        );
        if unsafe {
            GetProcessTimes(
                self.raw(),
                &mut created,
                &mut exited,
                &mut kernel,
                &mut user,
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        let created = ticks(created);
        let exit = ticks(exited);
        if created == 0 || (stopped && exit <= created) {
            return Err(io::Error::other("invalid process lifetime"));
        }
        Ok(Lifetime {
            created,
            exited: stopped.then_some(exit),
        })
    }

    fn image(&self) -> Option<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;

        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        if unsafe {
            QueryFullProcessImageNameW(
                self.raw(),
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut size,
            )
        } == 0
        {
            return None;
        }
        Some(std::ffi::OsString::from_wide(&buffer[..size as usize]).into())
    }

    fn stop(&self) -> io::Result<bool> {
        if self.stopped()? {
            return Ok(false);
        }
        if unsafe { TerminateProcess(self.raw(), 1) } != 0 {
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if self.stopped()? {
            Ok(false)
        } else {
            Err(error)
        }
    }
}

struct Snapshot {
    edges: Vec<Edge>,
    before: u64,
}

fn snapshot(deadline: Instant) -> io::Result<Snapshot> {
    let before = now_filetime();
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut row = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    if unsafe { Process32FirstW(handle.as_raw_handle(), &mut row) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut edges = Vec::new();
    loop {
        if Instant::now() >= deadline {
            return Err(io::ErrorKind::TimedOut.into());
        }
        edges.push(Edge {
            parent: row.th32ParentProcessID,
            child: row.th32ProcessID,
            before,
            native: true,
        });
        if unsafe { Process32NextW(handle.as_raw_handle(), &mut row) } == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NO_MORE_FILES as i32) {
                return Err(error);
            }
            break;
        }
    }
    if now_filetime() < before {
        return Err(io::Error::other(
            "system clock moved during process enumeration",
        ));
    }
    Ok(Snapshot { edges, before })
}

fn discover(
    members: &mut HashMap<Pid, (Member, Lifetime)>,
    native: &Snapshot,
    msys: Option<&MsysTable>,
    deadline: Instant,
) -> bool {
    if members
        .values_mut()
        .any(|(member, lifetime)| match member.lifetime() {
            Ok(current) => {
                *lifetime = current;
                false
            }
            Err(_) => true,
        })
    {
        return false;
    }
    walk(
        members,
        native
            .edges
            .iter()
            .copied()
            .chain(msys.into_iter().flat_map(MsysTable::edges)),
        std::process::id(),
        |pid| {
            if Instant::now() >= deadline {
                return None;
            }
            let process = Member::open(pid).ok()??;
            let lifetime = process.lifetime().ok()?;
            Some((process, lifetime))
        },
    )
}

fn stop_and_wait(
    root: Pid,
    members: &HashMap<Pid, (Member, Lifetime)>,
    deadline: Instant,
) -> Option<bool> {
    let mut stopped_by_request = members[&root].0.stop().is_ok_and(|requested| requested);
    for (&pid, (process, _)) in members {
        if pid == root {
            continue;
        }
        if Instant::now() >= deadline {
            return None;
        }
        stopped_by_request &= process.stop().is_ok_and(|requested| requested);
    }
    while Instant::now() < deadline {
        if members
            .values()
            .all(|(process, _)| process.stopped().is_ok_and(|done| done))
        {
            return Some(stopped_by_request);
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    None
}

fn msys_root_is_known(
    table: &MsysTable,
    root: Pid,
    members: &HashMap<Pid, (Member, Lifetime)>,
    native: &Snapshot,
    launcher_target: Option<&Path>,
) -> bool {
    has_trusted_msys_root(table.knows_root(root, members[&root].1.created), || {
        launcher_target.into_iter().flat_map(|expected_image| {
            native.edges.iter().filter_map(|edge| {
                if edge.parent != root {
                    return None;
                }
                let (child, lifetime) = members.get(&edge.child)?;
                (matches!(edge.prove(members[&root].1, *lifetime), Proof::Child)
                    && table.knows_root(edge.child, lifetime.created)
                    && child.image().is_some_and(|image| {
                        image
                            .to_string_lossy()
                            .eq_ignore_ascii_case(&expected_image.to_string_lossy())
                    }))
                .then_some(())
            })
        })
    })
}

fn stop_tree(
    root: Member,
    msys: Option<MsysTable>,
    launcher_target: Option<&Path>,
    mut complete: bool,
    deadline: Instant,
) -> bool {
    let pid = unsafe { GetProcessId(root.raw()) };
    let Ok(lifetime) = root.lifetime() else {
        let _ = root.stop();
        return false;
    };
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    complete &= lifetime.exited.is_none();
    let mut members = HashMap::from([(pid, (root, lifetime))]);
    for round in 0..MAX_SCANS {
        let Ok(native) = snapshot(deadline) else {
            if round == 0 {
                let _ = members[&pid].0.stop();
            }
            return false;
        };
        let previous = members.len();
        let table = if round == 0 { msys.as_ref() } else { None };
        complete &= discover(&mut members, &native, table, deadline);
        if round != 0 {
            // Only a table taken after the previously held parents exited can close the walk.
            complete &= members
                .values()
                .filter_map(|(_, lifetime)| lifetime.exited)
                .all(|exit| exit < native.before);
        }
        if let Some(table) = table {
            complete &= msys_root_is_known(table, pid, &members, &native, launcher_target);
        }
        if round != 0 && previous == members.len() {
            return complete;
        }
        if round != 0 {
            // An untracked parent could already have spawned and lost an intermediate process.
            complete = false;
        }
        let Some(confirmation) =
            confirmation_after_stop(complete, round == 0, stop_and_wait(pid, &members, deadline))
        else {
            return false;
        };
        complete = confirmation;
    }
    false
}

pub(in crate::tools) async fn terminate_windows_shell(
    process: &OwnedProcess,
    shell: &Path,
    deadline: Instant,
) -> bool {
    let root = match process.windows_stop_handle() {
        Ok(handle) => Member(handle),
        Err(error) => {
            tracing::warn!(kind=?error.kind(), "Owned shell handle could not be retained for cleanup");
            return false;
        }
    };
    let pid = unsafe { GetProcessId(root.raw()) };
    let msys = if let Some(ps) = windows_ps_executable(shell) {
        let before = now_filetime();
        let budget = MSYS_PS_BUDGET.min(deadline.saturating_duration_since(Instant::now()));
        let observed = capture_process_table(&ps, budget)
            .await
            .ok()
            .and_then(|output| MsysTable::parse(std::str::from_utf8(&output).ok()?, before));
        observed
    } else {
        None
    };
    let launcher_target = root.image().and_then(|image| {
        let bin = image.parent()?;
        if !bin.file_name()?.to_str()?.eq_ignore_ascii_case("bin")
            || bin
                .parent()?
                .file_name()?
                .to_str()?
                .eq_ignore_ascii_case("usr")
        {
            return None;
        }
        Some(
            bin.parent()?
                .join("usr")
                .join("bin")
                .join(image.file_name()?),
        )
    });
    let msys_observed = msys.is_some();
    let stop = tokio::task::spawn_blocking(move || {
        stop_tree(
            root,
            msys,
            launcher_target.as_deref(),
            msys_observed,
            deadline,
        )
    });
    match tokio::time::timeout_at(deadline, stop).await {
        Ok(Ok(true)) => return true,
        Ok(Ok(false)) => {}
        _ => process.stop_windows_root(),
    }
    tracing::warn!(
        pid,
        msys_observed,
        "Shell process tree shutdown was not confirmed"
    );
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processes::OwnedProcesses;
    use std::process::Stdio;

    const HELPER: &str = "tools::shell_platform::windows_stop::tests::controlled_shell_process";
    const CONTROL: &str = "HALO_TEST_SHELL_STOP_FIXTURE";
    const CHILD_PID: &str = "HALO_TEST_SHELL_STOP_CHILD_PID";

    #[test]
    fn controlled_shell_process() {
        match std::env::var(CONTROL).as_deref() {
            Ok("root") => {
                let binary = std::env::current_exe().unwrap();
                let mut child = std::process::Command::new(binary)
                    .args(["--exact", HELPER])
                    .env(CONTROL, "leaf")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .unwrap();
                let path = std::env::var_os(CHILD_PID).unwrap();
                std::fs::write(path, child.id().to_string()).unwrap();
                let _ = child.wait();
            }
            Ok("leaf") => std::thread::sleep(Duration::from_secs(20)),
            _ => {}
        }
    }

    struct Cleanup(Member);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.stop();
        }
    }

    #[tokio::test]
    async fn windows_stop_does_not_confirm_a_root_that_exited_before_termination() {
        let child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", HELPER])
            .env_remove(CONTROL)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let owner = std::sync::Arc::new(OwnedProcesses::default());
        let root = owner.track(child, false);
        let handle = Member(root.windows_stop_handle().unwrap());
        assert!(root.wait().await.unwrap().success());
        assert!(!handle.stop().unwrap());
        assert!(!stop_tree(
            handle,
            None,
            None,
            true,
            Instant::now() + WINDOWS_STOP_BUDGET
        ));
    }

    #[tokio::test]
    async fn windows_stop_waits_for_owned_root_and_native_child_but_not_the_neighbour() {
        check_native_tree(true).await;
    }

    #[tokio::test]
    async fn windows_stop_cleans_known_members_without_confirming_an_unobserved_msys_tree() {
        check_native_tree(false).await;
    }

    async fn check_native_tree(native_only: bool) {
        let directory =
            std::env::temp_dir().join(format!("halo-shell-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let ready = directory.join("child.pid");
        let binary = std::env::current_exe().unwrap();
        let spawn = |mode| {
            tokio::process::Command::new(&binary)
                .args(["--exact", HELPER])
                .env(CONTROL, mode)
                .env(CHILD_PID, &ready)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        };
        let owner = std::sync::Arc::new(OwnedProcesses::default());
        let root = owner.track(spawn("root"), false);
        let neighbour = owner.track(spawn("leaf"), false);
        let root_handle = Cleanup(Member(root.windows_stop_handle().unwrap()));
        let neighbour_handle = Cleanup(Member(neighbour.windows_stop_handle().unwrap()));
        let child_pid = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(bytes) = tokio::fs::read_to_string(&ready).await {
                    if let Ok(pid) = bytes.parse::<Pid>() {
                        break pid;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let child = Member::open(child_pid).unwrap().unwrap();
        let parent = unsafe { GetProcessId(root_handle.0.raw()) };
        let table = snapshot(Instant::now() + Duration::from_secs(1)).unwrap();
        let parent_time = root_handle.0.lifetime().unwrap();
        let child_time = child.lifetime().unwrap();
        assert!(table.edges.iter().any(|edge| edge.parent == parent
            && edge.child == child_pid
            && matches!(edge.prove(parent_time, child_time), Proof::Child)));
        let child = Cleanup(child);
        let deadline = Instant::now() + WINDOWS_STOP_BUDGET;
        let confirmed = if native_only {
            let handle = Member(root.windows_stop_handle().unwrap());
            tokio::task::spawn_blocking(move || stop_tree(handle, None, None, true, deadline))
                .await
                .unwrap()
        } else {
            terminate_windows_shell(&root, &binary, deadline).await
        };
        assert_eq!(confirmed, native_only);
        assert!(root_handle.0.stopped().unwrap());
        assert!(child.0.stopped().unwrap());
        assert!(!neighbour_handle.0.stopped().unwrap());
        root.wait().await.unwrap();
        neighbour_handle.0.stop().unwrap();
        neighbour.wait().await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
}
