use crate::{
    error::{Error, Result},
    harness::TextId,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
};
use tokio_util::sync::CancellationToken;

const MAX_LINE_BYTES: usize = 32 * 1024 * 1024;
pub(super) struct Record {
    pub line: String,
    pub bytes: usize,
    pub value: Option<Value>,
    pub start: u64,
    pub end: u64,
    pub terminated: bool,
}
pub(super) enum Entry {
    Record(Record),
    Oversized,
}
pub(super) struct Reader {
    file: File,
    path: PathBuf,
    buffer: Vec<u8>,
    offset: usize,
    filled: usize,
    line: Vec<u8>,
    bytes: usize,
    position: u64,
    start: u64,
    skip_partial: bool,
    oversized: bool,
    skip_oversized: bool,
    ended: bool,
    cancellation: CancellationToken,
}
impl Reader {
    pub async fn open(
        path: &Path,
        start: u64,
        skip_oversized: bool,
        cancellation: &CancellationToken,
    ) -> Result<Self> {
        if cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        let mut file = File::open(path)
            .await
            .map_err(|error| io_error(error, "open", path))?;
        if start != 0 {
            file.seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(|error| io_error(error, "read", path))?;
        }
        Ok(Self {
            file,
            path: path.to_owned(),
            buffer: vec![0; 64 * 1024],
            offset: 0,
            filled: 0,
            line: Vec::new(),
            bytes: 0,
            position: start,
            start,
            skip_partial: start > 0,
            oversized: false,
            skip_oversized,
            ended: false,
            cancellation: cancellation.clone(),
        })
    }
    fn finish(&mut self, terminated: bool) -> Result<Option<Entry>> {
        let bytes = std::mem::take(&mut self.bytes);
        let oversized = std::mem::replace(&mut self.oversized, false);
        let skip = std::mem::replace(&mut self.skip_partial, false);
        let start = std::mem::replace(&mut self.start, self.position);
        let raw = std::mem::take(&mut self.line);
        if skip || bytes == 0 {
            return Ok(None);
        }
        if oversized {
            return if self.skip_oversized {
                Ok(Some(Entry::Oversized))
            } else {
                Err(line_limit())
            };
        }
        let line = String::from_utf8(raw)
            .unwrap_or_else(|error| String::from_utf8_lossy(&error.into_bytes()).into_owned());
        let value = match crate::js::json::parse(&line) {
            Ok(value) if value.is_object() => Some(value),
            Err(error) if error.code == "UNSUPPORTED_JSON_ENCODING" => return Err(error),
            _ => None,
        };
        Ok(Some(Entry::Record(Record {
            line,
            bytes,
            value,
            start,
            end: self.position,
            terminated,
        })))
    }
    pub async fn next(&mut self) -> Result<Option<Entry>> {
        loop {
            if self.cancellation.is_cancelled() {
                return Err(Error::cancelled());
            }
            if self.offset == self.filled {
                if self.ended {
                    return Ok(None);
                }
                self.filled = tokio::select! {
                    _ = self.cancellation.cancelled() => return Err(Error::cancelled()),
                    read = self.file.read(&mut self.buffer) => read.map_err(|error| io_error(error,"read",&self.path))?,
                };
                self.offset = 0;
                if self.filled == 0 {
                    self.ended = true;
                    return self.finish(false);
                }
            }
            let newline = self.buffer[self.offset..self.filled]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|offset| self.offset + offset);
            let end = newline.unwrap_or(self.filled);
            let count = end - self.offset;
            self.bytes = self.bytes.saturating_add(count);
            self.position += count as u64 + u64::from(newline.is_some());
            if self.bytes > MAX_LINE_BYTES {
                if !self.skip_partial && !self.skip_oversized {
                    return Err(line_limit());
                }
                self.oversized = true;
                self.line = Vec::new();
            } else if !self.oversized {
                self.line.extend_from_slice(&self.buffer[self.offset..end]);
            }
            self.offset = end + usize::from(newline.is_some());
            if newline.is_some() {
                if let Some(entry) = self.finish(true)? {
                    return Ok(Some(entry));
                }
            }
        }
    }
}
fn line_limit() -> Error {
    Error::template("HISTORY_LINE_LIMIT", TextId::HistoryJsonlLineLimit, &[])
        .with_details(json!({"name":"RangeError"}))
}
pub(super) fn io_error(error: std::io::Error, operation: &str, path: &Path) -> Error {
    let (code, reason) = match error.kind() {
        std::io::ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        std::io::ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        std::io::ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        std::io::ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        _ => {
            return Error::new("IO_ERROR", error.to_string())
                .with_details(json!({"path":path,"syscall":operation}))
        }
    };
    Error::new(code,format!("{code}: {reason}, {operation} '{}'",path.display())).with_details(json!({"code":code,"errno":error.raw_os_error().map(|value| -value.abs()),"path":path,"syscall":operation}))
}
