use super::{parse_domain, Domain, JsonSyntaxError, ParseFailure};
use crate::{
    error::Result,
    js::{
        text::{JsText, JsTextView},
        value::{JsObject, JsValue},
    },
};
use std::convert::Infallible;

struct ValueDomain<const DEPTH: usize>;
impl<const DEPTH: usize> Domain for ValueDomain<DEPTH> {
    type Value = JsValue;
    type Text = JsText;
    type Object = JsObject;
    type Error = Infallible;
    fn max_depth() -> usize { DEPTH }
    fn null() -> JsValue {
        JsValue::Null
    }
    fn boolean(value: bool) -> JsValue {
        JsValue::Bool(value)
    }
    fn number(value: f64) -> JsValue {
        JsValue::Number(value)
    }
    fn text(units: Vec<u16>) -> std::result::Result<JsText, Infallible> {
        Ok(JsText::from_utf16(units))
    }
    fn string(value: JsText) -> JsValue {
        value.into()
    }
    fn array(value: Vec<JsValue>) -> JsValue {
        JsValue::Array(value)
    }
    fn new_object() -> JsObject {
        JsObject::new()
    }
    fn insert(object: &mut JsObject, key: JsText, value: JsValue) {
        object.insert(key, value);
    }
    fn object(value: JsObject) -> JsValue {
        JsValue::Object(value)
    }
}

pub fn parse_value(source: &str) -> Result<JsValue> {
    parse_text(JsTextView::Utf8(source)).map_err(JsonSyntaxError::into_legacy_error)
}

pub fn parse_text(source: JsTextView<'_>) -> std::result::Result<JsValue, JsonSyntaxError> {
    parse_domain::<ValueDomain<{ usize::MAX }>>(source).map_err(|error| match error {
        ParseFailure::Syntax(error) => error,
        ParseFailure::Domain(error) => match error {},
    })
}

pub(crate) fn parse_data(source: &str) -> Result<serde_json::Value> {
    let value = parse_domain::<ValueDomain<128>>(JsTextView::Utf8(source)).map_err(|error| match error {
        ParseFailure::Syntax(error) => error.into_legacy_error(),
        ParseFailure::Domain(error) => match error {},
    })?;
    value.try_into_json().map_err(|_| crate::error::Error::template(
        "JSON_DOMAIN", crate::harness::TextId::ProvidersJsonUnsupportedData, &[],
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn model_json_keeps_literal_markers_and_node_number_semantics() {
        let value = parse_data(r#"{"__haloSdkNativeUndefined":true,"nested":{"__haloSdkNativeNumber":"NaN"},"integer":9007199254740993,"zero":-0}"#).unwrap();
        assert_eq!(value["__haloSdkNativeUndefined"], true);
        assert_eq!(value["nested"]["__haloSdkNativeNumber"], "NaN");
        assert_eq!(value["integer"].as_f64(), Some(9_007_199_254_740_992.0));
        assert!(value["zero"].as_f64().unwrap().is_sign_negative());
        assert!(!parse_data("-0").unwrap().is_object());
    }
    #[test]
    fn model_json_refuses_unrepresentable_and_excessively_nested_data() {
        for source in [r#"{"value":"\ud800"}"#, r#"{"value":1e309}"#] {
            assert_eq!(parse_data(source).unwrap_err().code, "JSON_DOMAIN");
        }
        let source = "[".repeat(256) + "0" + &"]".repeat(256);
        assert!(parse_data(&source).unwrap_err().message.contains("nesting"));
    }
    #[test]
    fn typed_json_parser_matches_node_syntax_fixtures() {
        let fixture: Value = serde_json::from_str(include_str!("fixtures/json.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let result = parse_value(case["source"].as_str().unwrap());
            if let Some(reason) = case["error"].as_str() {
                assert_eq!(result.unwrap_err().message, reason, "{}", case["source"]);
            } else {
                assert_eq!(
                    result.unwrap().stringify().as_deref(),
                    case["result"].as_str(),
                    "{}",
                    case["source"]
                );
            }
        }
    }
    #[test]
    fn typed_json_strings_keys_and_float64_values_match_node_without_marker_inference() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/node-values.json")).unwrap();
        for case in fixture["texts"].as_array().unwrap() {
            let value = parse_value(case["quote"].as_str().unwrap()).unwrap();
            let expected: Vec<_> = case["units"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_u64().unwrap() as u16)
                .collect();
            assert_eq!(
                value.as_text().unwrap().units().collect::<Vec<_>>(),
                expected
            );
        }
        for case in fixture["values"].as_array().unwrap() {
            if let Some(source) = case["json"].as_str() {
                assert_eq!(
                    parse_value(source).unwrap().stringify().as_deref(),
                    Some(source),
                    "{}",
                    case["name"]
                );
            }
        }
        let value = r#"{"\ud800":"\udfff","same":1,"same":2,"__proto__":{"safe":true},"__haloSdkNativeUndefined":true}"#.parse::<JsValue>().unwrap();
        assert_eq!(
            value
                .get(&JsText::from_utf16(vec![0xd800]))
                .unwrap()
                .as_text()
                .unwrap()
                .units()
                .collect::<Vec<_>>(),
            vec![0xdfff]
        );
        assert_eq!(value.get("same").unwrap().as_number(), Some(2.0));
        assert_eq!(
            value.get("__haloSdkNativeUndefined").unwrap().as_bool(),
            Some(true)
        );
        assert_eq!(
            parse_value("1e10000").unwrap().as_number(),
            Some(f64::INFINITY)
        );
        assert_eq!(
            parse_value("-0").unwrap().as_number().unwrap().to_bits(),
            (-0.0_f64).to_bits()
        );
        assert_eq!(
            parse_value("1794339331661.0015")
                .unwrap()
                .as_number()
                .unwrap()
                .to_bits(),
            1794339331661.0015_f64.to_bits()
        );
    }

    #[test]
    fn typed_source_keeps_raw_lone_units_and_syntax_context() {
        let source = [123, 34, 0xd800, 34, 58, 34, 0xdfff, 34, 125];
        let value = parse_text(JsTextView::Utf16(&source)).unwrap();
        assert_eq!(
            value
                .get(&JsText::from_utf16(vec![0xd800]))
                .unwrap()
                .as_text()
                .unwrap()
                .units()
                .collect::<Vec<_>>(),
            [0xdfff]
        );

        let source = [34, 0xd800, 34, 32, 120];
        let error = parse_text(JsTextView::Utf16(&source)).unwrap_err();
        assert_eq!(
            error.template,
            crate::harness::TextId::ProvidersJsonSyntaxNonWhitespace
        );
        assert_eq!(
            error
                .slots
                .iter()
                .find(|(name, _)| *name == "position")
                .unwrap()
                .1
                .as_utf8(),
            Some("4")
        );

        for source in [vec![0xd800], vec![0xd83d, 0xde00], vec![97, 0xd800, 98]] {
            let error = parse_text(JsTextView::Utf16(&source)).unwrap_err();
            assert_eq!(
                error
                    .slots
                    .iter()
                    .find(|(name, _)| *name == "token")
                    .unwrap()
                    .1
                    .units()
                    .collect::<Vec<_>>(),
                [source[0]]
            );
            assert_eq!(
                error
                    .slots
                    .iter()
                    .find(|(name, _)| *name == "context")
                    .unwrap()
                    .1
                    .units()
                    .collect::<Vec<_>>(),
                source
            );
            assert_eq!(error.into_legacy_error().code, "UNSUPPORTED_JSON_ENCODING");
        }
    }
}
