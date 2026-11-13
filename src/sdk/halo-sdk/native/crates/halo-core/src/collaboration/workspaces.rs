use crate::error::{Error, Result};
use crate::harness::TextId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{fs, io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberWorkspace {
    pub cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_common_directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_head: Option<String>,
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
fn within(root: &Path, path: &Path) -> bool {
    path.starts_with(root)
}
fn setup_error(checkout: &Path) -> Error {
    Error::new("WORKSPACE_SETUP", "")
        .with_harness(TextId::CollaborationWorkspaceSetupFailed, &[])
        .with_details(serde_json::json!({"checkout":path_text(checkout)}))
}

async fn git(cwd: &Path, args: &[&str], cancel: &CancellationToken) -> Result<String> {
    if cancel.is_cancelled() {
        return Err(Error::cancelled());
    }
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let processes = std::sync::Arc::new(crate::processes::OwnedProcesses::default());
    let owned = processes.track(child, false);
    let operation = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = stdout.take(1024 * 1024 + 1);
        let mut stderr = stderr.take(1024 * 1024 + 1);
        let (outcome, errors) =
            tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        outcome?;
        errors?;
        if out.len() > 1024 * 1024 || err.len() > 1024 * 1024 {
            return Err(Error::new(
                "PROCESS_OUTPUT_LIMIT",
                "stdout maxBuffer length exceeded",
            ));
        }
        let status = owned.wait().await?;
        if !status.success() {
            return Err(Error::new(
                "PROCESS_FAILED",
                format!(
                    "Command failed: git {}\n{}",
                    args.join(" "),
                    String::from_utf8_lossy(&err)
                ),
            ));
        }
        Ok(crate::js::trim_js(&String::from_utf8_lossy(&out)).to_owned())
    };
    tokio::select! {_=cancel.cancelled()=>Err(Error::cancelled()),result=tokio::time::timeout(Duration::from_secs(10),operation)=>result.map_err(|_|Error::new("PROCESS_TIMEOUT","git command timed out"))?}
}

pub async fn open_member_workspace(
    member: &Value,
    parent_cwd: &Path,
    additional_directories: &[PathBuf],
    metadata_directory: Option<&Path>,
    cancel: &CancellationToken,
) -> Result<MemberWorkspace> {
    if cancel.is_cancelled() {
        return Err(Error::cancelled());
    }
    let id = member["id"].as_str().unwrap_or("");
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(Error::new("WORKSPACE_ID", "")
            .with_harness(TextId::CollaborationWorkspaceInvalidIdentity, &[]));
    }
    let parent = fs::canonicalize(parent_cwd).await?;
    let mut roots = vec![parent.clone()];
    for path in additional_directories {
        roots.push(fs::canonicalize(parent.join(path)).await?);
    }
    let requested = member["cwd"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or(parent.clone());
    if !requested.is_absolute() {
        return Err(Error::new("WORKSPACE_PATH", "")
            .with_harness(TextId::CollaborationWorkspaceAbsolutePath, &[]));
    }
    let base = fs::canonicalize(requested).await?;
    if !roots.iter().any(|root| within(root, &base)) || !fs::metadata(&base).await?.is_dir() {
        return Err(Error::new("WORKSPACE_SCOPE", "")
            .with_harness(TextId::CollaborationWorkspaceOutsideAuthorized, &[]));
    }
    if member.get("cwd").is_some() && member.get("isolation").is_some() {
        return Err(Error::new("WORKSPACE_ARGUMENTS", "")
            .with_harness(TextId::CollaborationWorkspaceCwdAndIsolation, &[]));
    }
    let metadata = metadata_directory.map(|dir| dir.join(format!("{id}.json")));
    let previous: Option<MemberWorkspace> = if let Some(metadata) = &metadata {
        match fs::read(metadata).await {
            Ok(data) => Some(serde_json::from_slice(&data).map_err(|_| {
                Error::new("WORKSPACE_RECORD", "")
                    .with_harness(TextId::CollaborationWorkspaceInvalidRecord, &[])
            })?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        }
    } else {
        None
    };
    if member["isolation"] != "worktree" {
        if previous.as_ref().is_some_and(|v| v.cwd != path_text(&base)) {
            return Err(Error::new("WORKSPACE_CHANGED", "")
                .with_harness(TextId::CollaborationWorkspaceChanged, &[]));
        }
        return Ok(MemberWorkspace {
            cwd: path_text(&base),
            git_root: None,
            git_common_directory: None,
            checkout: None,
            initial_head: None,
        });
    }
    let git_root =
        fs::canonicalize(git(&base, &["rev-parse", "--show-toplevel"], cancel).await?).await?;
    let common =
        fs::canonicalize(base.join(git(&base, &["rev-parse", "--git-common-dir"], cancel).await?))
            .await?;
    let checkout = fs::canonicalize(std::env::temp_dir())
        .await?
        .join(format!("halo-collaboration-{id}"));
    let subdir = base.strip_prefix(&git_root).map_err(|_| {
        Error::new("WORKSPACE_SCOPE", "")
            .with_harness(TextId::CollaborationWorkspaceInvalidRepositoryRoot, &[])
    })?;
    if let Some(previous) = &previous {
        if previous.checkout.as_deref() != Some(path_text(&checkout).as_str())
            || previous.git_root.as_deref() != Some(path_text(&git_root).as_str())
            || previous
                .git_common_directory
                .as_ref()
                .is_some_and(|v| *v != path_text(&common))
            || !previous.initial_head.as_ref().is_some_and(|v| {
                (40..=64).contains(&v.len())
                    && v.bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            })
        {
            return Err(Error::new("WORKSPACE_RECORD", "")
                .with_harness(TextId::CollaborationWorkspaceRepositoryMismatch, &[]));
        }
    }
    let exists = match fs::metadata(&checkout).await {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if exists && previous.is_none() {
        return Err(Error::new("WORKSPACE_OWNERSHIP", "")
            .with_harness(TextId::CollaborationWorkspaceUnownedCheckout, &[]));
    }
    let initial_head = if let Some(head) = previous.as_ref().and_then(|v| v.initial_head.clone()) {
        head
    } else {
        git(&git_root, &["rev-parse", "--verify", "HEAD"], cancel).await?
    };
    if !exists {
        if let Err(error) = git(
            &git_root,
            &[
                "worktree",
                "add",
                "--detach",
                &path_text(&checkout),
                &initial_head,
            ],
            cancel,
        )
        .await
        {
            tracing::warn!("[Collaboration] Worktree creation failed; any partial checkout is retained: member={id}: {error}");
            return Err(setup_error(&checkout));
        }
    }
    let prepare = async {
        let root = fs::canonicalize(&checkout).await?;
        let registered_root =
            fs::canonicalize(git(&checkout, &["rev-parse", "--show-toplevel"], cancel).await?)
                .await?;
        let registered_common = fs::canonicalize(
            checkout.join(git(&checkout, &["rev-parse", "--git-common-dir"], cancel).await?),
        )
        .await?;
        if registered_root != root || registered_common != common {
            return Err(Error::new(
                "WORKSPACE_OWNERSHIP",
                "The checkout does not belong to the authorized repository",
            ));
        }
        let cwd = fs::canonicalize(checkout.join(subdir)).await?;
        if !within(&root, &cwd) || !fs::metadata(&cwd).await?.is_dir() {
            return Err(Error::new(
                "WORKSPACE_SCOPE",
                "The isolated working directory escapes or is absent from the checkout",
            ));
        }
        let workspace = MemberWorkspace {
            cwd: path_text(&cwd),
            git_root: Some(path_text(&git_root)),
            git_common_directory: Some(path_text(&common)),
            checkout: Some(path_text(&checkout)),
            initial_head: Some(initial_head),
        };
        if let Some(metadata) = metadata {
            fs::create_dir_all(metadata.parent().unwrap()).await?;
            let staging = PathBuf::from(format!("{}.tmp", path_text(&metadata)));
            let mut options = fs::OpenOptions::new();
            options.create(true).truncate(true).write(true);
            #[cfg(unix)]
            options.mode(0o600);
            use tokio::io::AsyncWriteExt;
            let mut file = options.open(&staging).await?;
            file.write_all(serde_json::to_string(&workspace)?.as_bytes())
                .await?;
            drop(file);
            fs::rename(staging, metadata).await?;
        }
        Ok(workspace)
    }
    .await;
    prepare.map_err(|error: Error| {
        tracing::warn!(
            "[Collaboration] Isolated workspace validation failed: member={id}: {error}"
        );
        setup_error(&checkout)
    })
}

pub async fn release_member_workspace(workspace: &MemberWorkspace) {
    let (Some(checkout), Some(root), Some(initial_head)) = (
        &workspace.checkout,
        &workspace.git_root,
        &workspace.initial_head,
    ) else {
        return;
    };
    let cancel = CancellationToken::new();
    let checkout_path = Path::new(checkout);
    let result=async{let (status,head,history)=tokio::try_join!(git(checkout_path,&["status","--porcelain=v1","--untracked-files=all","--ignored"],&cancel),git(checkout_path,&["rev-parse","--verify","HEAD"],&cancel),git(checkout_path,&["reflog","show","--format=%H","HEAD"],&cancel))?;
        if !status.is_empty()||head!=*initial_head||history.lines().any(|line|line!=initial_head){tracing::warn!("[Collaboration] Isolated checkout retained because it contains work or history changes");return Ok(());}
        git(Path::new(workspace.git_common_directory.as_ref().unwrap_or(root)),&["worktree","remove",checkout],&cancel).await?;Ok::<_,Error>(())}.await;
    if let Err(error) = result {
        tracing::warn!("[Collaboration] Isolated checkout retained because cleanup could not be verified: {error}");
    }
}

pub fn remap_denied_roots(roots: &[String], workspace: &MemberWorkspace) -> Vec<String> {
    let (Some(checkout), Some(root)) = (&workspace.checkout, &workspace.git_root) else {
        return roots.to_vec();
    };
    let mut mapped = roots.to_vec();
    for denied in roots {
        let candidate = if Path::new(root).starts_with(denied) {
            Some(checkout.clone())
        } else {
            Path::new(denied)
                .strip_prefix(root)
                .ok()
                .map(|suffix| path_text(&Path::new(checkout).join(suffix)))
        };
        if let Some(candidate) = candidate {
            if !mapped.contains(&candidate) {
                mapped.push(candidate);
            }
        }
    }
    mapped
}
