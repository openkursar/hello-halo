use super::{JsObject, JsValue, PathPart};
use crate::js::text::JsText;
use indexmap::IndexMap;

pub trait ValueIndex {
    fn get<'a>(&self, value: &'a JsValue) -> Option<&'a JsValue>;
    fn get_mut<'a>(&self, value: &'a mut JsValue) -> Option<&'a mut JsValue>;
}
impl ValueIndex for usize {
    fn get<'a>(&self, value: &'a JsValue) -> Option<&'a JsValue> {
        value.as_array()?.get(*self)
    }
    fn get_mut<'a>(&self, value: &'a mut JsValue) -> Option<&'a mut JsValue> {
        value.as_array_mut()?.get_mut(*self)
    }
}
impl ValueIndex for str {
    fn get<'a>(&self, value: &'a JsValue) -> Option<&'a JsValue> {
        value.as_object()?.get(self)
    }
    fn get_mut<'a>(&self, value: &'a mut JsValue) -> Option<&'a mut JsValue> {
        value.as_object_mut()?.get_mut(self)
    }
}
impl ValueIndex for String {
    fn get<'a>(&self, value: &'a JsValue) -> Option<&'a JsValue> {
        ValueIndex::get(self.as_str(), value)
    }
    fn get_mut<'a>(&self, value: &'a mut JsValue) -> Option<&'a mut JsValue> {
        ValueIndex::get_mut(self.as_str(), value)
    }
}
impl ValueIndex for JsText {
    fn get<'a>(&self, value: &'a JsValue) -> Option<&'a JsValue> {
        value.as_object()?.get(self)
    }
    fn get_mut<'a>(&self, value: &'a mut JsValue) -> Option<&'a mut JsValue> {
        value.as_object_mut()?.get_mut(self)
    }
}
impl ValueIndex for PathPart {
    fn get<'a>(&self, value: &'a JsValue) -> Option<&'a JsValue> {
        match self {
            Self::Key(key) => key.get(value),
            Self::Index(index) => index.get(value),
        }
    }
    fn get_mut<'a>(&self, value: &'a mut JsValue) -> Option<&'a mut JsValue> {
        match self {
            Self::Key(key) => key.get_mut(value),
            Self::Index(index) => index.get_mut(value),
        }
    }
}
impl<T: ValueIndex + ?Sized> ValueIndex for &T {
    fn get<'a>(&self, value: &'a JsValue) -> Option<&'a JsValue> {
        T::get(self, value)
    }
    fn get_mut<'a>(&self, value: &'a mut JsValue) -> Option<&'a mut JsValue> {
        T::get_mut(self, value)
    }
}

impl JsValue {
    pub fn get(&self, index: impl ValueIndex) -> Option<&Self> {
        index.get(self)
    }
    pub fn get_mut(&mut self, index: impl ValueIndex) -> Option<&mut Self> {
        index.get_mut(self)
    }
    pub fn get_path(&self, path: &[PathPart]) -> Option<&Self> {
        let mut value = self;
        for part in path {
            value = value.get(part)?;
        }
        Some(value)
    }
    pub fn get_path_mut(&mut self, path: &[PathPart]) -> Option<&mut Self> {
        let mut value = self;
        for part in path {
            value = value.get_mut(part)?;
        }
        Some(value)
    }
    pub fn as_object_mut(&mut self) -> Option<&mut JsObject> {
        if let Self::Object(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_array_mut(&mut self) -> Option<&mut Vec<Self>> {
        if let Self::Array(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_text_mut(&mut self) -> Option<&mut JsText> {
        if let Self::String(value) = self {
            Some(value)
        } else {
            None
        }
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let Self::Bool(value) = self {
            Some(*value)
        } else {
            None
        }
    }
    pub fn as_f64(&self) -> Option<f64> {
        self.as_number()
    }
    pub fn as_u64(&self) -> Option<u64> {
        self.as_number()
            .filter(|value| {
                value.is_finite()
                    && value.fract() == 0.0
                    && *value >= 0.0
                    && *value < 18_446_744_073_709_551_616.0
            })
            .map(|value| value as u64)
    }
    pub fn as_i64(&self) -> Option<i64> {
        self.as_number()
            .filter(|value| {
                value.is_finite()
                    && value.fract() == 0.0
                    && *value >= -9_223_372_036_854_775_808.0
                    && *value < 9_223_372_036_854_775_808.0
            })
            .map(|value| value as i64)
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }
    pub fn is_undefined(&self) -> bool {
        matches!(self, Self::Undefined)
    }
    pub fn is_nullish(&self) -> bool {
        matches!(self, Self::Null | Self::Undefined)
    }
    pub fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub fn is_number(&self) -> bool {
        matches!(self, Self::Number(_))
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub fn take(&mut self) -> Self {
        std::mem::replace(self, Self::Undefined)
    }
}
impl Default for JsValue {
    fn default() -> Self {
        Self::Undefined
    }
}
impl std::str::FromStr for JsValue {
    type Err = crate::error::Error;
    fn from_str(source: &str) -> Result<Self, Self::Err> {
        crate::js::json::parse_value(source)
    }
}
impl From<bool> for JsValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}
impl From<&JsText> for JsValue {
    fn from(value: &JsText) -> Self {
        Self::String(value.clone())
    }
}
impl From<&String> for JsValue {
    fn from(value: &String) -> Self {
        value.as_str().into()
    }
}
impl From<&JsValue> for JsValue {
    fn from(value: &JsValue) -> Self {
        value.clone()
    }
}
impl From<serde_json::Value> for JsValue {
    fn from(value: serde_json::Value) -> Self {
        Self::from_json(value)
    }
}
macro_rules! number {
    ($($kind:ty),*) => { $(impl From<$kind> for JsValue { fn from(value: $kind) -> Self { Self::Number(value as f64) } })* };
}
number!(f32, f64, i8, i16, i32, i64, i128, isize, u8, u16, u32, u64, u128, usize);
impl<T: Into<JsValue>> From<Vec<T>> for JsValue {
    fn from(value: Vec<T>) -> Self {
        Self::Array(value.into_iter().map(Into::into).collect())
    }
}
impl<T: Into<JsValue>, const N: usize> From<[T; N]> for JsValue {
    fn from(value: [T; N]) -> Self {
        Self::Array(value.into_iter().map(Into::into).collect())
    }
}
impl<K: Into<JsText>, V: Into<JsValue>> From<IndexMap<K, V>> for JsValue {
    fn from(value: IndexMap<K, V>) -> Self {
        Self::Object(
            value
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        )
    }
}
impl FromIterator<JsValue> for JsValue {
    fn from_iter<T: IntoIterator<Item = JsValue>>(items: T) -> Self {
        Self::Array(items.into_iter().collect())
    }
}
impl<K: Into<JsText>, V: Into<JsValue>> FromIterator<(K, V)> for JsValue {
    fn from_iter<T: IntoIterator<Item = (K, V)>>(items: T) -> Self {
        Self::Object(
            items
                .into_iter()
                .map(|(key, value)| (key.into(), value.into()))
                .collect(),
        )
    }
}

#[macro_export]
macro_rules! js_value {
    (null) => { $crate::js::value::JsValue::Null };
    (undefined) => { $crate::js::value::JsValue::Undefined };
    ([]) => { $crate::js::value::JsValue::Array(::std::vec::Vec::new()) };
    ({}) => { $crate::js::value::JsValue::Object($crate::js::value::JsObject::new()) };
    ([$($items:tt)*]) => {{
        let mut values = ::std::vec::Vec::new();
        $crate::js_value!(@array values; $($items)*);
        $crate::js::value::JsValue::Array(values)
    }};
    ({$($entries:tt)*}) => {{
        let mut object = $crate::js::value::JsObject::new();
        $crate::js_value!(@object object; $($entries)*);
        $crate::js::value::JsValue::Object(object)
    }};
    (@array $values:ident;) => {};
    (@array $values:ident; null $(, $($rest:tt)*)?) => { $values.push($crate::js_value!(null)); $($crate::js_value!(@array $values; $($rest)*);)? };
    (@array $values:ident; undefined $(, $($rest:tt)*)?) => { $values.push($crate::js_value!(undefined)); $($crate::js_value!(@array $values; $($rest)*);)? };
    (@array $values:ident; [$($items:tt)*] $(, $($rest:tt)*)?) => { $values.push($crate::js_value!([$($items)*])); $($crate::js_value!(@array $values; $($rest)*);)? };
    (@array $values:ident; {$($entries:tt)*} $(, $($rest:tt)*)?) => { $values.push($crate::js_value!({$($entries)*})); $($crate::js_value!(@array $values; $($rest)*);)? };
    (@array $values:ident; $value:expr $(, $($rest:tt)*)?) => { $values.push($crate::js::value::JsValue::from($value)); $($crate::js_value!(@array $values; $($rest)*);)? };
    (@object $object:ident;) => {};
    (@object $object:ident; $key:tt: null $(, $($rest:tt)*)?) => { $object.insert($crate::js::text::JsText::from($key), $crate::js_value!(null)); $($crate::js_value!(@object $object; $($rest)*);)? };
    (@object $object:ident; $key:tt: undefined $(, $($rest:tt)*)?) => { $object.insert($crate::js::text::JsText::from($key), $crate::js_value!(undefined)); $($crate::js_value!(@object $object; $($rest)*);)? };
    (@object $object:ident; $key:tt: [$($items:tt)*] $(, $($rest:tt)*)?) => { $object.insert($crate::js::text::JsText::from($key), $crate::js_value!([$($items)*])); $($crate::js_value!(@object $object; $($rest)*);)? };
    (@object $object:ident; $key:tt: {$($entries:tt)*} $(, $($rest:tt)*)?) => { $object.insert($crate::js::text::JsText::from($key), $crate::js_value!({$($entries)*})); $($crate::js_value!(@object $object; $($rest)*);)? };
    (@object $object:ident; $key:tt: $value:expr $(, $($rest:tt)*)?) => { $object.insert($crate::js::text::JsText::from($key), $crate::js::value::JsValue::from($value)); $($crate::js_value!(@object $object; $($rest)*);)? };
    ($value:expr) => { $crate::js::value::JsValue::from($value) };
}
