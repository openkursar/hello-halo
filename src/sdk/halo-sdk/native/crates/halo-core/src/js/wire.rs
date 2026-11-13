use super::{
    text::JsText,
    value::{JsObject, JsValue},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashSet, fmt};

pub const VERSION: u32 = 1;

pub mod optional_data {
    use super::{JsValue, WireDocument};
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<JsValue>, serializer: S) -> Result<S::Ok, S::Error> {
        value.as_ref().map(WireDocument::encode).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<JsValue>, D::Error> {
        Option::<WireDocument>::deserialize(deserializer)?
            .map(|document| document.decode().map_err(serde::de::Error::custom))
            .transpose()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WireDocument {
    version: u32,
    data: Value,
    extensions: Vec<Extension>,
}
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
enum Path {
    Key(String),
    Index(usize),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
enum Number {
    #[serde(rename = "NaN")]
    Nan,
    #[serde(rename = "Infinity")]
    Infinity,
    #[serde(rename = "-Infinity")]
    NegativeInfinity,
    #[serde(rename = "-0")]
    NegativeZero,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(untagged)]
enum Key {
    Utf8(String),
    Utf16(Vec<u16>),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    key: Key,
    value: WireDocument,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum Extension {
    Undefined {
        path: Vec<Path>,
    },
    Number {
        path: Vec<Path>,
        value: Number,
    },
    Text16 {
        path: Vec<Path>,
        units: Vec<u16>,
    },
    Callback {
        path: Vec<Path>,
        id: String,
    },
    Signal {
        path: Vec<Path>,
    },
    Object16 {
        path: Vec<Path>,
        entries: Vec<Entry>,
    },
}
impl Extension {
    fn path(&self) -> &[Path] {
        match self {
            Self::Undefined { path }
            | Self::Number { path, .. }
            | Self::Text16 { path, .. }
            | Self::Callback { path, .. }
            | Self::Signal { path }
            | Self::Object16 { path, .. } => path,
        }
    }
    fn value(self) -> Result<JsValue, WireError> {
        Ok(match self {
            Self::Undefined { .. } => JsValue::Undefined,
            Self::Number { value, .. } => JsValue::Number(match value {
                Number::Nan => f64::NAN,
                Number::Infinity => f64::INFINITY,
                Number::NegativeInfinity => f64::NEG_INFINITY,
                Number::NegativeZero => -0.0,
            }),
            Self::Text16 { units, .. } => JsText::from_utf16(units).into(),
            Self::Callback { id, .. } => JsValue::Callback(id),
            Self::Signal { .. } => JsValue::Signal,
            Self::Object16 { entries, .. } => {
                let mut object = JsObject::with_capacity(entries.len());
                for entry in entries {
                    let key = match entry.key {
                        Key::Utf8(key) => key.into(),
                        Key::Utf16(units) => JsText::from_utf16(units),
                    };
                    if object.contains_key(&key) {
                        return Err(WireError::DuplicateObjectKey);
                    }
                    object.insert(key, entry.value.decode()?);
                }
                JsValue::Object(object)
            }
        })
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WireError {
    Schema(String),
    Version(u32),
    DuplicatePath,
    OverlappingPath,
    MissingPath,
    NonNullPlaceholder,
    DuplicateObjectKey,
}
impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Invalid lossless wire document: {self:?}")
    }
}
impl std::error::Error for WireError {}

impl WireDocument {
    pub fn encode(value: &JsValue) -> Self {
        fn encode(value: &JsValue, path: &mut Vec<Path>, extensions: &mut Vec<Extension>) -> Value {
            match value {
                JsValue::Null => Value::Null,
                JsValue::Bool(value) => (*value).into(),
                JsValue::Number(value)
                    if value.is_finite() && !(*value == 0.0 && value.is_sign_negative()) =>
                {
                    serde_json::json!(value)
                }
                JsValue::Number(value) => {
                    let value = if value.is_nan() {
                        Number::Nan
                    } else if *value == f64::INFINITY {
                        Number::Infinity
                    } else if *value == f64::NEG_INFINITY {
                        Number::NegativeInfinity
                    } else {
                        Number::NegativeZero
                    };
                    extensions.push(Extension::Number {
                        path: path.clone(),
                        value,
                    });
                    Value::Null
                }
                JsValue::String(value) => {
                    if let Some(value) = value.as_utf8() {
                        value.into()
                    } else {
                        extensions.push(Extension::Text16 {
                            path: path.clone(),
                            units: value.units().collect(),
                        });
                        Value::Null
                    }
                }
                JsValue::Undefined => {
                    extensions.push(Extension::Undefined { path: path.clone() });
                    Value::Null
                }
                JsValue::Callback(id) => {
                    extensions.push(Extension::Callback {
                        path: path.clone(),
                        id: id.clone(),
                    });
                    Value::Null
                }
                JsValue::Signal => {
                    extensions.push(Extension::Signal { path: path.clone() });
                    Value::Null
                }
                JsValue::Array(values) => {
                    let mut result = Vec::with_capacity(values.len());
                    for (index, value) in values.iter().enumerate() {
                        path.push(Path::Index(index));
                        result.push(encode(value, path, extensions));
                        path.pop();
                    }
                    Value::Array(result)
                }
                JsValue::Object(values) => {
                    if values.keys().any(|key| key.as_utf8().is_none()) {
                        extensions.push(Extension::Object16 {
                            path: path.clone(),
                            entries: values
                                .iter()
                                .map(|(key, value)| Entry {
                                    key: key
                                        .as_utf8()
                                        .map(|key| Key::Utf8(key.into()))
                                        .unwrap_or_else(|| Key::Utf16(key.units().collect())),
                                    value: WireDocument::encode(value),
                                })
                                .collect(),
                        });
                        Value::Null
                    } else {
                        let mut result = serde_json::Map::new();
                        for (key, value) in values {
                            let key = key.as_utf8().unwrap();
                            path.push(Path::Key(key.into()));
                            result.insert(key.into(), encode(value, path, extensions));
                            path.pop();
                        }
                        Value::Object(result)
                    }
                }
            }
        }
        let mut extensions = Vec::new();
        let data = encode(value, &mut Vec::new(), &mut extensions);
        Self {
            version: VERSION,
            data,
            extensions,
        }
    }
    pub fn decode(self) -> Result<JsValue, WireError> {
        if self.version != VERSION {
            return Err(WireError::Version(self.version));
        }
        let mut paths = HashSet::new();
        for extension in &self.extensions {
            if !paths.insert(extension.path()) {
                return Err(WireError::DuplicatePath);
            }
        }
        for path in &paths {
            for end in 0..path.len() {
                if paths.contains(&path[..end]) {
                    return Err(WireError::OverlappingPath);
                }
            }
        }
        let mut data = JsValue::from_json(self.data);
        for extension in self.extensions {
            let mut target = &mut data;
            for part in extension.path() {
                target = match (part, target) {
                    (Path::Key(key), JsValue::Object(values)) => {
                        values.get_mut(key).ok_or(WireError::MissingPath)?
                    }
                    (Path::Index(index), JsValue::Array(values)) => {
                        values.get_mut(*index).ok_or(WireError::MissingPath)?
                    }
                    _ => return Err(WireError::MissingPath),
                };
            }
            if !matches!(target, JsValue::Null) {
                return Err(WireError::NonNullPlaceholder);
            }
            *target = extension.value()?;
        }
        Ok(data)
    }
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).expect("Wire documents contain JSON-compatible fields")
    }
    pub fn to_json_string(&self) -> String {
        super::data::stringify(&self.to_json())
    }
    pub fn from_json(value: Value) -> Result<Self, WireError> {
        serde_json::from_value(value).map_err(|error| WireError::Schema(error.to_string()))
    }
    pub fn from_json_str(value: &str) -> Result<Self, WireError> {
        serde_json::from_str(value).map_err(|error| WireError::Schema(error.to_string()))
    }
}
