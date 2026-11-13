use std::{
    borrow::Cow,
    cmp::Ordering,
    fmt,
    hash::{Hash, Hasher},
    sync::Arc,
};

mod source;
pub(crate) use source::{TextPattern, TextSource};

#[derive(Clone)]
enum Storage {
    Utf8(Arc<str>),
    Utf16(Arc<[u16]>),
}

#[derive(Clone)]
pub struct JsText {
    storage: Storage,
    length: usize,
}

#[derive(Clone, Copy)]
pub enum JsTextView<'a> {
    Utf8(&'a str),
    Utf16(&'a [u16]),
}
impl<'a> JsTextView<'a> {
    pub fn len(self) -> usize {
        match self {
            Self::Utf8(text) => text.encode_utf16().count(),
            Self::Utf16(units) => units.len(),
        }
    }
    pub fn units(self) -> Units<'a> {
        match self {
            Self::Utf8(text) => Units::Utf8(text.encode_utf16()),
            Self::Utf16(units) => Units::Utf16(units.iter().copied()),
        }
    }
    pub fn prefix_without_split(self, maximum: usize) -> Self {
        match self {
            Self::Utf8(text) => {
                let mut length = 0;
                for (offset, character) in text.char_indices() {
                    length += character.len_utf16();
                    if length > maximum {
                        return Self::Utf8(&text[..offset]);
                    }
                }
                self
            }
            Self::Utf16(units) => {
                let mut end = maximum.min(units.len());
                if splits_pair(units, end) {
                    end -= 1;
                }
                Self::Utf16(&units[..end])
            }
        }
    }
    pub fn suffix_without_split(self, maximum: usize) -> Self {
        match self {
            Self::Utf8(text) => {
                let mut length = 0;
                for (offset, character) in text.char_indices().rev() {
                    length += character.len_utf16();
                    if length > maximum {
                        return Self::Utf8(&text[offset + character.len_utf8()..]);
                    }
                }
                self
            }
            Self::Utf16(units) => {
                let mut start = units.len().saturating_sub(maximum);
                if splits_pair(units, start) {
                    start += 1;
                }
                Self::Utf16(&units[start..])
            }
        }
    }
    pub fn split_once_ascii(self, delimiter: &str) -> Option<(Self, Self)> {
        assert!(delimiter.is_ascii() && !delimiter.is_empty());
        match self {
            Self::Utf8(text) => text
                .split_once(delimiter)
                .map(|(left, right)| (Self::Utf8(left), Self::Utf8(right))),
            Self::Utf16(units) => find_ascii(units, delimiter.as_bytes()).map(|offset| {
                (
                    Self::Utf16(&units[..offset]),
                    Self::Utf16(&units[offset + delimiter.len()..]),
                )
            }),
        }
    }
    pub fn trim_start(self) -> Self {
        match self {
            Self::Utf8(text) => Self::Utf8(super::trim_start_js(text)),
            Self::Utf16(units) => {
                let start = units
                    .iter()
                    .position(|unit| !whitespace_unit(*unit))
                    .unwrap_or(units.len());
                Self::Utf16(&units[start..])
            }
        }
    }
    pub fn trim_end(self) -> Self {
        match self {
            Self::Utf8(text) => Self::Utf8(super::trim_end_js(text)),
            Self::Utf16(units) => {
                let end = units
                    .iter()
                    .rposition(|unit| !whitespace_unit(*unit))
                    .map_or(0, |index| index + 1);
                Self::Utf16(&units[..end])
            }
        }
    }
}
fn find_ascii(units: &[u16], delimiter: &[u8]) -> Option<usize> {
    let width = delimiter.len();
    let last = u16::from(delimiter[width - 1]);
    let mut shifts = [width; 128];
    for (index, byte) in delimiter[..width - 1].iter().enumerate() {
        shifts[usize::from(*byte)] = width - index - 1;
    }
    let mut offset = 0;
    while let Some(window) = units.get(offset..offset + width) {
        let tail = window[width - 1];
        if tail == last
            && window
                .iter()
                .zip(delimiter)
                .all(|(unit, byte)| *unit == u16::from(*byte))
        {
            return Some(offset);
        }
        offset += shifts.get(usize::from(tail)).copied().unwrap_or(width);
    }
    None
}
fn splits_pair(units: &[u16], offset: usize) -> bool {
    offset > 0
        && offset < units.len()
        && (0xd800..=0xdbff).contains(&units[offset - 1])
        && (0xdc00..=0xdfff).contains(&units[offset])
}
fn whitespace_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(super::is_whitespace)
}

enum BuildStorage {
    Utf8(String),
    Utf16(Vec<u16>),
}
pub struct JsTextBuilder {
    storage: BuildStorage,
}
impl JsTextBuilder {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            storage: BuildStorage::Utf8(String::with_capacity(capacity)),
        }
    }
    pub fn with_utf16_capacity(capacity: usize) -> Self {
        Self {
            storage: BuildStorage::Utf16(Vec::with_capacity(capacity)),
        }
    }
    pub fn push_str(&mut self, value: &str) {
        match &mut self.storage {
            BuildStorage::Utf8(text) => text.push_str(value),
            BuildStorage::Utf16(units) => units.extend(value.encode_utf16()),
        }
    }
    pub fn push_text(&mut self, value: &JsText) {
        if let Some(text) = value.as_utf8() {
            self.push_str(text);
        } else {
            self.units_mut(value.len()).extend(value.units());
        }
    }
    pub fn push_view(&mut self, value: JsTextView<'_>) {
        match value {
            JsTextView::Utf8(text) => self.push_str(text),
            JsTextView::Utf16(units) => self.units_mut(units.len()).extend_from_slice(units),
        }
    }
    pub fn push_code_unit(&mut self, unit: u16) {
        if !(0xd800..=0xdfff).contains(&unit) {
            if let BuildStorage::Utf8(text) = &mut self.storage {
                text.push(char::from_u32(u32::from(unit)).unwrap());
                return;
            }
        }
        self.units_mut(1).push(unit);
    }
    fn units_mut(&mut self, additional: usize) -> &mut Vec<u16> {
        if let BuildStorage::Utf8(text) = &self.storage {
            let mut units = Vec::with_capacity(text.len() + additional);
            units.extend(text.encode_utf16());
            self.storage = BuildStorage::Utf16(units);
        }
        let BuildStorage::Utf16(units) = &mut self.storage else {
            unreachable!()
        };
        units
    }
    pub fn finish(self) -> JsText {
        match self.storage {
            BuildStorage::Utf8(text) => text.into(),
            BuildStorage::Utf16(units) => JsText::from_utf16(units),
        }
    }
    pub fn finish_utf8(self) -> Result<String, std::string::FromUtf16Error> {
        match self.storage {
            BuildStorage::Utf8(text) => Ok(text),
            BuildStorage::Utf16(units) => String::from_utf16(&units),
        }
    }
    pub fn finish_utf16(self) -> Vec<u16> {
        match self.storage {
            BuildStorage::Utf8(text) => text.encode_utf16().collect(),
            BuildStorage::Utf16(units) => units,
        }
    }
}
impl Default for JsTextBuilder {
    fn default() -> Self {
        Self::with_capacity(0)
    }
}
impl fmt::Write for JsTextBuilder {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        self.push_str(value);
        Ok(())
    }
}

pub enum Units<'a> {
    Utf8(std::str::EncodeUtf16<'a>),
    Utf16(std::iter::Copied<std::slice::Iter<'a, u16>>),
}
impl Iterator for Units<'_> {
    type Item = u16;
    fn next(&mut self) -> Option<u16> {
        match self {
            Self::Utf8(values) => values.next(),
            Self::Utf16(values) => values.next(),
        }
    }
}
impl JsText {
    pub fn from_utf16(units: impl Into<Vec<u16>>) -> Self {
        let units = units.into();
        let length = units.len();
        match String::from_utf16(&units) {
            Ok(text) => Self {
                storage: Storage::Utf8(text.into()),
                length,
            },
            Err(_) => Self {
                storage: Storage::Utf16(units.into()),
                length,
            },
        }
    }
    pub fn as_utf8(&self) -> Option<&str> {
        match &self.storage {
            Storage::Utf8(text) => Some(text),
            Storage::Utf16(_) => None,
        }
    }
    pub fn len(&self) -> usize {
        self.length
    }
    pub fn is_empty(&self) -> bool {
        self.length == 0
    }
    pub fn units(&self) -> Units<'_> {
        match &self.storage {
            Storage::Utf8(text) => Units::Utf8(text.encode_utf16()),
            Storage::Utf16(units) => Units::Utf16(units.iter().copied()),
        }
    }
    pub fn code_unit(&self, index: usize) -> Option<u16> {
        self.units().nth(index)
    }
    pub fn slice(&self, start: f64, end: Option<f64>) -> Self {
        fn offset(value: f64, length: usize) -> usize {
            if value.is_nan() || value == 0.0 {
                0
            } else if value < 0.0 {
                (length as f64 + value.trunc()).clamp(0.0, length as f64) as usize
            } else {
                value.trunc().min(length as f64) as usize
            }
        }
        let start = offset(start, self.length);
        let end = end.map_or(self.length, |end| offset(end, self.length));
        if start == 0 && end == self.length {
            return self.clone();
        }
        Self::from_utf16(
            self.units()
                .skip(start)
                .take(end.saturating_sub(start))
                .collect::<Vec<_>>(),
        )
    }
    pub fn concat(values: &[&Self]) -> Self {
        if values.iter().all(|value| value.as_utf8().is_some()) {
            let mut text = String::with_capacity(
                values
                    .iter()
                    .map(|value| value.as_utf8().unwrap().len())
                    .sum(),
            );
            for value in values {
                text.push_str(value.as_utf8().unwrap());
            }
            text.into()
        } else {
            Self::from_utf16(
                values
                    .iter()
                    .flat_map(|value| value.units())
                    .collect::<Vec<_>>(),
            )
        }
    }
    pub fn trim(&self) -> Self {
        if let Some(text) = self.as_utf8() {
            let trimmed = super::trim_js(text);
            return if trimmed.len() == text.len() {
                self.clone()
            } else {
                trimmed.into()
            };
        }
        let Storage::Utf16(units) = &self.storage else {
            unreachable!()
        };
        let whitespace =
            |unit: u16| char::from_u32(u32::from(unit)).is_some_and(super::is_whitespace);
        let first = units
            .iter()
            .position(|unit| !whitespace(*unit))
            .unwrap_or(units.len());
        let end = units
            .iter()
            .rposition(|unit| !whitespace(*unit))
            .map_or(first, |index| index + 1);
        if first == 0 && end == units.len() {
            self.clone()
        } else {
            Self::from_utf16(units[first..end].to_vec())
        }
    }
    /// Use only at an API boundary that converts JavaScript strings to UTF-8 or USVString.
    pub fn to_utf8_lossy(&self) -> Cow<'_, str> {
        match &self.storage {
            Storage::Utf8(text) => Cow::Borrowed(text),
            Storage::Utf16(units) => Cow::Owned(String::from_utf16_lossy(units)),
        }
    }
    pub fn quote_json(&self) -> String {
        let mut result = String::new();
        self.write_json(&mut result);
        result
    }
    pub fn write_json(&self, output: &mut String) {
        fn character(output: &mut String, character: char) {
            match character {
                '"' => output.push_str("\\\""),
                '\\' => output.push_str("\\\\"),
                '\u{0008}' => output.push_str("\\b"),
                '\u{000c}' => output.push_str("\\f"),
                '\n' => output.push_str("\\n"),
                '\r' => output.push_str("\\r"),
                '\t' => output.push_str("\\t"),
                value if value <= '\u{001f}' => {
                    use fmt::Write;
                    let _ = write!(output, "\\u{:04x}", value as u32);
                }
                value => output.push(value),
            }
        }
        output.push('"');
        if let Some(text) = self.as_utf8() {
            for value in text.chars() {
                character(output, value);
            }
        } else {
            let mut units = self.units().peekable();
            while let Some(unit) = units.next() {
                if (0xd800..=0xdbff).contains(&unit)
                    && units
                        .peek()
                        .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
                {
                    let low = units.next().unwrap();
                    character(
                        output,
                        char::from_u32(
                            0x10000 + ((u32::from(unit) - 0xd800) << 10) + u32::from(low) - 0xdc00,
                        )
                        .unwrap(),
                    );
                } else if (0xd800..=0xdfff).contains(&unit) {
                    use fmt::Write;
                    let _ = write!(output, "\\u{unit:04x}");
                } else {
                    character(output, char::from_u32(u32::from(unit)).unwrap());
                }
            }
        }
        output.push('"');
    }
}
impl Default for JsText {
    fn default() -> Self {
        "".into()
    }
}
impl From<&str> for JsText {
    fn from(value: &str) -> Self {
        Self {
            length: value.encode_utf16().count(),
            storage: Storage::Utf8(Arc::from(value)),
        }
    }
}
impl From<String> for JsText {
    fn from(value: String) -> Self {
        Self {
            length: value.encode_utf16().count(),
            storage: Storage::Utf8(value.into()),
        }
    }
}
impl From<&JsText> for JsText {
    fn from(value: &JsText) -> Self {
        value.clone()
    }
}
impl From<&String> for JsText {
    fn from(value: &String) -> Self {
        value.as_str().into()
    }
}
impl fmt::Debug for JsText {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.quote_json())
    }
}
impl PartialEq for JsText {
    fn eq(&self, other: &Self) -> bool {
        match (&self.storage, &other.storage) {
            (Storage::Utf8(left), Storage::Utf8(right)) => left == right,
            (Storage::Utf16(left), Storage::Utf16(right)) => left == right,
            _ => false,
        }
    }
}
impl Eq for JsText {}
impl PartialOrd for JsText {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for JsText {
    fn cmp(&self, other: &Self) -> Ordering {
        self.units().cmp(other.units())
    }
}
impl Hash for JsText {
    fn hash<H: Hasher>(&self, state: &mut H) {
        match &self.storage {
            Storage::Utf8(text) => text.hash(state),
            Storage::Utf16(units) => {
                0xffu8.hash(state);
                units.hash(state);
            }
        }
    }
}
impl indexmap::Equivalent<JsText> for str {
    fn equivalent(&self, key: &JsText) -> bool {
        key.as_utf8() == Some(self)
    }
}
impl indexmap::Equivalent<JsText> for String {
    fn equivalent(&self, key: &JsText) -> bool {
        key.as_utf8() == Some(self.as_str())
    }
}

#[cfg(test)]
mod borrowed_tests {
    use super::*;

    #[test]
    fn ascii_delimiters_find_the_first_occurrence_without_changing_code_units() {
        for delimiter in ["_", "__", "a", "aa", "aba", "abab", "\0", "__BOUNDARY__"] {
            for input in [
                "",
                "aaaabaaababa",
                "___a__",
                "😀中\0tail",
                "__BOUNDARY____BOUNDARY__",
            ] {
                let units: Vec<_> = input.encode_utf16().collect();
                let actual =
                    JsTextView::Utf16(&units)
                        .split_once_ascii(delimiter)
                        .map(|(left, right)| {
                            (
                                left.units().collect::<Vec<_>>(),
                                right.units().collect::<Vec<_>>(),
                            )
                        });
                let expected = input.split_once(delimiter).map(|(left, right)| {
                    (
                        left.encode_utf16().collect::<Vec<_>>(),
                        right.encode_utf16().collect::<Vec<_>>(),
                    )
                });
                assert_eq!(actual, expected, "{input:?} / {delimiter:?}");
            }
        }
        let units = [0xd800, 97, 98, 0xdfff, 97, 98];
        let (left, right) = JsTextView::Utf16(&units).split_once_ascii("ab").unwrap();
        assert_eq!(left.units().collect::<Vec<_>>(), [0xd800]);
        assert_eq!(right.units().collect::<Vec<_>>(), [0xdfff, 97, 98]);
    }
}
