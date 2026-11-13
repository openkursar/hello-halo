use halo_core::{
    core::{tokens, truncate},
    error::Error as CoreError,
    js::text::JsTextView,
    prompt,
};
use napi::{Env, Error, JsNumber, JsString, JsStringUtf16, JsUnknown, Result, Status, ValueType};
use napi_derive::napi;
use serde_json::json;

fn read(text: JsString) -> Result<(JsStringUtf16, usize)> {
    // napi's UTF-16 buffer includes a terminator; the source length preserves actual NULs.
    let length = text.utf16_len()?;
    Ok((text.into_utf16()?, length))
}

#[napi]
pub fn estimate_tokens_text(text: JsUnknown) -> Result<f64> {
    if text.get_type()? != ValueType::String {
        if !text.coerce_to_bool()?.get_value()? {
            return Ok(0.0);
        }
        return Err(Error::new(
            Status::InvalidArg,
            "Token estimation requires a string",
        ));
    }
    let (text, length) = read(JsString::try_from(text)?)?;
    Ok(tokens::estimate_text_tokens(JsTextView::Utf16(
        &text.as_slice()[..length],
    )))
}

#[napi]
pub fn truncate_tool_result_text(
    env: Env,
    text: JsUnknown,
    maximum: JsUnknown,
) -> Result<JsUnknown> {
    let maximum = if maximum.get_type()? == ValueType::Number {
        JsNumber::try_from(maximum)?.get_double()?
    } else {
        f64::NAN
    };
    if maximum == f64::INFINITY {
        return Ok(text);
    }
    if !maximum.is_finite()
        || maximum.fract() != 0.0
        || maximum < 0.0
        || maximum > 9_007_199_254_740_991.0
    {
        return Err(crate::failure(
            CoreError::new(
                "INVALID_BUDGET",
                "Text output budget must be a nonnegative integer",
            )
            .with_details(json!({"name":"RangeError"})),
        ));
    }
    let text = JsString::try_from(text)?;
    let length = text.utf16_len()?;
    if length as f64 <= maximum {
        return Ok(text.into_unknown());
    }
    let text = text.into_utf16()?;
    let result = truncate::truncate_utf16(&text.as_slice()[..length], maximum as usize);
    Ok(env.create_string_utf16(&result)?.into_unknown())
}

#[napi]
pub fn split_at_boundary_ranges(text: JsString) -> Result<Vec<f64>> {
    let (text, length) = read(text)?;
    let (stable, dynamic) =
        prompt::split_text_at_boundary(JsTextView::Utf16(&text.as_slice()[..length]));
    Ok(vec![stable.len() as f64, (length - dynamic.len()) as f64])
}
