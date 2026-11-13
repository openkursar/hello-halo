use crate::error::{Error, Result};
use crate::harness::{baseline, ResolvedHarness, TextId};
use serde_json::{json, Value};

const SECTIONS: [&str; 4] = ["members", "tasks", "findings", "activities"];
const PREFIX: &str = "collaboration-board:";
const PAGE_BYTES: usize = 24 * 1024;

struct Archive {
    id: String,
    key: String,
    snapshot: Value,
    preview: String,
    instruction: String,
}
#[derive(Default)]
pub struct BoardPages {
    archives: Vec<Archive>,
}

impl BoardPages {
    pub fn preview(&mut self, key: String, full: Value) -> String {
        self.preview_with_harness(key, full, &baseline())
    }
    pub fn preview_with_harness(
        &mut self,
        key: String,
        full: Value,
        harness: &ResolvedHarness,
    ) -> String {
        let instruction = harness.text(TextId::CollaborationBoardArchiveInstructions);
        if let Some(existing) = self
            .archives
            .iter()
            .find(|v| v.key == key && v.instruction == instruction)
        {
            return existing.preview.clone();
        }
        let mut preview = json!({});
        let mut counts = json!({});
        let mut truncated = false;
        for section in SECTIONS {
            let rows = full[section].as_array().expect("board section array");
            counts[section] = rows.len().into();
            let mut selected = Vec::new();
            let mut bytes = 0;
            for row in rows.iter().rev().take(100) {
                let size = crate::js::stringify(row).len();
                if bytes + size > 6 * 1024 {
                    break;
                }
                selected.insert(0, row.clone());
                bytes += size + 1;
            }
            truncated |= selected.len() != rows.len();
            preview[section] = selected.into();
        }
        let id = super::protocol::id();
        preview["counts"] = counts;
        preview["truncated"] = truncated.into();
        if truncated {
            preview["archive"] = format!("{PREFIX}{id}:0:0").into();
            preview["instructions"] = instruction.into();
        }
        let preview = crate::js::stringify(&preview);
        self.archives.push(Archive {
            id,
            key,
            snapshot: full,
            preview: preview.clone(),
            instruction: instruction.into(),
        });
        if self.archives.len() > 2 {
            self.archives.remove(0);
        }
        preview
    }
    pub fn clear(&mut self) {
        self.archives.clear();
    }
    pub fn read(&self, reference: &str) -> Result<Option<String>> {
        let Some(rest) = reference.strip_prefix(PREFIX) else {
            return Ok(None);
        };
        let error = |id| Error::new("board_archive_unavailable", "").with_harness(id, &[]);
        let pieces: Vec<_> = rest.split(':').collect();
        if pieces.len() != 3
            || pieces[0].is_empty()
            || !pieces[0]
                .bytes()
                .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v) || v == b'-')
            || pieces[1..]
                .iter()
                .any(|v| v.is_empty() || !v.bytes().all(|b| b.is_ascii_digit()))
        {
            return Err(error(TextId::CollaborationBoardInvalidReference));
        }
        let archive = self
            .archives
            .iter()
            .find(|v| v.id == pieces[0])
            .ok_or_else(|| error(TextId::CollaborationBoardExpiredReference))?;
        let mut row = pieces[1]
            .parse::<usize>()
            .ok()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(|| error(TextId::CollaborationBoardInvalidPosition))?;
        let mut offset = pieces[2]
            .parse::<usize>()
            .ok()
            .filter(|v| *v <= 9_007_199_254_740_991)
            .ok_or_else(|| error(TextId::CollaborationBoardInvalidPosition))?;
        let rows: Vec<_> = SECTIONS
            .iter()
            .flat_map(|section| {
                archive.snapshot[section]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(move |record| (*section, record))
            })
            .collect();
        if row >= rows.len() {
            return Err(error(TextId::CollaborationBoardPositionOutsideSnapshot));
        }
        let mut chunks = String::new();
        while row < rows.len() && chunks.len() < PAGE_BYTES {
            let (section, record) = rows[row];
            let line = format!(
                "{}\n",
                crate::js::stringify(&json!({"section":section,"record":record}))
            );
            if offset >= line.len() || !line.is_char_boundary(offset) {
                return Err(error(TextId::CollaborationBoardInvalidByteOffset));
            }
            let mut end = line.len().min(offset + PAGE_BYTES - chunks.len());
            while end > offset && !line.is_char_boundary(end) {
                end -= 1;
            }
            if end == offset {
                break;
            }
            chunks.push_str(&line[offset..end]);
            if end == line.len() {
                row += 1;
                offset = 0;
            } else {
                offset = end;
                break;
            }
        }
        let next = if row < rows.len() {
            Value::String(format!("{PREFIX}{}:{row}:{offset}", archive.id))
        } else {
            Value::Null
        };
        Ok(Some(format!(
            "{}\n{chunks}",
            crate::js::stringify(&json!({"format":"jsonl-fragment","next":next}))
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_pages_preserve_multibyte_text_and_expire() {
        let mut pages = BoardPages::default();
        let full = json!({"members":[],"tasks":[],"findings":[{"body":"🌍".repeat(20000)}],"activities":[]});
        let preview: Value =
            serde_json::from_str(&pages.preview("one".into(), full.clone())).unwrap();
        assert_eq!(preview["truncated"], true);
        let mut reference = preview["archive"].as_str().unwrap().to_owned();
        let mut text = String::new();
        loop {
            let page = pages.read(&reference).unwrap().unwrap();
            let (header, body) = page.split_once('\n').unwrap();
            text.push_str(body);
            let header: Value = serde_json::from_str(header).unwrap();
            match header["next"].as_str() {
                Some(next) => reference = next.into(),
                None => break,
            }
        }
        assert_eq!(
            serde_json::from_str::<Value>(text.trim()).unwrap()["record"],
            full["findings"][0]
        );
        pages.preview("two".into(), full.clone());
        pages.preview("three".into(), full);
        assert!(pages.read(preview["archive"].as_str().unwrap()).is_err());
    }
}
