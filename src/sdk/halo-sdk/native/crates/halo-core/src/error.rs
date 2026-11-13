use crate::js::{text::JsText, value::JsValue};
use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<crate::harness::Message>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "crate::js::wire::optional_data"
    )]
    pub host_data: Option<JsValue>,
}

impl Error {
    pub fn template(
        code: impl Into<String>,
        id: crate::harness::TextId,
        values: &[(&str, crate::harness::Message)],
    ) -> Self {
        Self::new(code, String::new()).with_harness(id, values)
    }
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
            harness: None,
            host_data: None,
        }
    }

    pub fn cancelled() -> Self {
        Self::new("ABORTED", "Operation was aborted")
    }

    pub fn is_abort(&self) -> bool {
        self.code == "ABORTED"
            || self.code == "ABORT_ERR"
            || self.details.as_ref().is_some_and(|details| {
                details["name"] == "AbortError" || details["name"] == "APIUserAbortError"
            })
    }
    pub fn with_details(mut self, details: serde_json::Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn with_harness(
        mut self,
        id: crate::harness::TextId,
        values: &[(&str, crate::harness::Message)],
    ) -> Self {
        let text = crate::harness::Message::template(id, values);
        self.message = text.render(&crate::harness::baseline());
        self.harness = Some(text);
        self
    }
    pub fn render_for(&self, harness: &crate::harness::ResolvedHarness) -> String {
        self.harness
            .as_ref()
            .filter(|text| text.is_valid())
            .map(|text| text.render(harness))
            .unwrap_or_else(|| self.message.clone())
    }
    pub fn render_text_for(&self, harness: &crate::harness::ResolvedHarness) -> JsText {
        if let Some(text) = self.harness.as_ref().filter(|text| text.is_valid()) {
            return text.render(harness).into();
        }
        self.host_data
            .as_ref()
            .and_then(|data| data.get("message"))
            .and_then(JsValue::as_text)
            .cloned()
            .unwrap_or_else(|| self.message.as_str().into())
    }

    pub fn new_text(code: impl Into<String>, message: JsText) -> Self {
        if let Some(message) = message.as_utf8() {
            return Self::new(code, message);
        }
        let mut error = Self::new(code, "Error text requires the lossless data boundary");
        error.host_data = Some(crate::js_value!({ "message": message }));
        error
    }
    pub fn display_for(&self, harness: &crate::harness::ResolvedHarness) -> String {
        if self.harness.is_none() {
            if let Some(value) = self
                .details
                .as_ref()
                .and_then(|details| details["stringValue"].as_str())
            {
                return value.into();
            }
        }
        let name = self
            .details
            .as_ref()
            .and_then(|details| details["name"].as_str())
            .unwrap_or("Error");
        let message = self.render_for(harness);
        if name.is_empty() {
            message
        } else if message.is_empty() {
            name.into()
        } else {
            harness.render(
                crate::harness::TextId::ContextErrorsNamed,
                &[("name", name), ("message", &message)],
            )
        }
    }
    pub fn as_harness_message(&self) -> crate::harness::Message {
        self.harness
            .clone()
            .filter(crate::harness::Message::is_valid)
            .unwrap_or_else(|| self.message.clone().into())
    }
    pub fn from_host(value: serde_json::Value) -> Self {
        let mut error = Self::new(
            value["code"].as_str().unwrap_or("HOST_CALLBACK"),
            value["message"].as_str().unwrap_or("Host callback failed"),
        );
        if let Some(text) = value.get("harness") {
            match serde_json::from_value::<crate::harness::Message>(text.clone()) {
                Ok(text) if text.is_valid() => error.harness = Some(text),
                _ => {
                    tracing::warn!(code=%error.code,"Invalid structured Harness error metadata; retaining host error text")
                }
            }
        }
        error.details = Some(value);
        error
    }

    pub fn from_host_data(value: JsValue) -> Self {
        let mut metadata = serde_json::Map::new();
        if let Some(fields) = value.as_object() {
            for (key, value) in fields {
                if let (Some(key), Ok(value)) = (key.as_utf8(), value.clone().try_into_json()) {
                    metadata.insert(key.into(), value);
                }
            }
        }
        let mut error = Self::from_host(serde_json::Value::Object(metadata));
        error.host_data = Some(value);
        error
    }
}

impl From<crate::harness::ConfigError> for Error {
    fn from(error: crate::harness::ConfigError) -> Self {
        Self::new("INVALID_HARNESS_TEXT", error.0)
            .with_details(serde_json::json!({"name":"TypeError"}))
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::new("INVALID_JSON", error.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_data_preserves_text_and_values_without_interpreting_payload_keys() {
        let text = JsText::from_utf16(vec![0x61, 0xd800, 0, 0x62]);
        let data = crate::js_value!({
            "name": "ProviderError",
            "message": text.clone(),
            "status": 429,
            "retryable": true,
            "errorRef": 7,
            "extra": {
                "__haloSdkNativeUndefined": false,
                "__haloSdkNativeNumber": "NaN",
                "missing": undefined
            }
        });
        let error = Error::from_host_data(data.clone());
        assert_eq!(error.render_text_for(&crate::harness::baseline()), text);
        let metadata = error.details.as_ref().unwrap();
        assert_eq!(metadata["status"], 429);
        assert_eq!(metadata["retryable"], true);
        assert_eq!(metadata["errorRef"], 7);
        let encoded = serde_json::to_string(&error).unwrap();
        let restored: Error = serde_json::from_str(&encoded).unwrap();
        assert_eq!(restored.host_data, Some(data));
        assert_eq!(restored.render_text_for(&crate::harness::baseline()), text);
    }

    #[test]
    fn generated_text_errors_keep_unpaired_units_through_the_error_transport() {
        let text = JsText::from_utf16(vec![0xdc00]);
        let error = Error::new_text("MCP_INITIALIZE", text.clone());
        let restored: Error = serde_json::from_value(serde_json::to_value(error).unwrap()).unwrap();
        assert_eq!(restored.code, "MCP_INITIALIZE");
        assert_eq!(restored.render_text_for(&crate::harness::baseline()), text);
        let ordinary = Error::new_text("MCP_INITIALIZE", "ordinary".into());
        assert!(ordinary.host_data.is_none());
        assert_eq!(ordinary.message, "ordinary");
    }
}
