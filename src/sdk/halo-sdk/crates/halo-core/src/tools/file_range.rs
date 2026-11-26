//! Bounded line-range reading for text files larger than the whole-file
//! snapshot path. It locates a range by scanning forward, keeps one bounded
//! line buffer, and stops once the requested page is ready.

use super::file;
use crate::{
    core::tokens::estimate_tokens,
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    js::utf16_len,
};
use std::path::Path;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
};
use tokio_util::sync::CancellationToken;

const CHUNK_BYTES: usize = 32 * 1024;
const MAX_LINE_BYTES: usize = 256 * 1024;
const TOKEN_MARGIN: f64 = 1.2;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BudgetKind {
    Tokens,
    Characters,
}

pub struct RangeRequest<'a> {
    pub path: &'a Path,
    pub start: usize,
    pub limit: usize,
    pub token_limit: usize,
    pub character_limit: Option<usize>,
    pub cancellation: &'a CancellationToken,
    pub harness: &'a ResolvedHarness,
}

#[derive(Default)]
pub struct RangeOutcome {
    pub text: String,
    pub start: usize,
    pub end: usize,
    pub total: Option<usize>,
    pub more: bool,
    pub changed: bool,
    pub line_truncated: bool,
    pub cancelled: bool,
    pub beyond_end: bool,
    /// A delivered line had bytes that are not valid UTF-8.
    pub undecodable: bool,
    /// The file's final line, delivered whole, ends partway through a UTF-8 character.
    pub incomplete_end: bool,
}

pub fn read_token_limit(context_window: f64) -> usize {
    if context_window >= 100_000.0 {
        30_000
    } else {
        20_000
    }
}

pub fn read_token_limit_for(options: &serde_json::Value) -> usize {
    let window = options["contextWindow"]
        .as_f64()
        .filter(|value| value.is_finite() && *value > 0.0)
        .unwrap_or(200_000.0);
    read_token_limit(window)
}

pub fn budget_text(
    kind: BudgetKind,
    token_limit: usize,
    character_limit: Option<usize>,
    harness: &ResolvedHarness,
) -> String {
    match kind {
        BudgetKind::Tokens => harness.render(
            TextId::ToolsOutputBudgetTokens,
            &[("token_limit", &token_limit.to_string())],
        ),
        BudgetKind::Characters => harness.render(
            TextId::ToolsOutputBudgetConfigured,
            &[(
                "character_limit",
                &character_limit.unwrap_or(0).to_string(),
            )],
        ),
    }
}

struct Cursor {
    file: File,
    buffer: Vec<u8>,
    position: usize,
    eof: bool,
    line: usize,
    last_terminated: bool,
    done: bool,
    abandoned: bool,
    undecodable: bool,
    incomplete_end: bool,
}

/// Where a line's bytes stop.
#[derive(Clone, Copy, PartialEq)]
enum LineEnd {
    Newline,
    Bound,
    File,
}

impl Cursor {
    fn new(file: File) -> Self {
        Self {
            file,
            buffer: Vec::new(),
            position: 0,
            eof: false,
            line: 1,
            last_terminated: false,
            done: false,
            abandoned: false,
            undecodable: false,
            incomplete_end: false,
        }
    }

    /// Lossy UTF-8 for display. A character cut by the line bound is dropped:
    /// its remaining bytes were not read, so it says nothing about the file. A
    /// character left incomplete by the end of the file is dropped and reported,
    /// unless invalid bytes were already reported for the delivered lines.
    fn decode(&mut self, mut bytes: Vec<u8>, end: LineEnd) -> String {
        match std::str::from_utf8(&bytes) {
            Ok(_) => {}
            Err(error) if error.error_len().is_none() && end == LineEnd::Bound => {
                bytes.truncate(error.valid_up_to())
            }
            Err(error)
                if error.error_len().is_none() && end == LineEnd::File && !self.undecodable =>
            {
                bytes.truncate(error.valid_up_to());
                self.incomplete_end = true;
            }
            Err(_) => self.undecodable = true,
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }

    async fn fill(&mut self, cancellation: &CancellationToken) -> Result<bool> {
        if self.position < self.buffer.len() {
            return Ok(true);
        }
        if self.eof {
            return Ok(false);
        }
        if cancellation.is_cancelled() {
            return Err(Error::cancelled());
        }
        self.buffer.clear();
        self.position = 0;
        let mut chunk = vec![0u8; CHUNK_BYTES];
        let count = self
            .file
            .read(&mut chunk)
            .await
            .map_err(Error::from)?;
        if count == 0 {
            self.eof = true;
            return Ok(false);
        }
        chunk.truncate(count);
        self.buffer = chunk;
        Ok(true)
    }

    /// Returns the next source line, or `None` after EOF.
    async fn next(
        &mut self,
        store: bool,
        cancellation: &CancellationToken,
    ) -> Result<Option<(usize, String, bool)>> {
        if self.done {
            return Ok(None);
        }
        let number = self.line;
        let mut bytes = Vec::new();
        let mut bounded = false;
        loop {
            if !self.fill(cancellation).await? {
                self.done = true;
                if bytes.is_empty() {
                    if self.last_terminated {
                        self.line += 1;
                        return Ok(Some((number, String::new(), false)));
                    }
                    return Ok(None);
                }
                self.line += 1;
                return Ok(Some((number, self.decode(bytes, LineEnd::File), bounded)));
            }
            let byte = self.buffer[self.position];
            self.position += 1;
            if byte == b'\n' {
                self.last_terminated = true;
                self.line += 1;
                // CRLF reads as LF, as in whole-file reads.
                if bytes.last() == Some(&b'\r') {
                    bytes.pop();
                }
                return Ok(Some((number, self.decode(bytes, LineEnd::Newline), bounded)));
            }
            self.last_terminated = false;
            if store {
                if bytes.len() < MAX_LINE_BYTES {
                    bytes.push(byte);
                } else {
                    bounded = true;
                    self.done = true;
                    self.abandoned = true;
                    self.line += 1;
                    return Ok(Some((number, self.decode(bytes, LineEnd::Bound), true)));
                }
            }
        }
    }

    async fn has_more(&mut self, cancellation: &CancellationToken) -> Result<bool> {
        if self.done || self.abandoned {
            return Ok(false);
        }
        if self.position < self.buffer.len() {
            return Ok(true);
        }
        if self.eof {
            return Ok(self.last_terminated);
        }
        Ok(self.fill(cancellation).await?)
    }
}

pub fn line_overflow(
    token_limit: usize,
    character_limit: Option<usize>,
    estimated: f64,
    characters: usize,
    line: &str,
    number: usize,
) -> Option<BudgetKind> {
    let next_characters = utf16_len(line) + number.to_string().len() + 2;
    let character_overflow =
        character_limit.is_some_and(|limit| characters.saturating_add(next_characters) > limit);
    let next_tokens = estimated + estimate_tokens(line) + 2.0;
    let token_overflow = next_tokens * TOKEN_MARGIN > token_limit as f64;
    match (character_overflow, token_overflow) {
        (true, _) => Some(BudgetKind::Characters),
        (false, true) => Some(BudgetKind::Tokens),
        (false, false) => None,
    }
}

pub fn prefix_for_budget(
    token_limit: usize,
    character_limit: Option<usize>,
    kind: BudgetKind,
    estimated: f64,
    characters: usize,
    line: &str,
) -> String {
    match kind {
        BudgetKind::Characters => {
            let limit = character_limit.unwrap_or(0);
            let remaining = limit.saturating_sub(characters + 4 + 512);
            crate::js::utf16_prefix_without_split(line, remaining)
        }
        BudgetKind::Tokens => {
            let allowed = (token_limit as f64 / TOKEN_MARGIN - estimated - 2.0).max(0.0);
            let mut used = 0.0;
            let mut units = 0usize;
            for character in line.chars() {
                let units_here: usize = character.len_utf16();
                let cjk = matches!(character as u32,
                    0x3000..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff | 0xff00..=0xffef);
                let cost = if cjk { units_here as f64 * 0.6 } else { units_here as f64 * 0.3 };
                if used + cost > allowed {
                    break;
                }
                used += cost;
                units += units_here;
            }
            crate::js::utf16_prefix(line, units)
        }
    }
}

fn fits(
    request: &RangeRequest<'_>,
    estimated: f64,
    characters: usize,
    line: &str,
    number: usize,
) -> Option<BudgetKind> {
    line_overflow(
        request.token_limit,
        request.character_limit,
        estimated,
        characters,
        line,
        number,
    )
}

pub async fn read(request: &RangeRequest<'_>) -> Result<RangeOutcome> {
    let mut file = File::open(request.path).await.map_err(Error::from)?;
    let before = file.metadata().await.map_err(Error::from)?;
    if !before.is_file() {
        return Err(Error::new("FILE_READ", "").with_harness(
            TextId::ToolsFileNotRegular,
            &[("path", request.path.to_string_lossy().into_owned().into())],
        ));
    }
    let mut head = [0u8; 3];
    let mut filled = 0;
    while filled < head.len() {
        match file.read(&mut head[filled..]).await.map_err(Error::from)? {
            0 => break,
            count => filled += count,
        }
    }
    let encoding = file::text::sniff(&head[..filled]);
    if encoding.is_utf16() {
        return Err(Error::new("FILE_READ", "").with_harness(
            TextId::ToolsFileUtf16Range,
            &[
                ("encoding", encoding.label().into()),
                ("limit", file::MAX_BYTES.to_string().into()),
            ],
        ));
    }
    let body = if encoding == file::text::Encoding::Utf8Bom { 3 } else { 0 };
    file.seek(std::io::SeekFrom::Start(body))
        .await
        .map_err(Error::from)?;
    let mut cursor = Cursor::new(file);
    let mut lines: Vec<(usize, String, bool)> = Vec::new();
    let mut estimated = 0.0;
    let mut characters = 0usize;
    let mut more = false;
    let mut total = None;
    let mut truncated_line = None;
    let mut truncated_kind = None;
    let mut budget_stop = false;
    let mut cancelled = false;
    let mut beyond_end = true;

    loop {
        let next = match cursor
            .next(number_selected(request, cursor.line), request.cancellation)
            .await
        {
            Ok(next) => next,
            Err(error) if error.is_abort() => {
                cancelled = true;
                break;
            }
            Err(error) => return Err(error),
        };
        let Some((number, content, bounded)) = next else {
            break;
        };
        if number < request.start {
            continue;
        }
        if number >= request.start.saturating_add(request.limit) {
            more = true;
            beyond_end = false;
            break;
        }
        beyond_end = false;
        let overflow = if bounded {
            Some(bounded_budget(request, characters, &content, number))
        } else {
            fits(request, estimated, characters, &content, number)
        };
        match overflow {
            None => {
                estimated += estimate_tokens(&content) + 2.0;
                characters += utf16_len(&content) + number.to_string().len() + 2;
                lines.push((number, content, false));
                if lines.len() == request.limit {
                    more = match cursor.has_more(request.cancellation).await {
                        Ok(more) => more,
                        Err(error) if error.is_abort() => {
                            cancelled = true;
                            false
                        }
                        Err(error) => return Err(error),
                    };
                    if !more {
                        total = Some(if cursor.last_terminated {
                            number + 1
                        } else {
                            number
                        });
                    } else if cursor.eof
                        && cursor.last_terminated
                        && cursor.position >= cursor.buffer.len()
                    {
                        total = Some(cursor.line);
                    }
                    break;
                }
            }
            Some(kind) if lines.is_empty() || bounded => {
                let prefix = prefix_for_budget(request.token_limit, request.character_limit, kind, estimated, characters, &content);
                truncated_line = Some(number);
                truncated_kind = Some(kind);
                lines.push((number, prefix, true));
                more = if bounded {
                    false
                } else {
                    match cursor.has_more(request.cancellation).await {
                        Ok(more) => more,
                        Err(error) if error.is_abort() => {
                            cancelled = true;
                            false
                        }
                        Err(error) => return Err(error),
                    }
                };
                break;
            }
            Some(_) => {
                budget_stop = true;
                more = true;
                break;
            }
        }
    }
    if beyond_end && lines.is_empty() {
        total = Some(cursor.line.saturating_sub(1));
    }
    if total.is_none() && cursor.done && !cursor.abandoned {
        total = Some(cursor.line.saturating_sub(1));
    }
    let end = lines.last().map(|(number, _, _)| *number).unwrap_or(request.start);
    let width = end.to_string().len();
    let mut text = String::new();
    for (number, content, truncated) in &lines {
        text.push_str(&format!("{:>width$}\t{}\n", number, content));
        if *truncated {
            let kind = truncated_kind.unwrap_or(BudgetKind::Tokens);
            let rendered =
                budget_text(kind, request.token_limit, request.character_limit, request.harness);
            text.push_str(&request.harness.render(
                TextId::ToolsFileLineTruncated,
                &[("line", &number.to_string()), ("budget", &rendered)],
            ));
            if more {
                text.push_str(&request.harness.render(
                    TextId::ToolsFileLineTruncatedLater,
                    &[
                        ("offset", &(number + 1).to_string()),
                        ("line", &number.to_string()),
                    ],
                ));
            }
            text.push('\n');
        }
    }
    if truncated_line.is_none() && budget_stop && more {
        let kind = if request.character_limit.is_some() {
            BudgetKind::Characters
        } else {
            BudgetKind::Tokens
        };
        let rendered =
            budget_text(kind, request.token_limit, request.character_limit, request.harness);
        let suffix = total.map(|total| format!(" of {total}")).unwrap_or_default();
        text.push_str(&request.harness.render(
            TextId::ToolsFileReadBudget,
            &[
                ("budget", &rendered),
                ("start", &(lines.first().map(|(number, _, _)| *number).unwrap_or(request.start)).to_string()),
                ("end", &end.to_string()),
                ("total_suffix", &suffix),
                ("offset", &(end + 1).to_string()),
            ],
        ));
        text.push('\n');
    } else if truncated_line.is_none() && more {
        match total {
            Some(total) => {
                text.push_str(&request.harness.render(
                    TextId::ToolsFileMoreLines,
                    &[
                        ("start", &(lines.first().map(|(number, _, _)| *number).unwrap_or(request.start)).to_string()),
                        ("end", &end.to_string()),
                        ("total", &total.to_string()),
                        ("offset", &(end + 1).to_string()),
                    ],
                ));
            }
            None => {
                text.push_str(&request.harness.render(
                    TextId::ToolsFileMoreLinesUnknownTotal,
                    &[
                        ("start", &(lines.first().map(|(number, _, _)| *number).unwrap_or(request.start)).to_string()),
                        ("end", &end.to_string()),
                        ("offset", &(end + 1).to_string()),
                    ],
                ));
            }
        }
        text.push('\n');
    } else if truncated_line.is_none() && !lines.is_empty() && request.start > 1 {
        text.push_str(&request.harness.render(
            TextId::ToolsFileEndOfFileNotStart,
            &[
                ("start", &lines.first().unwrap().0.to_string()),
                ("end", &end.to_string()),
            ],
        ));
        text.push('\n');
    }
    let after = cursor.file.metadata().await.map_err(Error::from)?;
    let current = File::open(request.path)
        .await
        .map_err(Error::from)?
        .metadata()
        .await
        .map_err(Error::from)?;
    let changed = !file::same(&before, &after) || !file::same(&after, &current);
    if changed && !lines.is_empty() {
        text.push_str(&request.harness.render(
            TextId::ToolsFileChangedDuringRead,
            &[
                ("start", &lines.first().unwrap().0.to_string()),
                ("end", &end.to_string()),
            ],
        ));
        text.push('\n');
    }
    Ok(RangeOutcome {
        text,
        start: lines.first().map(|(number, _, _)| *number).unwrap_or(request.start),
        end,
        total,
        more,
        changed,
        line_truncated: truncated_line.is_some(),
        cancelled,
        beyond_end: beyond_end && lines.is_empty(),
        undecodable: cursor.undecodable,
        incomplete_end: cursor.incomplete_end && !more && truncated_line.is_none() && !cancelled,
    })
}

fn bounded_budget(
    request: &RangeRequest<'_>,
    characters: usize,
    content: &str,
    number: usize,
) -> BudgetKind {
    let next_characters = utf16_len(content) + number.to_string().len() + 2;
    if request
        .character_limit
        .is_some_and(|limit| characters.saturating_add(next_characters) > limit)
    {
        BudgetKind::Characters
    } else {
        BudgetKind::Tokens
    }
}

fn number_selected(request: &RangeRequest<'_>, line: usize) -> bool {
    line >= request.start && line < request.start.saturating_add(request.limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    async fn fixture(content: &str, name: &str) -> (PathBuf, std::path::PathBuf) {
        let root =
            std::env::temp_dir().join(format!("halo-range-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join(name);
        tokio::fs::write(&path, content).await.unwrap();
        (root, path)
    }

    #[tokio::test]
    async fn reads_large_files_by_line_range_without_a_full_snapshot() {
        let (root, path) = fixture("", "large.txt").await;
        let mut content = String::new();
        for index in 1..=5000 {
            content.push_str(&format!("line {index}\n"));
        }
        tokio::fs::write(&path, content).await.unwrap();
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        let request = RangeRequest {
            path: &path,
            start: 1,
            limit: 10,
            token_limit: 30_000,
            character_limit: None,
            cancellation: &cancellation,
            harness: &harness,
        };
        let outcome = read(&request).await.unwrap();
        assert_eq!(outcome.start, 1);
        assert_eq!(outcome.end, 10);
        assert_eq!(outcome.total, None);
        assert!(outcome.text.contains("More content remains"));
        assert!(outcome.text.contains("1\tline 1\n"));
        assert!(outcome.text.contains("10\tline 10\n"));
        assert!(!outcome.text.contains("line 11\n"));
        assert!(outcome
            .text
            .contains("More content remains; the total line count was not scanned"));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn preserves_trailing_empty_lines_and_reports_the_file_end() {
        let (root, path) = fixture("one\ntwo\n", "trailing.txt").await;
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        let request = RangeRequest {
            path: &path,
            start: 2,
            limit: 10,
            token_limit: 30_000,
            character_limit: None,
            cancellation: &cancellation,
            harness: &harness,
        };
        let outcome = read(&request).await.unwrap();
        assert_eq!(outcome.start, 2);
        assert_eq!(outcome.end, 3);
        assert_eq!(outcome.total, Some(3));
        assert!(outcome.text.contains("end of file"));
        assert!(outcome.text.contains("2\ttwo\n3\t\n"));
        assert!(outcome.text.contains("end of file"));
        assert!(outcome.text.contains("Earlier lines are outside this view."));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn stops_at_the_token_budget_and_marks_a_single_oversized_line() {
        let (root, path) = fixture("", "long-line.txt").await;
        let content = format!("START{}END", "x".repeat(200_000));
        tokio::fs::write(&path, &content).await.unwrap();
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        let request = RangeRequest {
            path: &path,
            start: 1,
            limit: 2000,
            token_limit: 20_000,
            character_limit: None,
            cancellation: &cancellation,
            harness: &harness,
        };
        let outcome = read(&request).await.unwrap();
        let text = &outcome.text;
        assert!(text.starts_with("1\tSTART"));
        assert!(text.contains("alone exceeds the 20000 estimated-token output limit"));
        assert!(text.contains("only its beginning is shown"));
        assert!(text.len() < content.len());
        assert!(outcome.text.contains("only its beginning is shown"));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn reads_crlf_as_lf_and_emoji_prefixes_without_replacement_characters() {
        let (root, path) = fixture("", "crlf.txt").await;
        tokio::fs::write(&path, "alpha\r\nbeta\r\n").await.unwrap();
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        let request = RangeRequest {
            path: &path,
            start: 1,
            limit: 2,
            token_limit: 30_000,
            character_limit: None,
            cancellation: &cancellation,
            harness: &harness,
        };
        let outcome = read(&request).await.unwrap();
        assert!(outcome.text.starts_with("1\talpha\n2\tbeta\n"));
        assert!(!outcome.text.contains('\r'));
        assert_eq!(outcome.total, Some(3));

        let (emoji_root, emoji_path) = fixture("", "emoji.txt").await;
        tokio::fs::write(&emoji_path, "😀".repeat(60_000)).await.unwrap();
        let request = RangeRequest {
            path: &emoji_path,
            start: 1,
            limit: 1,
            token_limit: 30_000,
            character_limit: Some(1_000),
            cancellation: &cancellation,
            harness: &harness,
        };
        let outcome = read(&request).await.unwrap();
        assert!(!outcome.text.contains('\u{fffd}'));
        assert!(!outcome.undecodable);
        assert!(outcome.text.contains("alone exceeds the"));
        tokio::fs::remove_dir_all(root).await.unwrap();
        tokio::fs::remove_dir_all(emoji_root).await.unwrap();
    }

    #[tokio::test]
    async fn range_reads_strip_the_bom_flag_undecodable_bytes_and_refuse_utf16() {
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        let request = |path| RangeRequest {
            path,
            start: 1,
            limit: 10,
            token_limit: 30_000,
            character_limit: None,
            cancellation: &cancellation,
            harness: &harness,
        };
        let (root, path) = fixture("", "bom.txt").await;
        tokio::fs::write(&path, b"\xEF\xBB\xBFfirst\r\nsecond\n").await.unwrap();
        let outcome = read(&request(&path)).await.unwrap();
        assert!(outcome.text.starts_with("1\tfirst\n2\tsecond\n"));
        assert!(!outcome.undecodable);

        tokio::fs::write(&path, b"// \xd6\xd0\xce\xc4\nint x;\n").await.unwrap();
        let outcome = read(&request(&path)).await.unwrap();
        assert!(outcome.undecodable);
        assert!(outcome.text.contains("2\tint x;\n"));

        tokio::fs::write(&path, [0xFF, 0xFE, b'a', 0, b'\n', 0]).await.unwrap();
        let error = read(&request(&path)).await.err().unwrap();
        let rendered = error.render_for(&harness);
        assert!(rendered.contains("UTF-16LE"), "{rendered}");
        assert!(rendered.contains("Convert a copy to UTF-8"), "{rendered}");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn only_the_end_of_the_file_can_end_with_an_incomplete_character() {
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        let read_lines = |path: &'static Path, limit| {
            let harness = &harness;
            let cancellation = &cancellation;
            async move {
                read(&RangeRequest { path, start: 1, limit, token_limit: 30_000, character_limit: None, cancellation, harness })
                    .await
                    .unwrap()
            }
        };
        let half = &"中".as_bytes()[..2];
        let (root, path) = fixture("", "end.txt").await;
        let path: &'static Path = Box::leak(path.into_boxed_path());
        tokio::fs::write(path, [b"x\ny ", half].concat()).await.unwrap();
        let outcome = read_lines(path, 10).await;
        assert!(outcome.text.starts_with("1\tx\n2\ty \n"), "{}", outcome.text);
        assert!(outcome.incomplete_end && !outcome.undecodable);
        assert!(!outcome.text.contains('\u{fffd}'));
        let outcome = read_lines(path, 1).await;
        assert!(!outcome.incomplete_end && !outcome.undecodable);
        tokio::fs::write(path, [&b"a".repeat(35), b"\ny ".as_slice(), half].concat()).await.unwrap();
        let outcome = read(&RangeRequest { path, start: 1, limit: 10, token_limit: 30_000, character_limit: Some(40), cancellation: &cancellation, harness: &harness })
            .await
            .unwrap();
        assert!(outcome.more && outcome.end == 1 && !outcome.incomplete_end, "{}", outcome.text);

        for middle in [[b"a ", half, b"\nb"].concat(), [b"a ", half, b"\r\nb"].concat()] {
            tokio::fs::write(path, middle).await.unwrap();
            let outcome = read_lines(path, 10).await;
            assert!(outcome.undecodable && !outcome.incomplete_end);
        }
        tokio::fs::write(path, [b"caf\xe9\ny ", half].concat()).await.unwrap();
        let outcome = read_lines(path, 10).await;
        assert!(outcome.undecodable && !outcome.incomplete_end);
        assert!(outcome.text.contains("2\ty \u{fffd}"), "{}", outcome.text);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn an_oversized_single_line_stops_at_the_bounded_buffer() {
        let (root, path) = fixture("", "sparse.txt").await;
        std::fs::File::create(&path)
            .unwrap()
            .set_len(8 * 1024 * 1024 + 1)
            .unwrap();
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        let request = RangeRequest {
            path: &path,
            start: 1,
            limit: 1,
            token_limit: 30_000,
            character_limit: None,
            cancellation: &cancellation,
            harness: &harness,
        };
        let outcome = read(&request).await.unwrap();
        assert!(outcome.text.starts_with("1\t"));
        assert!(outcome.text.contains("alone exceeds the"));
        assert!(outcome.total.is_none());
        assert!(!outcome.text.contains("More content remains"));
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_delivery_returns_no_range() {
        let (root, path) = fixture("", "cancel.txt").await;
        let mut content = String::new();
        for index in 1..=5000 {
            content.push_str(&format!("line {index}\n"));
        }
        tokio::fs::write(&path, content).await.unwrap();
        let harness = crate::harness::baseline();
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        let request = RangeRequest {
            path: &path,
            start: 1,
            limit: 10,
            token_limit: 30_000,
            character_limit: None,
            cancellation: &cancellation,
            harness: &harness,
        };
        let outcome = read(&request).await.unwrap();
        assert!(outcome.cancelled);
        assert!(outcome.text.is_empty());
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[test]
    fn context_near_the_threshold_selects_the_larger_read_budget() {
        assert_eq!(read_token_limit(99_999.0), 20_000);
        assert_eq!(read_token_limit(100_000.0), 30_000);
        assert_eq!(
            read_token_limit_for(&json!({"contextWindow": 99_999})),
            20_000
        );
        assert_eq!(
            read_token_limit_for(&json!({"contextWindow": 100_000})),
            30_000
        );
        assert_eq!(read_token_limit_for(&json!({})), 30_000);
    }
}
