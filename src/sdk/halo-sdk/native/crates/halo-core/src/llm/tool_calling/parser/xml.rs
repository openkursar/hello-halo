use crate::js::{
    self,
    text::{JsText, JsTextBuilder, JsTextView, TextPattern, TextSource},
    value::{JsObject, JsValue},
};

#[derive(Clone, Debug)]
pub enum ParameterPrototype {
    Default,
    Null,
    Data(JsValue),
}
#[derive(Clone, Debug)]
pub struct ParameterObject {
    pub own_entries: JsObject,
    pub prototype: ParameterPrototype,
}
#[derive(Clone, Debug)]
pub struct XmlCall {
    pub name: JsText,
    pub parameters: ParameterObject,
    pub raw_xml: JsText,
}
#[derive(Clone, Debug)]
pub struct XmlResult {
    pub text_content: JsText,
    pub tool_calls: Vec<XmlCall>,
}

const OBJECT_PROPERTIES: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];
const ARRAY_PROPERTIES: &[&str] = &[
    "at",
    "concat",
    "copyWithin",
    "fill",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "lastIndexOf",
    "pop",
    "push",
    "reverse",
    "shift",
    "unshift",
    "slice",
    "sort",
    "splice",
    "includes",
    "indexOf",
    "join",
    "keys",
    "entries",
    "values",
    "forEach",
    "filter",
    "flat",
    "flatMap",
    "map",
    "every",
    "some",
    "reduce",
    "reduceRight",
    "toReversed",
    "toSorted",
    "toSpliced",
    "with",
];
impl ParameterObject {
    fn new() -> Self {
        Self {
            own_entries: JsObject::new(),
            prototype: ParameterPrototype::Default,
        }
    }
    fn prototype_setter(&self) -> bool {
        match &self.prototype {
            ParameterPrototype::Default => true,
            ParameterPrototype::Null => false,
            ParameterPrototype::Data(JsValue::Object(properties)) => {
                !properties.contains_key("__proto__")
            }
            ParameterPrototype::Data(_) => true,
        }
    }
    fn insert(&mut self, key: JsText, value: JsValue) {
        if key.as_utf8() == Some("__proto__")
            && !self.own_entries.contains_key(&key)
            && self.prototype_setter()
        {
            match value {
                JsValue::Null => self.prototype = ParameterPrototype::Null,
                JsValue::Object(_) | JsValue::Array(_) => {
                    self.prototype = ParameterPrototype::Data(value)
                }
                _ => {}
            }
        } else {
            self.own_entries.insert(key, value);
        }
    }
    fn contains(&self, key: &JsText) -> bool {
        if self.own_entries.contains_key(key) {
            return true;
        }
        let name = key.as_utf8();
        match &self.prototype {
            ParameterPrototype::Null => return false,
            ParameterPrototype::Data(JsValue::Object(properties))
                if properties.contains_key(key) =>
            {
                return true
            }
            ParameterPrototype::Data(JsValue::Array(items)) => {
                if name.is_some_and(|name| {
                    name == "length"
                        || ARRAY_PROPERTIES.contains(&name)
                        || name
                            .parse::<usize>()
                            .ok()
                            .is_some_and(|index| index < items.len() && index.to_string() == name)
                }) {
                    return true;
                }
            }
            _ => {}
        }
        name.is_some_and(|name| OBJECT_PROPERTIES.contains(&name))
    }
}

struct NamedPattern {
    name: JsText,
    opening: TextPattern,
    closing: TextPattern,
}
fn surrounding(name: &JsText, before: &str, after: &str) -> TextPattern {
    let mut text = JsTextBuilder::default();
    text.push_str(before);
    text.push_text(name);
    text.push_str(after);
    TextPattern::new(text.finish())
}
pub(super) struct Tag {
    pub start: usize,
    pub end: usize,
    pub name: JsText,
    pub body_start: usize,
    pub body_end: usize,
}
pub(super) struct Scanner<'a> {
    source: TextSource<'a>,
    names: Vec<NamedPattern>,
    cursor: usize,
}
impl<'a> Scanner<'a> {
    pub fn new(source: TextSource<'a>, names: &[JsText]) -> Self {
        Self {
            source,
            names: names
                .iter()
                .map(|name| NamedPattern {
                    name: name.clone(),
                    opening: surrounding(name, "<", ">"),
                    closing: surrounding(name, "</", ">"),
                })
                .collect(),
            cursor: 0,
        }
    }
    pub fn next(&mut self) -> Option<Tag> {
        while let Some(start) = self.source.find_ascii("<", self.cursor) {
            for name in &self.names {
                if let Some(body_start) = self.source.match_pattern(&name.opening, start) {
                    if let Some((body_end, end)) =
                        self.source.find_pattern(&name.closing, body_start)
                    {
                        self.cursor = end;
                        return Some(Tag {
                            start,
                            end,
                            name: name.name.clone(),
                            body_start,
                            body_end,
                        });
                    }
                }
            }
            self.cursor = start + 1;
        }
        None
    }
}

fn numeric(text: &str) -> Option<f64> {
    if matches!(text, "Infinity" | "+Infinity") {
        return Some(f64::INFINITY);
    }
    if text == "-Infinity" {
        return Some(f64::NEG_INFINITY);
    }
    let radix = if text.starts_with("0x") || text.starts_with("0X") {
        Some(16)
    } else if text.starts_with("0b") || text.starts_with("0B") {
        Some(2)
    } else if text.starts_with("0o") || text.starts_with("0O") {
        Some(8)
    } else {
        None
    };
    if let Some(radix) = radix {
        if text.len() == 2 {
            return None;
        }
        let mut bits = Vec::new();
        let width = match radix {
            16 => 4,
            8 => 3,
            _ => 1,
        };
        for character in text[2..].chars() {
            let digit = character.to_digit(radix)?;
            for index in (0..width).rev() {
                bits.push((digit >> index) & 1);
            }
        }
        let Some(first) = bits.iter().position(|bit| *bit == 1) else {
            return Some(0.0);
        };
        let bits = &bits[first..];
        let mut exponent = bits.len() - 1;
        if exponent > 1023 {
            return Some(f64::INFINITY);
        }
        let mut significand = 0u64;
        for index in 0..53 {
            significand = (significand << 1) | bits.get(index).copied().unwrap_or(0) as u64;
        }
        if bits.get(53) == Some(&1)
            && (bits[54.min(bits.len())..].contains(&1) || significand & 1 == 1)
        {
            significand += 1;
            if significand == 1 << 53 {
                significand >>= 1;
                exponent += 1;
            }
        }
        if exponent > 1023 {
            return Some(f64::INFINITY);
        }
        return Some(f64::from_bits(
            ((exponent as u64 + 1023) << 52) | (significand & ((1 << 52) - 1)),
        ));
    }
    let bytes = text.as_bytes();
    let mut cursor = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let start = cursor;
    while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
        cursor += 1;
    }
    let mut digits = cursor > start;
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let start = cursor;
        while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
            cursor += 1;
        }
        digits |= cursor > start;
    }
    if !digits {
        return None;
    }
    if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        if matches!(bytes.get(cursor), Some(b'+' | b'-')) {
            cursor += 1;
        }
        let start = cursor;
        while matches!(bytes.get(cursor), Some(b'0'..=b'9')) {
            cursor += 1;
        }
        if cursor == start {
            return None;
        }
    }
    if cursor != bytes.len() {
        return None;
    }
    text.parse().ok()
}

fn coerce(source: TextSource<'_>) -> JsValue {
    let source = source.trim();
    if !source.is_empty() {
        if let Ok(value) = js::json::parse_text(source.0) {
            return value;
        }
        if let Some(value) = source.ascii_text().and_then(|text| numeric(&text)) {
            return JsValue::Number(value);
        }
    }
    JsValue::String(source.text())
}
fn word_end(source: TextSource<'_>, start: usize) -> usize {
    let mut end = start;
    while source
        .ascii(end)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        end += 1;
    }
    end
}
fn parameters(source: TextSource<'_>) -> ParameterObject {
    let mut result = ParameterObject::new();
    let mut cursor = 0;
    while let Some(start) = source.find_ascii("<param", cursor) {
        let after_name = start + 6;
        cursor = after_name;
        if !source
            .peek(after_name)
            .is_some_and(|(code, _)| char::from_u32(code).is_some_and(js::is_whitespace))
        {
            continue;
        }
        let Some(end) = source.find_ascii(">", after_name) else {
            break;
        };
        let Some(close) = source.find_ascii("</param>", end + 1) else {
            continue;
        };
        cursor = close + 8;
        let attributes = source.slice(after_name..end);
        let Some(name_start) = attributes
            .find_ascii("name=\"", 0)
            .map(|position| position + 6)
        else {
            continue;
        };
        let Some(name_end) = attributes.find_ascii("\"", name_start) else {
            continue;
        };
        if name_start == name_end {
            continue;
        }
        result.insert(
            attributes.slice(name_start..name_end).text(),
            coerce(source.slice(end + 1..close)),
        );
    }
    if !result.own_entries.is_empty() {
        return result;
    }
    cursor = 0;
    while let Some(start) = source.find_ascii("<", cursor) {
        let end = word_end(source, start + 1);
        cursor = start + 1;
        if end == start + 1 || source.ascii(end) != Some(b'>') {
            continue;
        }
        let name = source.slice(start + 1..end).text();
        let closing = surrounding(&name, "</", ">");
        let Some((close, next)) = source.find_pattern(&closing, end + 1) else {
            continue;
        };
        result.insert(name, coerce(source.slice(end + 1..close)));
        cursor = next;
    }
    cursor = 0;
    while let Some(start) = source.find_ascii("<", cursor) {
        let end = word_end(source, start + 1);
        cursor = start + 1;
        if end == start + 1 {
            continue;
        }
        let tail = source.slice(end..source.len()).trim_start();
        if tail.match_ascii("/>", 0).is_none() {
            continue;
        }
        let name = source.slice(start + 1..end).text();
        if !result.contains(&name) {
            result.insert(name, JsValue::from(""));
        }
        cursor = source.len() - tail.len() + 2;
    }
    result
}

pub fn parse_xml(text: JsTextView<'_>, names: &[JsText]) -> XmlResult {
    let source = TextSource(text);
    let mut result = XmlResult {
        text_content: JsText::default(),
        tool_calls: Vec::new(),
    };
    if names.is_empty() || source.is_empty() {
        result.text_content = source.text();
        return result;
    }
    let mut scanner = Scanner::new(source, names);
    while let Some(tag) = scanner.next() {
        if result.tool_calls.is_empty() {
            result.text_content = source.slice(0..tag.start).trim_end().text();
        }
        result.tool_calls.push(XmlCall {
            name: tag.name,
            parameters: parameters(source.slice(tag.body_start..tag.body_end)),
            raw_xml: source.slice(tag.start..tag.end).text(),
        });
    }
    if result.tool_calls.is_empty() {
        result.text_content = source.text();
    }
    result
}
