use super::{
    text::JsText,
    value::{JsObject, JsValue, JsonIncompatibility},
    wire::{WireDocument, WireError},
};
use serde_json::{json, Value};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/node-values.json")).unwrap()
}
fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|value| value.as_u64().unwrap() as u16)
        .collect()
}
fn number(value: &Value) -> f64 {
    value
        .as_f64()
        .unwrap_or_else(|| match value.as_str().unwrap() {
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "NaN" => f64::NAN,
            _ => unreachable!(),
        })
}

#[test]
fn text_units_slices_trimming_and_json_quotes_match_node_without_replacement_characters() {
    let fixture = fixture();
    let mut sorted = Vec::new();
    for case in fixture["texts"].as_array().unwrap() {
        let text = JsText::from_utf16(units(&case["units"]));
        assert_eq!(text.len(), case["length"].as_u64().unwrap() as usize);
        assert_eq!(
            text.as_utf8().is_some(),
            case["wellFormed"].as_bool().unwrap()
        );
        assert_eq!(text.quote_json(), case["quote"].as_str().unwrap());
        assert_eq!(
            text.trim().units().collect::<Vec<_>>(),
            units(&case["trimmed"])
        );
        for slice in case["slices"].as_array().unwrap() {
            let sliced = text.slice(number(&slice["start"]), slice.get("end").map(number));
            assert_eq!(sliced.units().collect::<Vec<_>>(), units(&slice["units"]));
            assert_eq!(sliced.quote_json(), slice["quote"].as_str().unwrap());
        }
        sorted.push(text);
    }
    sorted.sort();
    assert_eq!(
        sorted
            .iter()
            .map(|text| text.units().collect::<Vec<_>>())
            .collect::<Vec<_>>(),
        fixture["sorted"]
            .as_array()
            .unwrap()
            .iter()
            .map(units)
            .collect::<Vec<_>>()
    );
    let parts: Vec<_> = fixture["concat"]["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| JsText::from_utf16(units(part)))
        .collect();
    let combined = JsText::concat(&parts.iter().collect::<Vec<_>>());
    assert_eq!(combined.as_utf8(), Some("😀"));
    assert_eq!(
        combined.quote_json(),
        fixture["concat"]["quote"].as_str().unwrap()
    );
}

#[test]
fn explicit_wire_metadata_roundtrips_real_extensions_while_literal_objects_remain_objects() {
    for case in fixture()["values"].as_array().unwrap() {
        let value = WireDocument::from_json(case["wire"].clone())
            .unwrap()
            .decode()
            .unwrap();
        assert_eq!(
            value.stringify(),
            case["json"].as_str().map(String::from),
            "{}",
            case["name"]
        );
        assert_eq!(
            value.truthy(),
            case["truthy"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        let roundtrip = WireDocument::encode(&value).decode().unwrap();
        assert!(value.same_value(&roundtrip), "{}", case["name"]);
        assert_eq!(
            WireDocument::encode(&value).to_json_string(),
            super::data::stringify(&case["wire"]),
            "{}",
            case["name"]
        );
    }
    let literal = json!({"__haloSdkNativeUndefined":true,"__haloSdkNativeNumber":"NaN","extra":1});
    let value = JsValue::from_json(literal.clone());
    assert!(matches!(value, JsValue::Object(_)));
    assert_eq!(
        super::data::stringify(&value.clone().try_into_json().unwrap()),
        super::data::stringify(&literal)
    );
    assert!(WireDocument::encode(&value).to_json()["extensions"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn legacy_json_conversion_refuses_values_it_cannot_preserve() {
    for (value, reason) in [
        (JsValue::Undefined, JsonIncompatibility::Undefined),
        (
            JsValue::Number(f64::NAN),
            JsonIncompatibility::NonFiniteNumber,
        ),
        (
            JsText::from_utf16(vec![0xd800]).into(),
            JsonIncompatibility::Utf16Text,
        ),
        (
            JsValue::Callback("callback".into()),
            JsonIncompatibility::Callback,
        ),
        (JsValue::Signal, JsonIncompatibility::Signal),
    ] {
        assert_eq!(value.try_into_json().unwrap_err().reason, reason);
    }
    let mut object = JsObject::new();
    object.insert(JsText::from_utf16(vec![0xdc00]), JsValue::Null);
    assert_eq!(
        JsValue::Object(object).try_into_json().unwrap_err().reason,
        JsonIncompatibility::Utf16Key
    );
    let negative = JsValue::Number(-0.0).try_into_json().unwrap();
    assert!(negative.as_f64().unwrap().is_sign_negative());
    let ordinary = JsValue::from_json(json!({"key":"value"}));
    assert_eq!(
        ordinary.as_object().unwrap().get("key"),
        Some(&JsValue::from("value"))
    );
}

#[test]
fn malformed_extension_paths_never_overwrite_literal_data() {
    let decode = |value| WireDocument::from_json(value).and_then(WireDocument::decode);
    assert_eq!(
        decode(json!({"version":2,"data":null,"extensions":[]})),
        Err(WireError::Version(2))
    );
    assert_eq!(
        decode(
            json!({"version":1,"data":{"a":1},"extensions":[{"kind":"undefined","path":["a"]}]})
        ),
        Err(WireError::NonNullPlaceholder)
    );
    assert_eq!(
        decode(
            json!({"version":1,"data":{},"extensions":[{"kind":"signal","path":["__proto__"]}]})
        ),
        Err(WireError::MissingPath)
    );
    assert_eq!(
        decode(
            json!({"version":1,"data":[null],"extensions":[{"kind":"undefined","path":[0]},{"kind":"signal","path":[0]}]})
        ),
        Err(WireError::DuplicatePath)
    );
    assert_eq!(
        decode(
            json!({"version":1,"data":null,"extensions":[{"kind":"undefined","path":[]},{"kind":"signal","path":[0]}]})
        ),
        Err(WireError::OverlappingPath)
    );
    assert!(matches!(
        decode(
            json!({"version":1,"data":null,"extensions":[{"kind":"text16","path":[],"units":[65536]}]})
        ),
        Err(WireError::Schema(_))
    ));
    assert_eq!(
        decode(
            json!({"version":1,"data":null,"extensions":[{"kind":"object16","path":[],"entries":[{"key":"a","value":{"version":1,"data":1,"extensions":[]}},{"key":[97],"value":{"version":1,"data":2,"extensions":[]}}]}]})
        ),
        Err(WireError::DuplicateObjectKey)
    );
}

#[test]
fn typed_construction_keeps_missing_properties_distinct_and_carries_opaque_values() {
    use super::value::PathPart;
    let key = JsText::from_utf16(vec![0xd800]);
    let text = JsText::from_utf16(vec![0xdc00]);
    let mut value = crate::js_value!({
        "literal": { "__haloSdkNativeUndefined": true },
        (&key): [undefined, null, -0.0, f64::NAN, &text],
        "ownUndefined": undefined,
        "emptyArray": [],
        "emptyObject": {},
        "timestamp": 1794339331661.0015_f64,
    });
    assert!(value.get("missing").is_none());
    assert!(value.get("ownUndefined").unwrap().is_undefined());
    let path = [PathPart::Key(key.clone()), PathPart::Index(4)];
    assert_eq!(value.get_path(&path).unwrap().as_text(), Some(&text));
    *value.get_path_mut(&path).unwrap() = crate::js_value!({"opaque": &text});
    assert_eq!(WireDocument::encode(&value).decode().unwrap(), value);
    assert_eq!(
        value.get("timestamp").unwrap().as_f64().unwrap().to_bits(),
        1794339331661.0015_f64.to_bits()
    );
    let entries: JsValue = [
        (key.clone(), value.get(&key).unwrap().clone()),
        (
            JsText::from("literal"),
            crate::js_value!({"__haloSdkNativeNumber":"NaN"}),
        ),
    ]
    .into_iter()
    .collect();
    let mut object = entries.as_object().unwrap().clone();
    assert!(object.shift_remove(&key).is_some());
    assert_eq!(
        JsValue::from(object).stringify().unwrap(),
        "{\"literal\":{\"__haloSdkNativeNumber\":\"NaN\"}}"
    );
    assert_eq!(JsValue::from([1, 2, 3]).stringify().unwrap(), "[1,2,3]");
    assert_eq!(JsValue::Number(18_446_744_073_709_551_616.0).as_u64(), None);
    assert_eq!(JsValue::Number(9_223_372_036_854_775_808.0).as_i64(), None);
    assert_eq!(
        JsValue::Number(-9_223_372_036_854_775_808.0).as_i64(),
        Some(i64::MIN)
    );
    assert_eq!(JsValue::Number(f64::INFINITY).as_u64(), None);
}
