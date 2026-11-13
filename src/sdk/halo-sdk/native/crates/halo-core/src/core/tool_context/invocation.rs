use serde::de::{DeserializeSeed, Error as _, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{cell::Cell, fmt};

pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
const MAX_DEPTH: usize = 64;
const MAX_STRING_DECODES: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    MissingTarget,
    InvalidEnvelope,
    InvalidArguments,
    ConflictingKeys,
    Limit,
    Incomplete,
}

pub struct Invocation {
    pub target: String,
    pub input: Value,
    pub original: Value,
    pub raw_input: Option<String>,
    pub normalization: Vec<String>,
}

#[derive(Default)]
struct Decoder {
    strings: usize,
    repaired: bool,
    steps: Vec<String>,
}

pub fn decode(input: &Value, raw: Option<&str>) -> Result<Invocation, Failure> {
    let mut decoder = Decoder::default();
    let envelope = match raw {
        Some(raw) => decoder.parse(raw, "envelope", Failure::InvalidEnvelope)?,
        None => {
            let mut remaining = MAX_INPUT_BYTES;
            measure(input, 1, &mut remaining)?;
            input.clone()
        }
    };
    let envelope = decoder.unwrap(envelope, "envelope", Failure::InvalidEnvelope)?;
    let object = envelope.as_object().ok_or(Failure::InvalidEnvelope)?;
    let target = object
        .get("tool")
        .and_then(Value::as_str)
        .filter(|target| !target.trim().is_empty())
        .ok_or(Failure::MissingTarget)?
        .to_owned();
    let arguments = object.get("arguments").ok_or(Failure::InvalidArguments)?;
    if object.len() != 2 {
        return Err(Failure::InvalidEnvelope);
    }
    let input = decoder.unwrap(arguments.clone(), "arguments", Failure::InvalidArguments)?;
    if !input.is_object() {
        return Err(Failure::InvalidArguments);
    }
    let mut remaining = MAX_INPUT_BYTES;
    measure(&input, 2, &mut remaining)?;
    Ok(Invocation {
        target,
        input,
        original: envelope,
        raw_input: (!decoder.steps.is_empty())
            .then(|| raw.map(str::to_owned))
            .flatten(),
        normalization: decoder.steps,
    })
}

impl Decoder {
    fn unwrap(
        &mut self,
        mut value: Value,
        scope: &str,
        invalid: Failure,
    ) -> Result<Value, Failure> {
        while let Value::String(text) = value {
            if self.strings == MAX_STRING_DECODES {
                return Err(Failure::Limit);
            }
            self.strings += 1;
            self.steps.push(format!("{scope}.json_string"));
            value = self.parse(&text, scope, invalid)?;
        }
        Ok(value)
    }

    fn parse(&mut self, text: &str, scope: &str, invalid: Failure) -> Result<Value, Failure> {
        if text.len() > MAX_INPUT_BYTES {
            return Err(Failure::Limit);
        }
        let first = match parse_json(text, invalid) {
            Ok(value) => return Ok(value),
            Err(error @ (Failure::ConflictingKeys | Failure::Limit)) => return Err(error),
            Err(error) => error,
        };
        let candidate = if let Some(content) = fenced(text) {
            self.steps.push(format!("{scope}.code_fence"));
            match parse_json(content, invalid) {
                Ok(value) => return Ok(value),
                Err(error @ (Failure::ConflictingKeys | Failure::Limit | Failure::Incomplete)) => {
                    return Err(error)
                }
                Err(_) => content,
            }
        } else {
            if first == Failure::Incomplete {
                return Err(first);
            }
            text
        };
        let Some(repaired) = trailing_commas(candidate) else {
            return Err(invalid);
        };
        if self.repaired {
            return Err(Failure::Limit);
        }
        self.repaired = true;
        let value = parse_json(&repaired, invalid)?;
        self.steps.push(format!("{scope}.trailing_comma"));
        Ok(value)
    }
}

fn fenced(text: &str) -> Option<&str> {
    let text = text.trim();
    let (first, rest) = text.split_once('\n')?;
    let label = first.trim_end().strip_prefix("```")?;
    if !label.is_empty() && !label.eq_ignore_ascii_case("json") {
        return None;
    }
    let (content, last) = rest.rsplit_once('\n')?;
    (last.trim() == "```").then_some(content)
}

fn whitespace(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r')
}

fn trailing_commas(text: &str) -> Option<String> {
    let source = text.as_bytes();
    let mut output = Vec::with_capacity(source.len());
    let mut quoted = false;
    let mut escaped = false;
    let mut previous = None;
    let mut changed = false;
    for (index, &byte) in source.iter().enumerate() {
        if quoted {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
                previous = Some(byte);
            }
            continue;
        }
        if byte == b'"' {
            quoted = true;
        }
        if byte == b',' && previous.is_some_and(|byte| !matches!(byte, b'[' | b'{' | b':' | b',')) {
            let next = source[index + 1..]
                .iter()
                .copied()
                .find(|byte| !whitespace(*byte));
            if matches!(next, Some(b'}' | b']')) {
                changed = true;
                continue;
            }
        }
        output.push(byte);
        if !whitespace(byte) {
            previous = Some(byte);
        }
    }
    (changed && !quoted).then(|| String::from_utf8(output).expect("only ASCII commas were removed"))
}

#[derive(Clone, Copy)]
struct JsonValue<'a> {
    depth: usize,
    failure: &'a Cell<Option<Failure>>,
}

impl<'de> DeserializeSeed<'de> for JsonValue<'_> {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.depth > MAX_DEPTH {
            self.failure.set(Some(Failure::Limit));
            return Err(D::Error::custom("JSON depth limit"));
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for JsonValue<'_> {
    type Value = Value;
    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("non-finite JSON number"))
    }
    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut sequence: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        let next = Self {
            depth: self.depth + 1,
            ..self
        };
        while let Some(value) = sequence.next_element_seed(next)? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        let next = Self {
            depth: self.depth + 1,
            ..self
        };
        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value_seed(next)?;
            if let Some(previous) = values.get(&key) {
                if previous != &value {
                    self.failure.set(Some(Failure::ConflictingKeys));
                    return Err(A::Error::custom("conflicting JSON object keys"));
                }
            } else {
                values.insert(key, value);
            }
        }
        Ok(Value::Object(values))
    }
}

fn parse_json(text: &str, invalid: Failure) -> Result<Value, Failure> {
    let failure = Cell::new(None);
    let mut decoder = serde_json::Deserializer::from_str(text);
    let value = JsonValue {
        depth: 1,
        failure: &failure,
    }
    .deserialize(&mut decoder)
    .and_then(|value| decoder.end().map(|_| value));
    value.map_err(|error| {
        failure.get().unwrap_or(if error.is_eof() {
            Failure::Incomplete
        } else {
            invalid
        })
    })
}

fn add(bytes: usize, remaining: &mut usize) -> Result<(), Failure> {
    *remaining = remaining.checked_sub(bytes).ok_or(Failure::Limit)?;
    Ok(())
}

fn string_size(value: &str, remaining: &mut usize) -> Result<(), Failure> {
    if value.len() > *remaining {
        return Err(Failure::Limit);
    }
    add(2, remaining)?;
    for byte in value.bytes() {
        add(
            match byte {
                b'"' | b'\\' | b'\n' | b'\r' | b'\t' | 8 | 12 => 2,
                0..=31 => 6,
                _ => 1,
            },
            remaining,
        )?;
    }
    Ok(())
}

fn measure(value: &Value, depth: usize, remaining: &mut usize) -> Result<(), Failure> {
    if depth > MAX_DEPTH {
        return Err(Failure::Limit);
    }
    match value {
        Value::Null => add(4, remaining),
        Value::Bool(value) => add(if *value { 4 } else { 5 }, remaining),
        Value::Number(value) => add(value.to_string().len(), remaining),
        Value::String(value) => string_size(value, remaining),
        Value::Array(values) => {
            add(2 + values.len().saturating_sub(1), remaining)?;
            for value in values {
                measure(value, depth + 1, remaining)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            add(2 + values.len().saturating_sub(1), remaining)?;
            for (key, value) in values {
                string_size(key, remaining)?;
                add(1, remaining)?;
                measure(value, depth + 1, remaining)?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn object_arguments_remain_unchanged_without_normalization() {
        let original = json!({"tool":"mcp__records__lookup","arguments":{"id":"00123","enabled":"false","items":[1,true,null,{"text":"中文🙂"}]}});
        let call = decode(&original, None).unwrap();
        assert_eq!(call.target, "mcp__records__lookup");
        assert_eq!(call.input, original["arguments"]);
        assert_eq!(call.original, original);
        assert!(call.normalization.is_empty());
        assert!(call.raw_input.is_none());
    }

    #[test]
    fn legacy_and_double_encoded_arguments_restore_one_object() {
        let expected = json!({"id":"42"});
        for encoded in [
            expected.to_string(),
            json!(expected.to_string()).to_string(),
        ] {
            let original = json!({"tool":"exact target ","arguments":encoded});
            let call = decode(&original, None).unwrap();
            assert_eq!(call.target, "exact target ");
            assert_eq!(call.input, expected);
            assert_eq!(call.original, original);
            assert!(!call.normalization.is_empty());
        }
    }

    #[test]
    fn complete_fences_and_trailing_commas_preserve_the_original_raw_input() {
        let raw =
            "```json\n{\"tool\":\"mcp__records__lookup\",\"arguments\":{\"ids\":[1,2,],},}\n```";
        let call = decode(&Value::Null, Some(raw)).unwrap();
        assert_eq!(call.input, json!({"ids":[1,2]}));
        assert_eq!(call.raw_input.as_deref(), Some(raw));
        assert_eq!(
            call.normalization,
            ["envelope.code_fence", "envelope.trailing_comma"]
        );
        let original = json!({"tool":"lookup","arguments":"```json\n{\"id\":\"42\"}\n```"});
        assert_eq!(decode(&original, None).unwrap().input, json!({"id":"42"}));
    }

    #[test]
    fn encoded_envelopes_are_unwrapped_without_guessing_fields() {
        let envelope = json!({"tool":"lookup","arguments":{"id":"42"}});
        let raw = json!(envelope.to_string()).to_string();
        let call = decode(&Value::Null, Some(&raw)).unwrap();
        assert_eq!(call.original, envelope);
        assert_eq!(call.input, json!({"id":"42"}));
        assert_eq!(call.raw_input.as_deref(), Some(raw.as_str()));
    }

    #[test]
    fn syntax_recovery_never_changes_sql_paths_or_embedded_json_strings() {
        let arguments = json!({"sql":"SELECT 'comma,}', '\"quoted\"'\nFROM records", "path":"C:\\work\\00123\\file.json", "text":"{\"enabled\":\"false\",}"});
        let raw = format!("{{\"tool\":\"lookup\",\"arguments\":{},}}", arguments);
        let call = decode(&Value::Null, Some(&raw)).unwrap();
        assert_eq!(call.input, arguments);
    }

    #[test]
    fn conflicting_keys_are_rejected_in_envelopes_and_argument_strings() {
        for raw in [
            r#"{"tool":"first","tool":"second","arguments":{}}"#,
            r#"{"tool":"lookup","arguments":{"nested":{"id":1,"id":2}}}"#,
        ] {
            assert!(matches!(
                decode(&Value::Null, Some(raw)),
                Err(Failure::ConflictingKeys)
            ));
        }
        assert!(matches!(
            decode(
                &json!({"tool":"lookup","arguments":"{\"id\":1,\"id\":2}"}),
                None
            ),
            Err(Failure::ConflictingKeys)
        ));
        assert!(decode(
            &Value::Null,
            Some(r#"{"tool":"lookup","tool":"lookup","arguments":{}}"#)
        )
        .is_ok());
    }

    #[test]
    fn missing_incomplete_and_nonobject_calls_fail_without_filling_content() {
        assert!(matches!(
            decode(&json!({"arguments":{"id":1}}), None),
            Err(Failure::MissingTarget)
        ));
        assert!(matches!(
            decode(&json!({"tool":"lookup"}), None),
            Err(Failure::InvalidArguments)
        ));
        assert!(matches!(
            decode(&json!({"tool":"lookup","arguments":{},"extra":true}), None),
            Err(Failure::InvalidEnvelope)
        ));
        for arguments in ["[1,]", "null", "true", "1", "[,]", "{\"id\":,}"] {
            assert!(matches!(
                decode(&json!({"tool":"lookup","arguments":arguments}), None),
                Err(Failure::InvalidArguments)
            ));
        }
        assert!(matches!(
            decode(
                &json!({"tool":"lookup","arguments":"{\"command\":\"unfinished"}),
                None
            ),
            Err(Failure::Incomplete)
        ));
    }

    #[test]
    fn byte_depth_decode_and_repair_limits_are_bounded() {
        assert!(matches!(
            decode(
                &json!({"tool":"lookup","arguments":{"body":"x".repeat(MAX_INPUT_BYTES)}}),
                None
            ),
            Err(Failure::Limit)
        ));
        let deep = format!(
            "{}0{}",
            "[".repeat(MAX_DEPTH + 1),
            "]".repeat(MAX_DEPTH + 1)
        );
        assert!(matches!(
            decode(&json!({"tool":"lookup","arguments":deep}), None),
            Err(Failure::Limit)
        ));
        let triple = json!(json!(json!({}).to_string()).to_string()).to_string();
        assert!(matches!(
            decode(&json!({"tool":"lookup","arguments":triple}), None),
            Err(Failure::Limit)
        ));
        let raw = r#"{"tool":"lookup","arguments":"{\"id\":1,}",}"#;
        assert!(matches!(
            decode(&Value::Null, Some(raw)),
            Err(Failure::Limit)
        ));
    }
}
