use crate::{
    error::{Error, Result as CoreResult},
    harness::{Message, TextId},
    js::text::{JsText, JsTextView, TextSource},
};
use serde_json::{Map, Value};

#[path = "json_value.rs"]
mod typed;
pub use typed::{parse_text, parse_value};
pub(crate) use typed::parse_data;

#[derive(Clone, Debug)]
pub struct JsonSyntaxError {
    pub template: TextId,
    pub slots: Vec<(&'static str, JsText)>,
}
impl JsonSyntaxError {
    pub fn into_legacy_error(self) -> Error {
        let Some(slots) = self
            .slots
            .iter()
            .map(|(name, value)| value.as_utf8().map(|value| (*name, Message::from(value))))
            .collect::<Option<Vec<_>>>()
        else {
            return Error::template(
                "UNSUPPORTED_JSON_ENCODING",
                TextId::ProvidersJsonUnsupportedEncoding,
                &[],
            );
        };
        Error::template("JSON_SYNTAX", self.template, &slots)
    }
}

enum ParseFailure<E> {
    Syntax(JsonSyntaxError),
    Domain(E),
}
impl<E> From<JsonSyntaxError> for ParseFailure<E> {
    fn from(error: JsonSyntaxError) -> Self {
        Self::Syntax(error)
    }
}

trait Domain {
    type Value;
    type Text: Default;
    type Object;
    type Error;
    fn max_depth() -> usize { usize::MAX }
    fn null() -> Self::Value;
    fn boolean(value: bool) -> Self::Value;
    fn number(value: f64) -> Self::Value;
    fn text(units: Vec<u16>) -> Result<Self::Text, Self::Error>;
    fn string(value: Self::Text) -> Self::Value;
    fn array(value: Vec<Self::Value>) -> Self::Value;
    fn new_object() -> Self::Object;
    fn insert(object: &mut Self::Object, key: Self::Text, value: Self::Value);
    fn object(value: Self::Object) -> Self::Value;
}
struct JsonDomain;
impl Domain for JsonDomain {
    type Value = Value;
    type Text = String;
    type Object = Map<String, Value>;
    type Error = Error;
    fn null() -> Value {
        Value::Null
    }
    fn boolean(value: bool) -> Value {
        Value::Bool(value)
    }
    fn number(value: f64) -> Value {
        super::number_value(value)
    }
    fn text(units: Vec<u16>) -> CoreResult<String> {
        String::from_utf16(&units).map_err(|_| {
            Error::template(
                "UNSUPPORTED_JSON_ENCODING",
                TextId::ProvidersJsonUnsupportedEncoding,
                &[],
            )
        })
    }
    fn string(value: String) -> Value {
        Value::String(value)
    }
    fn array(value: Vec<Value>) -> Value {
        Value::Array(value)
    }
    fn new_object() -> Map<String, Value> {
        Map::new()
    }
    fn insert(object: &mut Map<String, Value>, key: String, value: Value) {
        object.insert(key, value);
    }
    fn object(value: Map<String, Value>) -> Value {
        Value::Object(value)
    }
}

struct Parser<'a> {
    source: TextSource<'a>,
    cursor: usize,
}
enum Container<D: Domain> {
    Array(Vec<D::Value>),
    Object(D::Object, D::Text),
}

pub fn parse(source: &str) -> CoreResult<Value> {
    parse_domain::<JsonDomain>(JsTextView::Utf8(source)).map_err(|error| match error {
        ParseFailure::Syntax(error) => error.into_legacy_error(),
        ParseFailure::Domain(error) => error,
    })
}

fn parse_domain<D: Domain>(source: JsTextView<'_>) -> Result<D::Value, ParseFailure<D::Error>> {
    let source = TextSource(source);
    let mut parser = Parser { source, cursor: 0 };
    let mut containers: Vec<Container<D>> = Vec::new();
    loop {
        parser.whitespace();
        let mut value = match parser.byte() {
            Some(b'[') => {
                if containers.len() >= D::max_depth() {
                    return Err(JsonSyntaxError { template: TextId::ProvidersJsonDataTooDeep, slots: Vec::new() }.into());
                }
                parser.cursor += 1;
                parser.whitespace();
                if parser.take(b']') {
                    D::array(Vec::new())
                } else {
                    containers.push(Container::Array(Vec::new()));
                    continue;
                }
            }
            Some(b'{') => {
                if containers.len() >= D::max_depth() {
                    return Err(JsonSyntaxError { template: TextId::ProvidersJsonDataTooDeep, slots: Vec::new() }.into());
                }
                parser.cursor += 1;
                parser.whitespace();
                if parser.take(b'}') {
                    D::object(D::new_object())
                } else {
                    let key =
                        parser.property::<D>(TextId::ProvidersJsonSyntaxExpectedPropertyOrEnd)?;
                    containers.push(Container::Object(D::new_object(), key));
                    continue;
                }
            }
            Some(b'"') => D::string(D::text(parser.string_units()?).map_err(ParseFailure::Domain)?),
            Some(b't') => {
                parser.literal("true")?;
                D::boolean(true)
            }
            Some(b'f') => {
                parser.literal("false")?;
                D::boolean(false)
            }
            Some(b'n') => {
                parser.literal("null")?;
                D::null()
            }
            Some(b'-' | b'0'..=b'9') => D::number(parser.number()?),
            _ => return Err(parser.unexpected().into()),
        };
        loop {
            parser.whitespace();
            match containers.last_mut() {
                None => {
                    if parser.cursor != source.len() {
                        return Err(parser
                            .position_error(TextId::ProvidersJsonSyntaxNonWhitespace)
                            .into());
                    }
                    return Ok(value);
                }
                Some(Container::Array(values)) => {
                    values.push(value);
                    if parser.take(b']') {
                        let Container::Array(values) = containers.pop().unwrap() else {
                            unreachable!()
                        };
                        value = D::array(values);
                    } else if parser.take(b',') {
                        break;
                    } else {
                        return Err(parser
                            .position_error(TextId::ProvidersJsonSyntaxExpectedArraySeparator)
                            .into());
                    }
                }
                Some(Container::Object(values, key)) => {
                    D::insert(values, std::mem::take(key), value);
                    if parser.take(b'}') {
                        let Container::Object(values, _) = containers.pop().unwrap() else {
                            unreachable!()
                        };
                        value = D::object(values);
                    } else if parser.take(b',') {
                        parser.whitespace();
                        *key = parser.property::<D>(TextId::ProvidersJsonSyntaxExpectedProperty)?;
                        break;
                    } else {
                        return Err(parser
                            .position_error(TextId::ProvidersJsonSyntaxExpectedObjectSeparator)
                            .into());
                    }
                }
            }
        }
    }
}

impl Parser<'_> {
    fn byte(&self) -> Option<u8> {
        self.source.ascii(self.cursor)
    }
    fn take(&mut self, value: u8) -> bool {
        if self.byte() == Some(value) {
            self.cursor += 1;
            true
        } else {
            false
        }
    }
    fn whitespace(&mut self) {
        while matches!(self.byte(), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.cursor += 1;
        }
    }
    fn property<D: Domain>(&mut self, id: TextId) -> Result<D::Text, ParseFailure<D::Error>> {
        if self.byte() != Some(b'"') {
            return Err(self.position_error(id).into());
        }
        let key = D::text(self.string_units()?).map_err(ParseFailure::Domain)?;
        self.whitespace();
        if !self.take(b':') {
            return Err(self
                .position_error(TextId::ProvidersJsonSyntaxExpectedColon)
                .into());
        }
        Ok(key)
    }
    fn literal(&mut self, value: &str) -> Result<(), JsonSyntaxError> {
        for byte in value.bytes() {
            if !self.take(byte) {
                return Err(self.unexpected());
            }
        }
        Ok(())
    }
    fn string_units(&mut self) -> Result<Vec<u16>, JsonSyntaxError> {
        self.cursor += 1;
        let mut units = Vec::new();
        loop {
            match self.byte() {
                None => {
                    return Err(self.position_error(TextId::ProvidersJsonSyntaxUnterminatedString))
                }
                Some(b'"') => {
                    self.cursor += 1;
                    return Ok(units);
                }
                Some(b'\\') => {
                    self.cursor += 1;
                    let Some(escaped) = self.byte() else {
                        return Err(self.unexpected());
                    };
                    let value = match escaped {
                        b'"' | b'\\' | b'/' => escaped as u16,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            self.cursor += 1;
                            let mut value = 0;
                            for _ in 0..4 {
                                let digit =
                                    self.byte().and_then(|byte| (byte as char).to_digit(16));
                                let Some(digit) = digit else {
                                    return Err(
                                        self.position_error(TextId::ProvidersJsonSyntaxBadUnicode)
                                    );
                                };
                                value = value * 16 + digit as u16;
                                self.cursor += 1;
                            }
                            units.push(value);
                            continue;
                        }
                        _ => return Err(self.position_error(TextId::ProvidersJsonSyntaxBadEscape)),
                    };
                    self.cursor += 1;
                    units.push(value);
                }
                Some(0..=31) => {
                    return Err(self.position_error(TextId::ProvidersJsonSyntaxBadControl))
                }
                _ => {
                    let (code, width) = self.source.peek(self.cursor).unwrap();
                    if code <= 0xffff {
                        units.push(code as u16);
                    } else {
                        units.extend(
                            char::from_u32(code)
                                .unwrap()
                                .encode_utf16(&mut [0; 2])
                                .iter()
                                .copied(),
                        );
                    }
                    self.cursor += width;
                }
            }
        }
    }
    fn number(&mut self) -> Result<f64, JsonSyntaxError> {
        let start = self.cursor;
        if self.take(b'-') && !matches!(self.byte(), Some(b'0'..=b'9')) {
            return Err(self.position_error(TextId::ProvidersJsonSyntaxNoNumber));
        }
        if self.take(b'0') {
            if matches!(self.byte(), Some(b'0'..=b'9')) {
                return Err(self.position_error(TextId::ProvidersJsonSyntaxLeadingZero));
            }
        } else {
            while matches!(self.byte(), Some(b'0'..=b'9')) {
                self.cursor += 1;
            }
        }
        if self.take(b'.') {
            if !matches!(self.byte(), Some(b'0'..=b'9')) {
                return Err(self.position_error(TextId::ProvidersJsonSyntaxUnterminatedFraction));
            }
            while matches!(self.byte(), Some(b'0'..=b'9')) {
                self.cursor += 1;
            }
        }
        if self.take(b'e') || self.take(b'E') {
            if !self.take(b'+') {
                self.take(b'-');
            }
            if !matches!(self.byte(), Some(b'0'..=b'9')) {
                return Err(self.position_error(TextId::ProvidersJsonSyntaxMissingExponent));
            }
            while matches!(self.byte(), Some(b'0'..=b'9')) {
                self.cursor += 1;
            }
        }
        Ok(self
            .source
            .slice(start..self.cursor)
            .ascii_text()
            .expect("Validated JSON number text")
            .parse::<f64>()
            .expect("validated JSON number"))
    }
    fn position_error(&self, id: TextId) -> JsonSyntaxError {
        let mut position = 0;
        let mut line = 1;
        let mut column = 1;
        let mut previous_cr = false;
        for unit in self.source.slice(0..self.cursor).units() {
            position += 1;
            if unit == 13 {
                line += 1;
                column = 1;
                previous_cr = true;
            } else if unit == 10 {
                if !previous_cr {
                    line += 1;
                }
                column = 1;
                previous_cr = false;
            } else {
                column += 1;
                previous_cr = false;
            }
        }
        JsonSyntaxError {
            template: id,
            slots: vec![
                ("position", position.to_string().into()),
                ("line", line.to_string().into()),
                ("column", column.to_string().into()),
            ],
        }
    }
    fn unexpected(&self) -> JsonSyntaxError {
        let Some(token) = self
            .source
            .slice(self.cursor..self.source.len())
            .units()
            .next()
        else {
            return JsonSyntaxError {
                template: TextId::ProvidersJsonSyntaxUnexpectedEnd,
                slots: Vec::new(),
            };
        };
        if ["undefined", "NaN", "Infinity", "[object Object]"]
            .iter()
            .any(|text| self.source.equals_ascii(text))
        {
            return JsonSyntaxError {
                template: TextId::ProvidersJsonSyntaxInvalidSpecial,
                slots: vec![("context", self.source.text())],
            };
        }
        let prefix: Vec<_> = self.source.units().take(21).collect();
        let position = self.source.slice(0..self.cursor).units().count();
        let (id, units) = if prefix.len() <= 20 {
            (TextId::ProvidersJsonSyntaxUnexpectedShort, prefix)
        } else {
            let start = position.saturating_sub(10);
            let length = position + 10 - start;
            let mut window: Vec<_> = self.source.units().skip(start).take(length + 1).collect();
            let left = position >= 10;
            let right = window.len() > length;
            window.truncate(length);
            let id = match (left, right) {
                (false, false) => TextId::ProvidersJsonSyntaxUnexpectedShort,
                (false, true) => TextId::ProvidersJsonSyntaxUnexpectedHead,
                (true, false) => TextId::ProvidersJsonSyntaxUnexpectedTail,
                (true, true) => TextId::ProvidersJsonSyntaxUnexpectedMiddle,
            };
            (id, window)
        };
        JsonSyntaxError {
            template: id,
            slots: vec![
                ("token", JsText::from_utf16(vec![token])),
                ("context", JsText::from_utf16(units)),
            ],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn node_json_syntax_and_number_semantics() {
        let fixture: Value = serde_json::from_str(include_str!("fixtures/json.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let result = parse(case["source"].as_str().unwrap());
            if let Some(reason) = case["error"].as_str() {
                assert_eq!(result.unwrap_err().message, reason, "{}", case["source"]);
            } else {
                assert_eq!(
                    crate::js::stringify(&result.unwrap()),
                    case["result"].as_str().unwrap(),
                    "{}",
                    case["source"]
                );
            }
        }
        assert_eq!(
            parse(r#""\ud800""#).unwrap_err().code,
            "UNSUPPORTED_JSON_ENCODING"
        );
        assert_eq!(
            parse(r#""\ud83d\ude00""#).unwrap(),
            Value::String("😀".into())
        );
    }
}
