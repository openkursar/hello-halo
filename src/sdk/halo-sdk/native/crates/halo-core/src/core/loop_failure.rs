use crate::{error::Error, js::number};
use serde_json::{json, Value};

pub struct ProviderFailure {
    pub status: Option<f64>,
    pub retryable: bool,
    pub retries_exhausted: bool,
    pub model_fallback: bool,
}
pub fn status(error: &Error) -> Option<f64> {
    let details = error.details.as_ref()?;
    details
        .get("statusCode")
        .filter(|value| !value.is_null() && !crate::js::is_undefined(value))
        .or_else(|| details.get("status"))
        .and_then(number)
}
pub fn classify(status: Option<f64>) -> &'static str {
    match status {
        Some(401.0 | 403.0) => "authentication_failed",
        Some(402.0) => "billing_error",
        Some(429.0) => "rate_limit",
        Some(400.0 | 422.0) => "invalid_request",
        Some(status) if status >= 500.0 => "server_error",
        _ => "unknown",
    }
}
pub fn provider(error: &Error) -> Option<ProviderFailure> {
    let details = error.details.as_ref().unwrap_or(&Value::Null);
    let status = status(error);
    let branded = error.code == "PROVIDER_ERROR"
        || details["name"] == "ProviderError"
        || details["name"] == "ModelFallbackError";
    let network = [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "EAI_AGAIN",
        "EPIPE",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
    ]
    .contains(&error.code.as_str())
        || details["name"] == "TypeError" && error.message.to_lowercase() == "fetch failed";
    if !branded && status.is_none() && !network {
        return None;
    }
    Some(ProviderFailure {
        status,
        retryable: if branded {
            details["retryable"].as_bool().unwrap_or(false)
        } else {
            network
                || status.is_some_and(|status| {
                    status.is_finite()
                        && status.fract() == 0.0
                        && status >= 0.0
                        && status <= u16::MAX as f64
                        && crate::retry::retryable_status(status as u16)
                })
        },
        retries_exhausted: branded && details["retriesExhausted"] == true,
        model_fallback: details["name"] == "ModelFallbackError",
    })
}
pub fn invalid_thinking(error: &Error) -> bool {
    if status(error).is_some_and(|status| status != 400.0) {
        return false;
    }
    let message = error.message.to_lowercase();
    message.contains("signature") && message.contains("thinking")
}
pub fn retry_event(session: &str, attempt: u32, delay: f64, error: &Error) -> Value {
    let status = status(error);
    let mut event = json!({"type":"system","subtype":"api_retry","attempt":attempt,"max_retries":crate::retry::MAX_RETRIES,"retry_delay_ms":delay.round(),"error_status":status,"error":classify(status),"session_id":session,"uuid":uuid::Uuid::new_v4().to_string()});
    if !error.message.is_empty() {
        event["error_message"] = json!(error.message);
    }
    event
}
pub fn flag(error: &mut Error, name: &str, value: Value) {
    if error
        .details
        .as_ref()
        .is_none_or(|details| !details.is_object())
    {
        error.details = Some(json!({}));
    }
    error.details.as_mut().unwrap()[name] = value;
}
