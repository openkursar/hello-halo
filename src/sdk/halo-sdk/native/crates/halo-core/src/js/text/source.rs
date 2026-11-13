use super::{find_ascii, JsText, JsTextView, Units};
use std::{borrow::Cow, ops::Range};

#[derive(Clone, Copy)]
pub(crate) struct TextSource<'a>(pub JsTextView<'a>);

pub(crate) struct TextPattern {
    text: JsText,
    units: Vec<u16>,
}
impl TextPattern {
    pub fn new(text: impl Into<JsText>) -> Self {
        let text = text.into();
        let units = text.units().collect();
        Self { text, units }
    }
}

impl<'a> TextSource<'a> {
    // Offsets address the borrowed representation; only decoded positions count UTF-16 units.
    pub fn len(self) -> usize {
        match self.0 {
            JsTextView::Utf8(text) => text.len(),
            JsTextView::Utf16(units) => units.len(),
        }
    }
    pub fn is_empty(self) -> bool {
        self.len() == 0
    }
    pub fn slice(self, range: Range<usize>) -> Self {
        Self(match self.0 {
            JsTextView::Utf8(text) => JsTextView::Utf8(&text[range]),
            JsTextView::Utf16(units) => JsTextView::Utf16(&units[range]),
        })
    }
    pub fn units(self) -> Units<'a> {
        self.0.units()
    }
    pub fn text(self) -> JsText {
        match self.0 {
            JsTextView::Utf8(text) => text.into(),
            JsTextView::Utf16(units) => JsText::from_utf16(units.to_vec()),
        }
    }
    pub fn trim(self) -> Self {
        Self(self.0.trim_start().trim_end())
    }
    pub fn trim_start(self) -> Self {
        Self(self.0.trim_start())
    }
    pub fn trim_end(self) -> Self {
        Self(self.0.trim_end())
    }
    pub fn peek(self, offset: usize) -> Option<(u32, usize)> {
        match self.0 {
            JsTextView::Utf8(text) => text
                .get(offset..)?
                .chars()
                .next()
                .map(|character| (character as u32, character.len_utf8())),
            JsTextView::Utf16(units) => units.get(offset).map(|unit| (u32::from(*unit), 1)),
        }
    }
    pub fn ascii(self, offset: usize) -> Option<u8> {
        match self.0 {
            JsTextView::Utf8(text) => text.as_bytes().get(offset).copied(),
            JsTextView::Utf16(units) => {
                units
                    .get(offset)
                    .map(|unit| if *unit <= 0x7f { *unit as u8 } else { 0xff })
            }
        }
    }
    pub fn ascii_text(self) -> Option<Cow<'a, str>> {
        match self.0 {
            JsTextView::Utf8(text) => text.is_ascii().then_some(Cow::Borrowed(text)),
            JsTextView::Utf16(units) => units.iter().all(|unit| *unit <= 0x7f).then(|| {
                Cow::Owned(
                    String::from_utf8(units.iter().map(|unit| *unit as u8).collect())
                        .expect("Validated ASCII units"),
                )
            }),
        }
    }
    pub fn equals_ascii(self, text: &str) -> bool {
        self.units().eq(text.encode_utf16())
    }
    pub fn find_ascii(self, text: &str, offset: usize) -> Option<usize> {
        assert!(text.is_ascii() && !text.is_empty());
        match self.0 {
            JsTextView::Utf8(source) => {
                source.get(offset..)?.find(text).map(|found| offset + found)
            }
            JsTextView::Utf16(units) => {
                find_ascii(units.get(offset..)?, text.as_bytes()).map(|found| offset + found)
            }
        }
    }
    pub fn match_ascii(self, text: &str, offset: usize) -> Option<usize> {
        assert!(text.is_ascii());
        let end = offset.checked_add(text.len())?;
        match self.0 {
            JsTextView::Utf8(source) => source.get(offset..)?.starts_with(text).then_some(end),
            JsTextView::Utf16(units) => units
                .get(offset..end)?
                .iter()
                .copied()
                .eq(text.encode_utf16())
                .then_some(end),
        }
    }
    pub fn match_pattern(self, pattern: &TextPattern, offset: usize) -> Option<usize> {
        match self.0 {
            JsTextView::Utf8(source) => {
                let text = pattern.text.as_utf8()?;
                source
                    .get(offset..)?
                    .starts_with(text)
                    .then_some(offset + text.len())
            }
            JsTextView::Utf16(units) => {
                let end = offset.checked_add(pattern.units.len())?;
                (units.get(offset..end)? == pattern.units).then_some(end)
            }
        }
    }
    pub fn find_pattern(self, pattern: &TextPattern, offset: usize) -> Option<(usize, usize)> {
        match self.0 {
            JsTextView::Utf8(source) => {
                let text = pattern.text.as_utf8()?;
                source
                    .get(offset..)?
                    .find(text)
                    .map(|found| (offset + found, offset + found + text.len()))
            }
            JsTextView::Utf16(units) => {
                let source = units.get(offset..)?;
                if pattern.units.is_empty() {
                    return Some((offset, offset));
                }
                let found =
                    if let Some(text) = pattern.text.as_utf8().filter(|text| text.is_ascii()) {
                        find_ascii(source, text.as_bytes())
                    } else {
                        source
                            .windows(pattern.units.len())
                            .position(|window| window == pattern.units)
                    }?;
                Some((offset + found, offset + found + pattern.units.len()))
            }
        }
    }
}
