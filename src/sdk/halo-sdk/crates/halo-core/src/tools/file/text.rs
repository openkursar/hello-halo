//! Text encodings and line endings for the file tools.
//!
//! Read, Edit and Write work on decoded text with LF line breaks, the form the
//! model reads and writes. Saving converts back to the file's own encoding, byte
//! order mark and line endings. A file that cannot be decoded losslessly is never
//! re-encoded: callers report it instead of substituting its bytes.

use std::borrow::Cow;

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: &[u8] = &[0xFF, 0xFE];
const UTF16BE_BOM: &[u8] = &[0xFE, 0xFF];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
}

impl Encoding {
    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "UTF-8",
            Self::Utf8Bom => "UTF-8 with BOM",
            Self::Utf16Le => "UTF-16LE",
            Self::Utf16Be => "UTF-16BE",
        }
    }

    pub(crate) fn is_utf16(self) -> bool {
        matches!(self, Self::Utf16Le | Self::Utf16Be)
    }

    fn bom(self) -> &'static [u8] {
        match self {
            Self::Utf8 => &[],
            Self::Utf8Bom => UTF8_BOM,
            Self::Utf16Le => UTF16LE_BOM,
            Self::Utf16Be => UTF16BE_BOM,
        }
    }
}

/// Byte order mark at the start of a file, if it names a supported encoding.
pub(crate) fn sniff(bytes: &[u8]) -> Encoding {
    if bytes.starts_with(UTF8_BOM) {
        Encoding::Utf8Bom
    } else if bytes.starts_with(UTF16LE_BOM) {
        Encoding::Utf16Le
    } else if bytes.starts_with(UTF16BE_BOM) {
        Encoding::Utf16Be
    } else {
        Encoding::Utf8
    }
}

pub(crate) struct Decoded<'a> {
    /// Text without the byte order mark, with its original line endings.
    pub text: Cow<'a, str>,
    pub encoding: Encoding,
}

/// Decodes bytes only when `encode` can reproduce them exactly.
pub(crate) fn decode(bytes: &[u8]) -> Option<Decoded<'_>> {
    let encoding = sniff(bytes);
    let body = &bytes[encoding.bom().len()..];
    let text = match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => Cow::Borrowed(std::str::from_utf8(body).ok()?),
        // FF FE 00 00 starts UTF-32LE, which is not supported.
        Encoding::Utf16Le if body.starts_with(&[0, 0]) => return None,
        Encoding::Utf16Le => Cow::Owned(utf16(body, u16::from_le_bytes)?),
        Encoding::Utf16Be => Cow::Owned(utf16(body, u16::from_be_bytes)?),
    };
    Some(Decoded { text, encoding })
}

fn utf16(body: &[u8], unit: fn([u8; 2]) -> u16) -> Option<String> {
    if body.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|pair| unit([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

/// Display text for bytes `decode` rejects; undecodable bytes become U+FFFD.
pub(crate) fn lossy(bytes: &[u8]) -> String {
    let encoding = sniff(bytes);
    let body = &bytes[encoding.bom().len()..];
    let unit: fn([u8; 2]) -> u16 = match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => {
            return String::from_utf8_lossy(body).into_owned();
        }
        Encoding::Utf16Le => u16::from_le_bytes,
        Encoding::Utf16Be => u16::from_be_bytes,
    };
    let pairs = body.chunks_exact(2);
    let odd = !pairs.remainder().is_empty();
    let mut text: String = char::decode_utf16(pairs.map(|pair| unit([pair[0], pair[1]])))
        .map(|unit| unit.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect();
    if odd {
        text.push(char::REPLACEMENT_CHARACTER);
    }
    text
}

/// Bytes for `text` in `encoding`. `text` is the body after the byte order
/// mark, which `encode` adds; a leading U+FEFF in `text` is content and is kept.
pub(crate) fn encode(text: &str, encoding: Encoding) -> Vec<u8> {
    let mut bytes = encoding.bom().to_vec();
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => bytes.extend_from_slice(text.as_bytes()),
        Encoding::Utf16Le => text
            .encode_utf16()
            .for_each(|unit| bytes.extend_from_slice(&unit.to_le_bytes())),
        Encoding::Utf16Be => text
            .encode_utf16()
            .for_each(|unit| bytes.extend_from_slice(&unit.to_be_bytes())),
    }
    bytes
}

/// Encoded length of `text`, without the byte order mark.
pub(crate) fn encoded_len(text: &str, encoding: Encoding) -> usize {
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => text.len(),
        Encoding::Utf16Le | Encoding::Utf16Be => text.encode_utf16().count() * 2,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum LineEnding {
    Lf,
    Crlf,
}

/// The ending used by most line breaks; ties keep LF.
pub(crate) fn dominant_ending(text: &str) -> LineEnding {
    let crlf = text.matches("\r\n").count();
    let lf = text.bytes().filter(|byte| *byte == b'\n').count() - crlf;
    if crlf > lf {
        LineEnding::Crlf
    } else {
        LineEnding::Lf
    }
}

pub(crate) fn lf(text: &str) -> Cow<'_, str> {
    if text.contains("\r\n") {
        Cow::Owned(text.replace("\r\n", "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

/// An LF view of text in which every CRLF pair became LF. Offsets in the view
/// map back to the original, so a replacement leaves every byte outside the
/// replaced passages untouched.
pub(crate) struct LfView<'a> {
    original: &'a str,
    text: Cow<'a, str>,
    /// View offsets of the LFs that were CRLF pairs, in ascending order.
    joined: Vec<usize>,
}

impl<'a> LfView<'a> {
    pub(crate) fn new(original: &'a str) -> Self {
        if !original.contains("\r\n") {
            return Self {
                original,
                text: Cow::Borrowed(original),
                joined: Vec::new(),
            };
        }
        let mut text = String::with_capacity(original.len());
        let mut joined = Vec::new();
        let mut rest = original;
        while let Some(index) = rest.find("\r\n") {
            text.push_str(&rest[..index]);
            joined.push(text.len());
            text.push('\n');
            rest = &rest[index + 2..];
        }
        text.push_str(rest);
        Self {
            original,
            text: Cow::Owned(text),
            joined,
        }
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    fn original_offset(&self, offset: usize) -> usize {
        offset + self.joined.partition_point(|joined| *joined < offset)
    }

    /// The original text of the first `limit` occurrences of `pattern` in the view.
    pub(crate) fn originals<'b>(&'b self, pattern: &'b str, limit: usize) -> impl Iterator<Item = &'a str> + 'b {
        self.text.match_indices(pattern).take(limit).map(move |(start, _)| {
            &self.original[self.original_offset(start)..self.original_offset(start + pattern.len())]
        })
    }

    /// The original text with the first `limit` occurrences of `pattern` in the
    /// view replaced by `insertion`.
    pub(crate) fn replace(&self, pattern: &str, limit: usize, insertion: &str) -> String {
        let mut output = String::new();
        let mut copied = 0;
        for (start, _) in self.text.match_indices(pattern).take(limit) {
            output.push_str(&self.original[copied..self.original_offset(start)]);
            output.push_str(insertion);
            copied = self.original_offset(start + pattern.len());
        }
        output.push_str(&self.original[copied..]);
        output
    }
}

/// Replacement text written in the file's line ending, so an edit never mixes endings.
pub(crate) fn with_ending(text: &str, ending: LineEnding) -> Cow<'_, str> {
    match ending {
        LineEnding::Lf => lf(text),
        LineEnding::Crlf if !text.contains('\n') => Cow::Borrowed(text),
        LineEnding::Crlf => Cow::Owned(lf(text).replace('\n', "\r\n")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoding_is_strict_and_round_trips_every_supported_encoding() {
        let text = "first\r\n中文 ✓\n";
        for encoding in [
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
        ] {
            let bytes = encode(text, encoding);
            let decoded = decode(&bytes).unwrap();
            assert_eq!(decoded.encoding, encoding);
            assert_eq!(decoded.text, text);
            assert_eq!(encode(&decoded.text, decoded.encoding), bytes);
        }
        assert!(decode(b"// \xd6\xd0\xce\xc4\n").is_none());
        assert!(decode(b"caf\xe9").is_none());
        assert!(decode(&[0xFF, 0xFE, b'a']).is_none());
        assert!(decode(&[0xFF, 0xFE, 0x00, 0xD8]).is_none());
        assert!(decode(&[0xFF, 0xFE, 0, 0, b'a', 0, 0, 0]).is_none());
        assert_eq!(decode(b"").unwrap().encoding, Encoding::Utf8);
        assert_eq!(lossy(b"caf\xe9"), "caf\u{fffd}");
        assert_eq!(lossy(&[0xFF, 0xFE, b'h', 0, b'i']), "h\u{fffd}");
    }

    #[test]
    fn view_matches_lf_text_and_splices_without_touching_other_bytes() {
        let original = "a\r\nb\nc\r\nd";
        let view = LfView::new(original);
        assert_eq!(view.text(), "a\nb\nc\nd");
        assert_eq!(view.replace("b\nc\n", 1, "X\r\n"), "a\r\nX\r\nd");
        assert_eq!(view.originals("b\nc\n", 1).collect::<Vec<_>>(), ["b\nc\r\n"]);
        assert_eq!(view.replace("\nd", 1, "!"), "a\r\nb\nc!");
        assert_eq!(view.replace("a", 1, "A"), "A\r\nb\nc\r\nd");
        assert_eq!(view.replace("\n", 2, "|"), "a|b|c\r\nd");
        assert_eq!(LfView::new("x\r\r\ny").text(), "x\r\ny");
    }

    #[test]
    fn dominant_ending_and_replacement_endings() {
        assert_eq!(dominant_ending("a\r\nb\r\nc\n"), LineEnding::Crlf);
        assert_eq!(dominant_ending("a\r\nb\n"), LineEnding::Lf);
        assert_eq!(dominant_ending("none"), LineEnding::Lf);
        assert_eq!(with_ending("x\ny\r\nz", LineEnding::Crlf), "x\r\ny\r\nz");
        assert_eq!(with_ending("x\ny\r\nz", LineEnding::Lf), "x\ny\nz");
        assert_eq!(encoded_len("中a", Encoding::Utf8), 4);
        assert_eq!(encoded_len("中a😀", Encoding::Utf16Le), 8);
    }
}
