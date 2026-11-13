use serde_json::{Map, Value};
pub mod json;
pub mod data;
pub mod text;
pub mod value;
pub mod wire;
#[cfg(test)]
mod value_tests;

pub fn is_whitespace(character: char) -> bool {
    matches!(character, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub fn trim_js(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}
pub fn trim_start_js(text: &str) -> &str {
    text.trim_start_matches(is_whitespace)
}
pub fn trim_end_js(text: &str) -> &str {
    text.trim_end_matches(is_whitespace)
}

pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub fn compare_text(a: &str, b: &str) -> std::cmp::Ordering { a.encode_utf16().cmp(b.encode_utf16()) }

pub fn truthy(value: &Value) -> bool {
    if is_undefined(value) { return false; }
    if let Some(number) = number(value) { return number != 0.0 && !number.is_nan(); }
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

pub fn to_string(value: &Value) -> String {
    if let Some(number) = number(value).filter(|_| !value.is_number()) { return ryu_js::Buffer::new().format(number).to_owned(); }
    if value.is_object() { if let Some(value)=number(value) { return ryu_js::Buffer::new().format(value).to_owned(); } }
    match value {
        Value::String(text) => text.clone(),
        Value::Array(values) => values.iter().map(|value| {
            if value.is_null() { String::new() } else { to_string(value) }
        }).collect::<Vec<_>>().join(","),
        Value::Object(value) if value.contains_key("__haloSdkNativeUndefined") => "undefined".into(),
        Value::Object(_) => "[object Object]".into(),
        _ => stringify(value),
    }
}

/// JavaScript enumerates array-index object keys before other insertion-ordered keys.
pub fn ordered_object(value: &Map<String, Value>) -> Map<String, Value> {
    let mut indexed = Vec::new();
    let mut named = Vec::new();
    for (key, value) in value {
        match key.parse::<u32>() {
            Ok(index) if index != u32::MAX && index.to_string() == *key => {
                indexed.push((index, key, value))
            }
            _ => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(index, _, _)| *index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .map(|(key, value)| (key.clone(), order_value(value)))
        .collect()
}

fn order_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(ordered_object(map)),
        Value::Array(values) => Value::Array(values.iter().map(order_value).collect()),
        _ => value.clone(),
    }
}

pub fn stringify(value: &Value) -> String {
    if is_undefined(value) { return "undefined".into(); }
    if value.is_object() { if let Some(value)=number(value) { return if value.is_finite() { ryu_js::Buffer::new().format(value).to_owned() } else { "null".into() }; } }
    match value {
        Value::Number(number) => ryu_js::Buffer::new()
            .format(number.as_f64().unwrap())
            .to_owned(),
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(|value| if is_undefined(value) { "null".into() } else { stringify(value) }).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            ordered_object(map)
                .iter()
                .filter(|(_,value)| !is_undefined(value))
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        stringify(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",")
        ),
        _ => serde_json::to_string(value).expect("JSON value serialization cannot fail"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_counts_utf16_code_units() {
        assert_eq!(utf16_len("A😀中"), 4);
    }

    #[test]
    fn index_keys_precede_insertion_ordered_keys() {
        let value: Value = serde_json::from_str(r#"{"b":1,"10":2,"2":3,"01":4,"a":5}"#).unwrap();
        assert_eq!(stringify(&value), r#"{"2":3,"10":2,"b":1,"01":4,"a":5}"#);
    }
}

pub fn utf16_prefix(text: &str, limit: usize) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(limit).collect::<Vec<_>>())
}

pub fn safe_integer(value: &Value) -> Option<i64> {
    value.as_f64().filter(|number| number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).map(|number| number as i64)
}

pub fn undefined() -> Value {
    serde_json::json!({"__haloSdkNativeUndefined":true})
}

pub fn is_undefined(value: &Value) -> bool {
    value.get("__haloSdkNativeUndefined") == Some(&Value::Bool(true))
}

pub fn collapse_whitespace(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut whitespace = false;
    for character in text.chars() {
        if is_whitespace(character) {
            if !whitespace { result.push(' '); }
            whitespace = true;
        } else {
            result.push(character);
            whitespace = false;
        }
    }
    result
}

pub fn to_fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return ryu_js::Buffer::new().format(value).to_owned();
    }
    assert!(digits <= 15);
    let bits = value.abs().to_bits();
    let encoded_exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1u64 << 52) - 1);
    let (significand, exponent) = if encoded_exponent == 0 { (fraction, -1074) } else { (fraction | (1u64 << 52), encoded_exponent - 1023 - 52) };
    let scale = 10u128.pow(digits);
    let scaled = significand as u128 * scale;
    let rounded = if exponent >= 0 {
        scaled << exponent
    } else {
        let shift = (-exponent) as u32;
        if shift >= 128 { 0 } else {
            let quotient = scaled >> shift;
            let remainder = scaled & ((1u128 << shift) - 1);
            quotient + u128::from(remainder >= (1u128 << (shift - 1)))
        }
    };
    let sign = if value < 0.0 { "-" } else { "" };
    if digits == 0 { format!("{sign}{rounded}") } else {
        format!("{sign}{}.{:0width$}", rounded / scale, rounded % scale, width = digits as usize)
    }
}

pub fn number(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| {
        let object=value.as_object()?;
        if object.len()!=1 { return None; }
        match object.get("__haloSdkNativeNumber")?.as_str()? {
            "NaN"=>Some(f64::NAN),"Infinity"=>Some(f64::INFINITY),"-Infinity"=>Some(f64::NEG_INFINITY),"-0"=>Some(-0.0),_=>None,
        }
    })
}

pub fn number_value(value: f64) -> Value {
    let special=if value.is_nan(){Some("NaN")}else if value==f64::INFINITY{Some("Infinity")}else if value==f64::NEG_INFINITY{Some("-Infinity")}else if value==0.0&&value.is_sign_negative(){Some("-0")}else{None};
    if let Some(special)=special { serde_json::json!({"__haloSdkNativeNumber":special}) } else { serde_json::json!(value) }
}

pub fn to_number_data(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(value)) => if *value { 1.0 } else { 0.0 },
        Some(Value::Number(value)) => value.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(value)) => number_text(value),
        Some(Value::Array(_)) => number_text(&data::to_string(value.unwrap())),
        Some(Value::Object(_)) => f64::NAN,
    }
}
fn number_text(value: &str) -> f64 {
    let value = trim_js(value);
    if value.is_empty() { return 0.0; }
    match value { "Infinity" | "+Infinity" => return f64::INFINITY, "-Infinity" => return f64::NEG_INFINITY, _ => {} }
    if value.starts_with('0') && value.len() > 2 {
        let width = match value.as_bytes()[1] { b'x' | b'X' => Some(4), b'b' | b'B' => Some(1), b'o' | b'O' => Some(3), _ => None };
        if let Some(width) = width {
            let digits = &value[2..]; let radix = 1u32 << width;
            if !digits.bytes().all(|byte| (byte as char).to_digit(radix).is_some()) { return f64::NAN; }
            let mut mantissa = 0u64; let mut count = 0usize; let mut guard = false; let mut sticky = false;
            for digit in digits.bytes().map(|byte| (byte as char).to_digit(radix).unwrap()) {
                for offset in (0..width).rev() {
                    let bit = (digit >> offset) & 1;
                    if count == 0 && bit == 0 { continue; }
                    count += 1;
                    if count <= 53 { mantissa = (mantissa << 1) | u64::from(bit); }
                    else if count == 54 { guard = bit != 0; }
                    else { sticky |= bit != 0; }
                }
            }
            if count == 0 { return 0.0; }
            if count > 1024 { return f64::INFINITY; }
            if guard && (sticky || mantissa & 1 != 0) { mantissa += 1; }
            return (mantissa as f64) * 2_f64.powi(count.saturating_sub(53) as i32);
        }
    }
    let bytes = value.as_bytes(); let mut cursor = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
    let mut digits = 0;
    while bytes.get(cursor).is_some_and(u8::is_ascii_digit) { cursor += 1; digits += 1; }
    if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) { cursor += 1; digits += 1; }
    }
    if digits == 0 { return f64::NAN; }
    if matches!(bytes.get(cursor), Some(b'e' | b'E')) {
        cursor += 1;
        if matches!(bytes.get(cursor), Some(b'+' | b'-')) { cursor += 1; }
        let start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) { cursor += 1; }
        if cursor == start { return f64::NAN; }
    }
    if cursor != bytes.len() { return f64::NAN; }
    value.parse().unwrap_or(f64::NAN)
}

#[cfg(test)]
mod number_data_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn raw_number_coercion_has_no_transport_marker_semantics() {
        for (input, expected) in [(json!(null),0.0),(json!(true),1.0),(json!(false),0.0),(json!("\u{feff} \n"),0.0),(json!("0xff"),255.0),(json!("0B101"),5.0),(json!("0o17"),15.0),(json!([null]),0.0),(json!([[".5"]]),0.5),(json!("2.5e2"),250.0),(json!("0x20000000000003"),9007199254740996.0)] {
            assert_eq!(to_number_data(Some(&input)), expected, "{input}");
        }
        assert!(to_number_data(None).is_nan());
        for input in [json!("-0x1"),json!("+0x1"),json!("inf"),json!("1e"),json!("0x"),json!([1,2]),json!({"__haloSdkNativeNumber":"Infinity"}),json!({"__haloSdkNativeUndefined":true})] { assert!(to_number_data(Some(&input)).is_nan(), "{input}"); }
        assert_eq!(to_number_data(Some(&json!("Infinity"))),f64::INFINITY);
        assert_eq!(to_number_data(Some(&json!("-Infinity"))),f64::NEG_INFINITY);
        assert!(to_number_data(Some(&json!("-0"))).is_sign_negative());
    }
}

pub fn stringify_pretty(value: &Value) -> String {
    fn render(value:&Value,depth:usize)->String {
        if is_undefined(value)||value.is_object()&&number(value).is_some(){return stringify(value);}
        let indent=|depth:usize|"  ".repeat(depth);
        match value {
            Value::Array(values) if values.is_empty()=>"[]".into(),
            Value::Array(values)=>format!("[\n{}\n{}]",values.iter().map(|value|format!("{}{}",indent(depth+1),if is_undefined(value){"null".into()}else{render(value,depth+1)})).collect::<Vec<_>>().join(",\n"),indent(depth)),
            Value::Object(object)=>{
                let entries:Vec<_>=ordered_object(object).into_iter().filter(|(_,value)|!is_undefined(value)).collect();
                if entries.is_empty(){return "{}".into();}
                format!("{{\n{}\n{}}}",entries.iter().map(|(key,value)|format!("{}{}: {}",indent(depth+1),serde_json::to_string(key).unwrap(),render(value,depth+1))).collect::<Vec<_>>().join(",\n"),indent(depth))
            }
            _=>stringify(value),
        }
    }
    render(value,0)
}
