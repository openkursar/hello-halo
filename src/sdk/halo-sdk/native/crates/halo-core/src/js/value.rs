use super::text::JsText;
use indexmap::IndexMap;
use std::fmt;

#[path = "value_build.rs"]
mod build;
pub use build::ValueIndex;

pub type JsObject = IndexMap<JsText, JsValue>;
#[derive(Clone, Debug)]
pub enum JsValue {
    Null,
    Bool(bool),
    Number(f64),
    String(JsText),
    Array(Vec<JsValue>),
    Object(JsObject),
    Undefined,
    Callback(String),
    Signal,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PathPart {
    Key(JsText),
    Index(usize),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JsonIncompatibility {
    Undefined,
    NonFiniteNumber,
    Utf16Text,
    Utf16Key,
    Callback,
    Signal,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsonCompatibilityError {
    pub path: Vec<PathPart>,
    pub reason: JsonIncompatibility,
}
impl fmt::Display for JsonCompatibilityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "Value requires the lossless data domain: {:?} at {:?}",
            self.reason, self.path
        )
    }
}
impl std::error::Error for JsonCompatibilityError {}

impl JsValue {
    pub fn from_json(value: serde_json::Value) -> Self {
        enum Task {
            Value(serde_json::Value),
            Array(usize),
            Object(Vec<JsText>),
        }
        let mut tasks = vec![Task::Value(value)];
        let mut values = Vec::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Value(value) => match value {
                    serde_json::Value::Null => values.push(Self::Null),
                    serde_json::Value::Bool(value) => values.push(Self::Bool(value)),
                    serde_json::Value::Number(value) => values.push(Self::Number(
                        value
                            .as_f64()
                            .unwrap_or_else(|| value.to_string().parse().unwrap_or(f64::NAN)),
                    )),
                    serde_json::Value::String(value) => values.push(Self::String(value.into())),
                    serde_json::Value::Array(items) => {
                        tasks.push(Task::Array(items.len()));
                        tasks.extend(items.into_iter().rev().map(Task::Value));
                    }
                    serde_json::Value::Object(items) => {
                        let items: Vec<_> = items.into_iter().collect();
                        tasks.push(Task::Object(
                            items.iter().map(|(key, _)| key.as_str().into()).collect(),
                        ));
                        tasks.extend(items.into_iter().rev().map(|(_, value)| Task::Value(value)));
                    }
                },
                Task::Array(length) => {
                    let items = values.split_off(values.len() - length);
                    values.push(Self::Array(items));
                }
                Task::Object(keys) => {
                    let items = values.split_off(values.len() - keys.len());
                    values.push(Self::Object(keys.into_iter().zip(items).collect()));
                }
            }
        }
        values.pop().unwrap()
    }
    pub fn try_into_json(self) -> Result<serde_json::Value, JsonCompatibilityError> {
        fn convert(
            value: JsValue,
            path: &mut Vec<PathPart>,
        ) -> Result<serde_json::Value, JsonCompatibilityError> {
            let error = |reason| JsonCompatibilityError {
                path: path.clone(),
                reason,
            };
            Ok(match value {
                JsValue::Null => serde_json::Value::Null,
                JsValue::Bool(value) => value.into(),
                JsValue::Number(value) => {
                    let number = if value.fract() == 0.0 && !(value == 0.0 && value.is_sign_negative()) {
                        if value >= 0.0 && value < 18_446_744_073_709_551_616.0 {
                            Some(serde_json::Number::from(value as u64))
                        } else if value >= -9_223_372_036_854_775_808.0 && value < 0.0 {
                            Some(serde_json::Number::from(value as i64))
                        } else {
                            serde_json::Number::from_f64(value)
                        }
                    } else {
                        serde_json::Number::from_f64(value)
                    };
                    serde_json::Value::Number(number.ok_or_else(|| error(JsonIncompatibility::NonFiniteNumber))?)
                }
                JsValue::String(value) => value
                    .as_utf8()
                    .ok_or_else(|| error(JsonIncompatibility::Utf16Text))?
                    .into(),
                JsValue::Array(values) => {
                    let mut result = Vec::with_capacity(values.len());
                    for (index, value) in values.into_iter().enumerate() {
                        path.push(PathPart::Index(index));
                        result.push(convert(value, path)?);
                        path.pop();
                    }
                    serde_json::Value::Array(result)
                }
                JsValue::Object(values) => {
                    let mut result = serde_json::Map::new();
                    for (key, value) in values {
                        path.push(PathPart::Key(key.clone()));
                        let key = key
                            .as_utf8()
                            .ok_or_else(|| JsonCompatibilityError {
                                path: path.clone(),
                                reason: JsonIncompatibility::Utf16Key,
                            })?
                            .to_owned();
                        result.insert(key, convert(value, path)?);
                        path.pop();
                    }
                    serde_json::Value::Object(result)
                }
                JsValue::Undefined => return Err(error(JsonIncompatibility::Undefined)),
                JsValue::Callback(_) => return Err(error(JsonIncompatibility::Callback)),
                JsValue::Signal => return Err(error(JsonIncompatibility::Signal)),
            })
        }
        convert(self, &mut Vec::new())
    }
    pub fn as_text(&self) -> Option<&JsText> {
        if let Self::String(text) = self {
            Some(text)
        } else {
            None
        }
    }
    pub fn as_number(&self) -> Option<f64> {
        if let Self::Number(value) = self {
            Some(*value)
        } else {
            None
        }
    }
    pub fn as_object(&self) -> Option<&JsObject> {
        if let Self::Object(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_array(&self) -> Option<&Vec<JsValue>> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn truthy(&self) -> bool {
        match self {
            Self::Null | Self::Undefined => false,
            Self::Bool(value) => *value,
            Self::Number(value) => *value != 0.0 && !value.is_nan(),
            Self::String(value) => !value.is_empty(),
            _ => true,
        }
    }
    pub fn same_value(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Null, Self::Null)
            | (Self::Undefined, Self::Undefined)
            | (Self::Signal, Self::Signal) => true,
            (Self::Bool(left), Self::Bool(right)) => left == right,
            (Self::Number(left), Self::Number(right)) => {
                (left.is_nan() && right.is_nan()) || left.to_bits() == right.to_bits()
            }
            (Self::String(left), Self::String(right)) => left == right,
            (Self::Callback(left), Self::Callback(right)) => left == right,
            (Self::Array(left), Self::Array(right)) => {
                left.len() == right.len()
                    && left
                        .iter()
                        .zip(right)
                        .all(|(left, right)| left.same_value(right))
            }
            (Self::Object(left), Self::Object(right)) => {
                left.len() == right.len()
                    && left
                        .iter()
                        .zip(right)
                        .all(|((left_key, left), (right_key, right))| {
                            left_key == right_key && left.same_value(right)
                        })
            }
            _ => false,
        }
    }
    pub fn ordered_entries(object: &JsObject) -> Vec<(&JsText, &JsValue)> {
        let mut numeric = Vec::new();
        let mut other = Vec::new();
        for (key, value) in object {
            let index = key.as_utf8().and_then(|key| {
                key.parse::<u32>()
                    .ok()
                    .filter(|index| *index != u32::MAX && index.to_string() == key)
            });
            if let Some(index) = index {
                numeric.push((index, key, value));
            } else {
                other.push((key, value));
            }
        }
        numeric.sort_by_key(|(index, _, _)| *index);
        numeric
            .into_iter()
            .map(|(_, key, value)| (key, value))
            .chain(other)
            .collect()
    }
    pub fn stringify(&self) -> Option<String> {
        if matches!(self, Self::Undefined | Self::Callback(_)) {
            return None;
        }
        enum Task<'a> {
            Value(&'a JsValue),
            Key(&'a JsText),
            Character(char),
        }
        let mut tasks = vec![Task::Value(self)];
        let mut output = String::new();
        while let Some(task) = tasks.pop() {
            match task {
                Task::Character(value) => output.push(value),
                Task::Key(key) => key.write_json(&mut output),
                Task::Value(value) => match value {
                    Self::Null | Self::Undefined | Self::Callback(_) => output.push_str("null"),
                    Self::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
                    Self::Number(value) => {
                        if value.is_finite() {
                            output.push_str(ryu_js::Buffer::new().format(*value));
                        } else {
                            output.push_str("null");
                        }
                    }
                    Self::String(text) => text.write_json(&mut output),
                    Self::Signal => output.push_str("{}"),
                    Self::Array(values) => {
                        output.push('[');
                        tasks.push(Task::Character(']'));
                        for (index, value) in values.iter().enumerate().rev() {
                            tasks.push(Task::Value(value));
                            if index > 0 {
                                tasks.push(Task::Character(','));
                            }
                        }
                    }
                    Self::Object(values) => {
                        output.push('{');
                        tasks.push(Task::Character('}'));
                        let entries: Vec<_> = Self::ordered_entries(values)
                            .into_iter()
                            .filter(|(_, value)| {
                                !matches!(value, Self::Undefined | Self::Callback(_))
                            })
                            .collect();
                        for (index, (key, value)) in entries.into_iter().enumerate().rev() {
                            tasks.push(Task::Value(value));
                            tasks.push(Task::Character(':'));
                            tasks.push(Task::Key(key));
                            if index > 0 {
                                tasks.push(Task::Character(','));
                            }
                        }
                    }
                },
            }
        }
        Some(output)
    }
}
impl PartialEq for JsValue {
    fn eq(&self, other: &Self) -> bool {
        self.same_value(other)
    }
}
impl Eq for JsValue {}
impl From<&str> for JsValue {
    fn from(value: &str) -> Self {
        Self::String(value.into())
    }
}
impl From<String> for JsValue {
    fn from(value: String) -> Self {
        Self::String(value.into())
    }
}
impl From<JsText> for JsValue {
    fn from(value: JsText) -> Self {
        Self::String(value)
    }
}
