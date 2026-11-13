use std::{collections::HashMap, mem::MaybeUninit};
use unsafe_libyaml as yaml;

struct Parser<'a> {
    value: Box<MaybeUninit<yaml::yaml_parser_t>>,
    input: &'a str,
}
impl Drop for Parser<'_> {
    fn drop(&mut self) {
        unsafe {
            yaml::yaml_parser_delete(self.value.as_mut_ptr());
        }
    }
}
enum Event {
    StartMap,
    StartSequence,
    EndCollection,
    Scalar(String),
    Alias,
    StreamEnd,
    Other,
}
impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Option<Self> {
        let mut value = Box::new(MaybeUninit::uninit());
        unsafe {
            if yaml::yaml_parser_initialize(value.as_mut_ptr()).fail {
                return None;
            }
        }
        let mut parser = Self { value, input };
        unsafe {
            yaml::yaml_parser_set_input_string(
                parser.value.as_mut_ptr(),
                parser.input.as_ptr(),
                parser.input.len() as u64,
            );
        }
        Some(parser)
    }
    fn next(&mut self) -> Option<Event> {
        let mut raw = MaybeUninit::uninit();
        unsafe {
            if yaml::yaml_parser_parse(self.value.as_mut_ptr(), raw.as_mut_ptr()).fail {
                return None;
            }
            let mut raw = raw.assume_init();
            let event = match raw.type_ {
                yaml::YAML_MAPPING_START_EVENT => Event::StartMap,
                yaml::YAML_SEQUENCE_START_EVENT => Event::StartSequence,
                yaml::YAML_MAPPING_END_EVENT | yaml::YAML_SEQUENCE_END_EVENT => {
                    Event::EndCollection
                }
                yaml::YAML_ALIAS_EVENT => Event::Alias,
                yaml::YAML_SCALAR_EVENT => {
                    let scalar = raw.data.scalar;
                    let value = std::slice::from_raw_parts(scalar.value, scalar.length as usize);
                    Event::Scalar(String::from_utf8_lossy(value).into_owned())
                }
                yaml::YAML_STREAM_END_EVENT => Event::StreamEnd,
                _ => Event::Other,
            };
            yaml::yaml_event_delete(&mut raw);
            Some(event)
        }
    }
}

pub(super) fn fields(input: &str) -> Option<HashMap<String, String>> {
    let document: serde_yaml::Value = serde_yaml::from_str(input).ok()?;
    document.as_mapping()?;
    let mut parser = Parser::new(input)?;
    let mut depth = 0;
    let mut key = None;
    let mut expect_key = true;
    let mut fields = HashMap::new();
    loop {
        let node = match parser.next()? {
            Event::StartMap | Event::StartSequence => {
                depth += 1;
                continue;
            }
            Event::EndCollection => {
                depth -= 1;
                if depth != 1 {
                    continue;
                }
                None
            }
            Event::Scalar(text) if depth == 1 => Some(text),
            Event::Alias if depth == 1 => None,
            Event::StreamEnd => break,
            _ => continue,
        };
        if expect_key {
            key = node;
        } else if let (Some(key), Some(value)) = (key.take(), node) {
            if ["description", "whenToUse", "argumentHint", "argument-hint"].contains(&key.as_str())
            {
                fields.insert(key, value);
            }
        }
        expect_key = !expect_key;
    }
    Some(fields)
}
