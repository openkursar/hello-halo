use regex_syntax::ast::{self, Ast, ClassSetItem, Flag};
use std::{
    borrow::Cow,
    collections::VecDeque,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, LazyLock, Mutex},
    time::{Duration, SystemTime},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::OnceCell,
};

#[derive(Default)]
struct EndLines(Vec<usize>);

impl ast::Visitor for EndLines {
    type Output = Vec<usize>;
    type Err = ();

    fn finish(self) -> Result<Vec<usize>, ()> {
        Ok(self.0)
    }

    fn visit_pre(&mut self, node: &Ast) -> Result<(), ()> {
        match node {
            Ast::Literal(literal) if literal.c == '\r' => return Err(()),
            Ast::Flags(set) if set.flags.flag_state(Flag::CRLF).is_some() => return Err(()),
            Ast::Group(group)
                if group
                    .flags()
                    .is_some_and(|flags| flags.flag_state(Flag::CRLF).is_some()) =>
            {
                return Err(())
            }
            Ast::Assertion(anchor) if anchor.kind == ast::AssertionKind::EndLine => {
                self.0.push(anchor.span.start.offset)
            }
            _ => {}
        }
        Ok(())
    }

    fn visit_class_set_item_pre(&mut self, item: &ClassSetItem) -> Result<(), ()> {
        match item {
            ClassSetItem::Literal(literal) if literal.c == '\r' => Err(()),
            ClassSetItem::Range(range) if range.start.c <= '\r' && '\r' <= range.end.c => Err(()),
            _ => Ok(()),
        }
    }
}

fn rewrite(pattern: &str) -> Option<String> {
    if !pattern.as_bytes().contains(&b'$') {
        return None;
    }
    let ast = ast::parse::Parser::new().parse(pattern).ok()?;
    let ends = ast::visit(&ast, EndLines::default()).ok()?;
    if ends.is_empty() {
        return None;
    }
    // The AST carries source spans; translation also checks Unicode properties and class semantics.
    regex_syntax::hir::translate::TranslatorBuilder::new()
        .utf8(false)
        .build()
        .translate(pattern, &ast)
        .ok()?;
    let mut result = String::with_capacity(pattern.len() + 6 * ends.len());
    let mut start = 0;
    for offset in ends {
        result.push_str(&pattern[start..offset]);
        result.push_str("(?R:$)");
        start = offset + 1;
    }
    result.push_str(&pattern[start..]);
    Some(result)
}

#[derive(Clone, PartialEq, Eq)]
struct Executable {
    path: PathBuf,
    length: u64,
    modified: SystemTime,
    object: (u64, u64),
}

impl Executable {
    fn identify(path: PathBuf) -> Option<Self> {
        use std::io::Read;
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        {
            return None;
        }
        let mut file = options.open(&path).ok()?;
        let metadata = file.metadata().ok()?;
        if !metadata.is_file() {
            return None;
        }
        let mut header = [0; 4];
        file.read_exact(&mut header).ok()?;
        // A script can dispatch to different rg versions according to the caller's environment.
        #[cfg(unix)]
        let object = {
            use std::os::unix::fs::MetadataExt;
            if header != *b"\x7fELF"
                && !matches!(
                    u32::from_be_bytes(header),
                    0xfeedface
                        | 0xfeedfacf
                        | 0xcefaedfe
                        | 0xcffaedfe
                        | 0xcafebabe
                        | 0xcafebabf
                        | 0xbebafeca
                        | 0xbfbafeca
                )
            {
                return None;
            }
            (metadata.dev(), metadata.ino())
        };
        #[cfg(windows)]
        let object = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
            if !header.starts_with(b"MZ") {
                return None;
            }
            let mut info = std::mem::MaybeUninit::uninit();
            let info = unsafe {
                if GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) == 0 {
                    return None;
                }
                info.assume_init()
            };
            let index = ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64;
            (info.dwVolumeSerialNumber as u64, index)
        };
        Some(Self {
            path,
            length: metadata.len(),
            modified: metadata.modified().ok()?,
            object,
        })
    }
}

fn identify(program: &Path, path: Option<&str>, directory: Option<&Path>) -> Option<Executable> {
    if program.is_absolute() {
        return Executable::identify(program.to_owned());
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        let cwd = match directory {
            Some(dir) if dir.is_absolute() => dir.to_owned(),
            dir => std::env::current_dir()
                .ok()?
                .join(dir.unwrap_or(Path::new(""))),
        };
        for entry in std::env::split_paths(path?) {
            let candidate = cwd.join(entry).join(program);
            let name = std::ffi::CString::new(candidate.as_os_str().as_bytes()).ok()?;
            if candidate.is_file() && unsafe { libc::access(name.as_ptr(), libc::X_OK) } == 0 {
                return Executable::identify(candidate);
            }
        }
    }
    #[cfg(windows)]
    let _ = (path, directory); // Windows callers already resolved the session PATH to an absolute program.
    None
}

const CAPACITY: usize = 32;
type Cell = Arc<OnceCell<bool>>;
static CAPABILITIES: LazyLock<Mutex<VecDeque<(Executable, Cell)>>> = LazyLock::new(Mutex::default);

fn cell(executable: &Executable) -> Option<Cell> {
    let mut entries = CAPABILITIES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(index) = entries.iter().position(|(key, _)| key == executable) {
        let entry = entries.remove(index).unwrap();
        let cell = entry.1.clone();
        entries.push_back(entry);
        return Some(cell);
    }
    if entries.len() >= CAPACITY {
        let idle = entries
            .iter()
            .position(|(_, cell)| Arc::strong_count(cell) == 1)?;
        entries.remove(idle);
    }
    let cell = Arc::new(OnceCell::new());
    entries.push_back((executable.clone(), cell.clone()));
    Some(cell)
}

async fn capability<F>(cell: &Cell, timeout: Duration, check: impl FnOnce() -> F) -> bool
where
    F: std::future::Future<Output = Result<bool, ()>>,
{
    match tokio::time::timeout(timeout, cell.get_or_try_init(check)).await {
        Ok(Ok(value)) => *value,
        _ => {
            tracing::warn!("Could not determine ripgrep line-anchor support");
            false
        }
    }
}

#[cfg(test)]
mod tests;

async fn probe(program: &Path) -> Result<bool, ()> {
    let mut cmd = Command::new(program);
    cmd.args([
        "--no-config",
        "--color=never",
        "--only-matching",
        "--",
        "x(?R:$)",
        "-",
    ])
    .env_clear()
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
        if let Some(root) = std::env::var_os("SystemRoot") {
            cmd.env("SystemRoot", root);
        }
    }
    if let Some(parent) = program.parent() {
        cmd.current_dir(parent);
    }
    let mut child = cmd.spawn().map_err(|_| ())?;
    let mut stdin = child.stdin.take().ok_or(())?;
    let stdout = child.stdout.take().ok_or(())?;
    let stderr = child.stderr.take().ok_or(())?;
    let mut found = Vec::new();
    let mut diagnostic = Vec::new();
    let (sent, output, errors, status) = tokio::join!(
        async move { stdin.write_all(b"x\r\n").await },
        async { stdout.take(8).read_to_end(&mut found).await },
        async { stderr.take(1024).read_to_end(&mut diagnostic).await },
        child.wait(),
    );
    output.map_err(|_| ())?;
    errors.map_err(|_| ())?;
    let diagnostic = String::from_utf8_lossy(&diagnostic);
    match status.map_err(|_| ())?.code() {
        Some(0) if sent.is_ok() && matches!(&*found, b"x\n" | b"x\r\n") => Ok(true),
        Some(2)
            if diagnostic.contains("x(?R:$)")
                && diagnostic
                    .lines()
                    .any(|line| line == "error: unrecognized flag") =>
        {
            Ok(false)
        }
        _ => Err(()),
    }
}

pub(super) async fn prepare<'a>(
    pattern: &'a str,
    program: &'a Path,
    path: Option<&str>,
    directory: Option<&Path>,
) -> (Cow<'a, Path>, Cow<'a, str>) {
    let original = (Cow::Borrowed(program), Cow::Borrowed(pattern));
    let Some(updated) = rewrite(pattern) else {
        return original;
    };
    let name = program.to_owned();
    let path = if name.is_absolute() {
        None
    } else {
        path.map(str::to_owned)
    };
    let directory = directory.map(Path::to_owned);
    let lookup =
        tokio::task::spawn_blocking(move || identify(&name, path.as_deref(), directory.as_deref()));
    let Ok(Ok(Some(identity))) = tokio::time::timeout(Duration::from_secs(2), lookup).await else {
        return original;
    };
    let Some(cell) = cell(&identity) else {
        return original;
    };
    let supported = capability(&cell, Duration::from_secs(2), || probe(&identity.path)).await;
    (
        identity.path.into(),
        if supported {
            updated.into()
        } else {
            pattern.into()
        },
    )
}
