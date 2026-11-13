use crate::js::text::{JsText, JsTextBuilder};
use serde_json::Value;
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{Arc, OnceLock},
};

#[derive(Clone, Debug)]
pub struct ConfigError(pub String);
impl std::fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}
impl std::error::Error for ConfigError {}
type Result<T> = std::result::Result<T, ConfigError>;

struct TemplateSpec {
    id: TextId,
    text: &'static str,
    slots: &'static [&'static str],
}
struct ResourceSpec {
    id: ResourceId,
    source: &'static str,
}
include!(concat!(env!("OUT_DIR"), "/harness_catalog.rs"));

enum Segment {
    Literal(std::ops::Range<usize>),
    Slot(usize),
}
struct Template {
    source: Cow<'static, str>,
    slots: &'static [&'static str],
    segments: Vec<Segment>,
}
impl Template {
    fn compile(source: Cow<'static, str>, slots: &'static [&'static str]) -> Self {
        let mut segments = Vec::new();
        let mut offset = 0;
        while offset < source.len() {
            let next = slots
                .iter()
                .enumerate()
                .filter_map(|(index, slot)| {
                    source[offset..]
                        .find(&format!("{{{slot}}}"))
                        .map(|position| (offset + position, index, slot.len() + 2))
                })
                .min_by_key(|(position, _, _)| *position);
            if let Some((position, index, length)) = next {
                if position > offset {
                    segments.push(Segment::Literal(offset..position));
                }
                segments.push(Segment::Slot(index));
                offset = position + length;
            } else {
                segments.push(Segment::Literal(offset..source.len()));
                break;
            }
        }
        Self {
            source,
            slots,
            segments,
        }
    }
    fn render(&self, id: TextId, values: &[(&str, &str)]) -> String {
        assert_eq!(
            values.len(),
            self.slots.len(),
            "Harness arguments do not match {}",
            id.as_str()
        );
        let values: Vec<_> = self
            .slots
            .iter()
            .map(|slot| {
                values
                    .iter()
                    .find(|(name, _)| name == slot)
                    .map(|(_, value)| *value)
                    .unwrap_or_else(|| panic!("Missing Harness argument {}.{slot}", id.as_str()))
            })
            .collect();
        let mut result = String::with_capacity(
            self.source.len() + values.iter().map(|value| value.len()).sum::<usize>(),
        );
        for segment in &self.segments {
            match segment {
                Segment::Literal(range) => result.push_str(&self.source[range.clone()]),
                Segment::Slot(index) => result.push_str(values[*index]),
            }
        }
        result
    }
    fn render_text(&self, id: TextId, values: &[(&str, &JsText)]) -> JsText {
        assert_eq!(
            values.len(),
            self.slots.len(),
            "Harness arguments do not match {}",
            id.as_str()
        );
        let values: Vec<_> = self
            .slots
            .iter()
            .map(|slot| {
                values
                    .iter()
                    .find(|(name, _)| name == slot)
                    .map(|(_, value)| *value)
                    .unwrap_or_else(|| panic!("Missing Harness argument {}.{slot}", id.as_str()))
            })
            .collect();
        let mut result = JsTextBuilder::with_capacity(
            self.source.len()
                + values
                    .iter()
                    .map(|value| value.as_utf8().map_or(value.len(), str::len))
                    .sum::<usize>(),
        );
        for segment in &self.segments {
            match segment {
                Segment::Literal(range) => result.push_str(&self.source[range.clone()]),
                Segment::Slot(index) => result.push_text(values[*index]),
            }
        }
        result.finish()
    }
}
fn defaults(id: TextId) -> &'static Template {
    static CACHE: OnceLock<Vec<OnceLock<Template>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| TEMPLATE_SPECS.iter().map(|_| OnceLock::new()).collect());
    cache[id.index()].get_or_init(|| {
        let spec = &TEMPLATE_SPECS[id.index()];
        debug_assert_eq!(spec.id, id);
        Template::compile(Cow::Borrowed(spec.text), spec.slots)
    })
}
fn raw_resource(id: ResourceId) -> &'static Value {
    static CACHE: OnceLock<Vec<OnceLock<Value>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| RESOURCE_SPECS.iter().map(|_| OnceLock::new()).collect());
    cache[id.index()].get_or_init(|| {
        let spec = &RESOURCE_SPECS[id.index()];
        debug_assert_eq!(spec.id, id);
        serde_json::from_str(spec.source).expect("Harness resources were validated by the build")
    })
}
/// Borrows protocol text without applying model wording overrides.
pub fn fixed_text(id: ResourceId, path: &[&str]) -> &'static str {
    let mut value = raw_resource(id);
    for key in path {
        value = value.get(*key).unwrap_or_else(|| {
            panic!(
                "Unknown fixed Harness resource field: {}.{}",
                id.as_str(),
                path.join(".")
            )
        });
    }
    value.as_str().unwrap_or_else(|| {
        panic!(
            "Fixed Harness resource field must be a literal string: {}.{}",
            id.as_str(),
            path.join(".")
        )
    })
}
type Overrides = HashMap<TextId, Arc<Template>>;
struct ModelOverrides {
    templates: Arc<Overrides>,
    scope: String,
    resolved: OnceLock<Arc<ResolvedHarness>>,
}
pub struct Harness {
    common: Arc<Overrides>,
    models: HashMap<String, ModelOverrides>,
    resolved: OnceLock<Arc<ResolvedHarness>>,
}
pub struct ResolvedHarness {
    common: Arc<Overrides>,
    model: Arc<Overrides>,
    scope: String,
    resources: Vec<OnceLock<Value>>,
}
fn error(message: impl Into<String>) -> ConfigError {
    ConfigError(message.into())
}
fn parse_overrides(value: Option<&Value>) -> Result<Overrides> {
    let Some(value) = value.filter(|value| !crate::js::is_undefined(value)) else {
        return Ok(HashMap::new());
    };
    let object = value
        .as_object()
        .ok_or_else(|| error("Harness text overrides must be an object"))?;
    let mut result = HashMap::new();
    for (key, value) in object {
        let id = TextId::from_key(key)
            .ok_or_else(|| error(format!("Unknown Harness text identifier: {key}")))?;
        let text = value
            .as_str()
            .ok_or_else(|| error(format!("Harness text override must be a string: {key}")))?;
        let spec = &TEMPLATE_SPECS[id.index()];
        for slot in spec.slots {
            if !text.contains(&format!("{{{slot}}}")) {
                return Err(error(format!(
                    "Harness text override is missing {{{slot}}}: {key}"
                )));
            }
        }
        result.insert(
            id,
            Arc::new(Template::compile(Cow::Owned(text.into()), spec.slots)),
        );
    }
    Ok(result)
}
fn default_harness() -> Arc<Harness> {
    static VALUE: OnceLock<Arc<Harness>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            Arc::new(Harness {
                common: Arc::new(HashMap::new()),
                models: HashMap::new(),
                resolved: OnceLock::new(),
            })
        })
        .clone()
}
pub fn catalog() -> Value {
    serde_json::json!(TEMPLATE_SPECS
        .iter()
        .map(|spec| serde_json::json!({"id":spec.id.as_str(),"text":spec.text,"slots":spec.slots}))
        .collect::<Vec<_>>())
}
pub fn baseline() -> Arc<ResolvedHarness> {
    static VALUE: OnceLock<Arc<ResolvedHarness>> = OnceLock::new();
    VALUE
        .get_or_init(|| {
            Arc::new(ResolvedHarness {
                common: Arc::new(HashMap::new()),
                model: Arc::new(HashMap::new()),
                scope: String::new(),
                resources: RESOURCE_SPECS.iter().map(|_| OnceLock::new()).collect(),
            })
        })
        .clone()
}
impl Harness {
    pub fn from_config(config: &Value) -> Result<Arc<Self>> {
        if config.is_null() || crate::js::is_undefined(config) {
            return Ok(default_harness());
        }
        let config = config
            .as_object()
            .ok_or_else(|| error("Harness text configuration must be an object"))?;
        if config
            .keys()
            .any(|key| !["templates", "models"].contains(&key.as_str()))
        {
            return Err(error("Unknown Harness text configuration field"));
        }
        let common = Arc::new(parse_overrides(config.get("templates"))?);
        let mut models = HashMap::new();
        if let Some(value) = config
            .get("models")
            .filter(|value| !crate::js::is_undefined(value))
        {
            let value = value
                .as_object()
                .ok_or_else(|| error("Harness model overrides must be an object"))?;
            for (model, overrides) in value {
                models.insert(
                    model.clone(),
                    ModelOverrides {
                        templates: Arc::new(parse_overrides(Some(overrides))?),
                        scope: format!("model:{model}"),
                        resolved: OnceLock::new(),
                    },
                );
            }
        }
        if common.is_empty() && models.values().all(|values| values.templates.is_empty()) {
            return Ok(default_harness());
        }
        Ok(Arc::new(Self {
            common,
            models,
            resolved: OnceLock::new(),
        }))
    }
    pub fn for_model(self: &Arc<Self>, model: &str) -> Arc<ResolvedHarness> {
        let selected = self
            .models
            .get(model)
            .filter(|selected| !selected.templates.is_empty());
        if self.common.is_empty() && selected.is_none() {
            return baseline();
        }
        let cache = selected
            .map(|selected| &selected.resolved)
            .unwrap_or(&self.resolved);
        cache
            .get_or_init(|| {
                Arc::new(ResolvedHarness {
                    common: self.common.clone(),
                    scope: selected.map(|selected| selected.scope.clone()).unwrap_or_default(),
                    model: selected
                        .map(|selected| selected.templates.clone())
                        .unwrap_or_else(|| Arc::new(HashMap::new())),
                    resources: RESOURCE_SPECS.iter().map(|_| OnceLock::new()).collect(),
                })
            })
            .clone()
    }
}
impl ResolvedHarness {
    pub fn scope(&self) -> &str { &self.scope }
    fn template(&self, id: TextId) -> &Template {
        self.model
            .get(&id)
            .or_else(|| self.common.get(&id))
            .map(Arc::as_ref)
            .unwrap_or_else(|| defaults(id))
    }
    pub fn text(&self, id: TextId) -> &str {
        let template = self.template(id);
        assert!(
            template.slots.is_empty(),
            "Dynamic Harness template needs render: {}",
            id.as_str()
        );
        &template.source
    }
    pub fn render(&self, id: TextId, values: &[(&str, &str)]) -> String {
        self.template(id).render(id, values)
    }
    pub fn render_text(&self, id: TextId, values: &[(&str, &JsText)]) -> JsText {
        self.template(id).render_text(id, values)
    }
    pub fn resource(&self, id: ResourceId) -> Value {
        self.resources[id.index()]
            .get_or_init(|| self.materialize(raw_resource(id)))
            .clone()
    }
    fn materialize(&self, value: &Value) -> Value {
        match value {
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.materialize(item)).collect())
            }
            Value::Object(object) if object.len() == 1 && object.contains_key("$harness") => {
                let id = TextId::from_key(
                    object["$harness"]
                        .as_str()
                        .expect("Validated Harness reference"),
                )
                .expect("Validated Harness identifier");
                Value::String(self.text(id).into())
            }
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), self.materialize(value)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }
}

impl serde::Serialize for TextId {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}
impl<'de> serde::Deserialize<'de> for TextId {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        let key = <String as serde::Deserialize>::deserialize(deserializer)?;
        Self::from_key(&key).ok_or_else(|| {
            serde::de::Error::custom(format!("Unknown Harness text identifier: {key}"))
        })
    }
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Message {
    Data {
        text: String,
    },
    Template {
        id: TextId,
        values: Vec<(String, Message)>,
    },
}
impl Message {
    pub fn template(id: TextId, values: &[(&str, Message)]) -> Self {
        Self::Template {
            id,
            values: values
                .iter()
                .map(|(key, value)| ((*key).into(), value.clone()))
                .collect(),
        }
    }
    pub fn is_valid(&self) -> bool {
        match self {
            Self::Data { .. } => true,
            Self::Template { id, values } => {
                let slots = TEMPLATE_SPECS[id.index()].slots;
                values.len() == slots.len()
                    && slots
                        .iter()
                        .all(|slot| values.iter().filter(|(name, _)| name == slot).count() == 1)
                    && values.iter().all(|(_, value)| value.is_valid())
            }
        }
    }
    pub fn render(&self, harness: &ResolvedHarness) -> String {
        match self {
            Self::Data { text } => text.clone(),
            Self::Template { id, values } => {
                let values: Vec<_> = values
                    .iter()
                    .map(|(key, value)| (key.as_str(), value.render(harness)))
                    .collect();
                harness.render(
                    *id,
                    &values
                        .iter()
                        .map(|(key, value)| (*key, value.as_str()))
                        .collect::<Vec<_>>(),
                )
            }
        }
    }
}
impl From<String> for Message {
    fn from(text: String) -> Self {
        Self::Data { text }
    }
}
impl From<&str> for Message {
    fn from(text: &str) -> Self {
        Self::Data { text: text.into() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn every_baseline_template_renders_opaque_values_without_reinterpreting_them() {
        let harness = baseline();
        for spec in TEMPLATE_SPECS {
            let values: Vec<_> = spec
                .slots
                .iter()
                .map(|slot| (*slot, "{not_a_template}\n😀"))
                .collect();
            let rendered = harness.render(spec.id, &values);
            if spec.slots.is_empty() {
                assert_eq!(rendered, spec.text);
                assert_eq!(harness.text(spec.id), spec.text);
            } else {
                assert!(rendered.contains("{not_a_template}\n😀"));
            }
        }
    }
    #[test]
    fn typed_rendering_preserves_opaque_utf16_slots_and_the_existing_utf8_output() {
        let harness = baseline();
        let ordinary = JsText::from("{not_a_template}\n😀");
        let opaque = JsText::from_utf16(
            "{reason}\n"
                .encode_utf16()
                .chain([0xd800])
                .collect::<Vec<_>>(),
        );
        for spec in TEMPLATE_SPECS {
            let ordinary_values: Vec<_> =
                spec.slots.iter().map(|slot| (*slot, &ordinary)).collect();
            let previous_values: Vec<_> = spec
                .slots
                .iter()
                .map(|slot| (*slot, ordinary.as_utf8().unwrap()))
                .collect();
            assert_eq!(
                harness.render_text(spec.id, &ordinary_values).as_utf8(),
                Some(harness.render(spec.id, &previous_values).as_str()),
                "{}",
                spec.id.as_str()
            );
            let opaque_values: Vec<_> = spec.slots.iter().map(|slot| (*slot, &opaque)).collect();
            let rendered = harness.render_text(spec.id, &opaque_values);
            if !spec.slots.is_empty() {
                assert!(
                    rendered.quote_json().contains("{reason}\\n\\ud800"),
                    "{}",
                    spec.id.as_str()
                );
                let value = crate::js_value!({"content": rendered});
                let restored = crate::js::wire::WireDocument::encode(&value)
                    .decode()
                    .unwrap();
                assert_eq!(value, restored);
            }
        }
        let adjacent = Template::compile(Cow::Borrowed("{first}{second}"), &["first", "second"]);
        let high = JsText::from_utf16(vec![0xd83d]);
        let low = JsText::from_utf16(vec![0xde00]);
        assert_eq!(
            adjacent
                .render_text(TEMPLATE_SPECS[0].id, &[("first", &high), ("second", &low)])
                .as_utf8(),
            Some("😀")
        );
        let config = Harness::from_config(&serde_json::json!({"templates":{"permissions.denied_reason":"Default: {reason}"},"models":{"fixture":{"permissions.denied_reason":"Selected: {reason}"}}})).unwrap();
        assert_eq!(
            config
                .for_model("fixture")
                .render_text(TextId::PermissionsDeniedReason, &[("reason", &opaque)])
                .quote_json(),
            "\"Selected: {reason}\\n\\ud800\""
        );
    }
    #[test]
    fn overrides_are_model_scoped_and_invalid_configuration_is_rejected_before_execution() {
        let config=Harness::from_config(&json!({"templates":{"permissions.denied_reason":"Denied: {reason}"},"models":{"fixture":{"permissions.denied_reason":"Refused: {reason}"}}})).unwrap();
        let fixture = config.for_model("fixture");
        let other = config.for_model("other");
        assert!(Arc::ptr_eq(&fixture, &config.for_model("fixture")));
        assert!(Arc::ptr_eq(&other, &config.for_model("another model")));
        assert_eq!(
            fixture.render(
                TextId::PermissionsDeniedReason,
                &[("reason", "check {scope}")]
            ),
            "Refused: check {scope}"
        );
        assert_eq!(
            other.render(TextId::PermissionsDeniedReason, &[("reason", "check")]),
            "Denied: check"
        );
        assert_eq!(
            baseline().render(TextId::PermissionsDeniedReason, &[("reason", "check")]),
            "Permission denied: check"
        );
        assert!(Harness::from_config(
            &json!({"templates":{"permissions.denied_reason":"missing reason"}})
        )
        .is_err());
        assert!(
            Harness::from_config(&json!({"models":{"fixture":{"unknown.id":"text"}}})).is_err()
        );
    }
    #[test]
    fn resources_materialize_known_language_without_changing_schema_structure() {
        let harness = baseline();
        for spec in RESOURCE_SPECS {
            let resource = harness.resource(spec.id);
            let text = crate::js::stringify(&resource);
            assert!(!text.contains("\"$harness\":"));
        }
    }
    #[test]
    fn fixed_protocol_text_is_borrowed_and_rejects_wording_resources() {
        let reason = fixed_text(ResourceId::McpProtocol, &["cancelled_reason"]);
        assert_eq!(reason, "Caller cancelled the tool request");
        assert!(std::ptr::eq(
            reason,
            fixed_text(ResourceId::McpProtocol, &["cancelled_reason"])
        ));
        assert_eq!(
            fixed_text(ResourceId::McpProtocol, &["method_not_found_prefix"]),
            "Method not found: "
        );
        assert!(std::panic::catch_unwind(|| fixed_text(ResourceId::McpProtocol, &["missing"])).is_err());
        assert!(
            std::panic::catch_unwind(|| fixed_text(ResourceId::SkillProtocol, &["invocation"]))
                .is_err()
        );
        assert!(std::panic::catch_unwind(|| fixed_text(
            ResourceId::CodeSearchDefinition,
            &["description"]
        ))
        .is_err());
        assert!(Harness::from_config(
            &json!({"templates":{"commands.skill_wrapper":"changed protocol"}})
        )
        .is_err());
    }
}
