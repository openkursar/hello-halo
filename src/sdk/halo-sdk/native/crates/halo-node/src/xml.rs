use halo_core::{
    js::{
        text::{JsText, JsTextView},
        value::JsValue,
        wire::WireDocument,
    },
    llm::tool_calling::parser::{parse_xml, ParameterPrototype, XmlResult},
};
use napi::{Error, JsObject, JsString, JsUnknown, Result, Status, ValueType};
use napi_derive::napi;

#[napi(object, object_from_js = false)]
pub struct NativeXmlResult {
    pub unchanged: bool,
    pub value: Option<String>,
}

fn object<const N: usize>(entries: [(&str, JsValue); N]) -> JsValue {
    JsValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
    )
}

fn encode(result: XmlResult) -> String {
    let calls = result
        .tool_calls
        .into_iter()
        .map(|call| {
            let prototype = match call.parameters.prototype {
                ParameterPrototype::Default => object([("kind", "default".into())]),
                ParameterPrototype::Null => object([("kind", "null".into())]),
                ParameterPrototype::Data(value) => {
                    object([("kind", "data".into()), ("value", value)])
                }
            };
            object([
                ("name", call.name.into()),
                ("rawXml", call.raw_xml.into()),
                (
                    "parameters",
                    object([
                        (
                            "ownEntries",
                            JsValue::Array(
                                call.parameters
                                    .own_entries
                                    .into_iter()
                                    .map(|(key, value)| JsValue::Array(vec![key.into(), value]))
                                    .collect(),
                            ),
                        ),
                        ("prototype", prototype),
                    ]),
                ),
            ])
        })
        .collect();
    WireDocument::encode(&object([
        ("textContent", result.text_content.into()),
        ("toolCalls", JsValue::Array(calls)),
    ]))
    .to_json_string()
}

#[napi]
pub fn parse_xml_text(text: JsUnknown, known_names: JsObject) -> Result<NativeXmlResult> {
    let unchanged = || NativeXmlResult {
        unchanged: true,
        value: None,
    };
    let count = known_names.get_array_length()?;
    if count == 0 {
        return Ok(unchanged());
    }
    if text.get_type()? != ValueType::String {
        if !text.coerce_to_bool()?.get_value()? {
            return Ok(unchanged());
        }
        return Err(Error::new(
            Status::InvalidArg,
            "XML tool parsing requires a string",
        ));
    }
    let text = JsString::try_from(text)?;
    let length = text.utf16_len()?;
    if length == 0 {
        return Ok(unchanged());
    }
    let mut names = Vec::with_capacity(count as usize);
    for index in 0..count {
        let name: JsString = known_names.get_element(index)?;
        let length = name.utf16_len()?;
        let name = name.into_utf16()?;
        names.push(JsText::from_utf16(name.as_slice()[..length].to_vec()));
    }
    let text = text.into_utf16()?;
    let result = parse_xml(JsTextView::Utf16(&text.as_slice()[..length]), &names);
    if result.tool_calls.is_empty() {
        return Ok(unchanged());
    }
    Ok(NativeXmlResult {
        unchanged: false,
        value: Some(encode(result)),
    })
}
