use crate::{failure, host_bridge::CallbackBridge, host_callbacks};
use halo_core::{
    error::Error,
    js::{text::JsText, value::JsValue, wire::WireDocument},
    tools::mcp::public_bridge::{self, ErrorFlag, ResultAccess},
};
use napi::{
    Env, JsFunction, JsObject, JsString, JsUnknown, NapiRaw, NapiValue, Result, Status, ValueType,
};
use napi_derive::napi;
use std::{ffi::CString, ptr};
use tokio_util::sync::CancellationToken;

fn decode_data(input: &str) -> Result<JsValue> {
    WireDocument::from_json_str(input)
        .and_then(|document| document.decode())
        .map_err(|error| failure(Error::new("HOST_DATA_INVALID", error.to_string())))
}

#[napi]
pub fn mcp_bridge_value(method: String, payload: String) -> Result<String> {
    let args = decode_data(&payload)?;
    let field = |index: usize| args.get(index).unwrap_or(&JsValue::Undefined);
    let value = match method.as_str() {
        "descriptors" => JsValue::Array(
            public_bridge::descriptors(
                field(0),
                &field(1).as_text().cloned().unwrap_or_else(|| "".into()),
                field(2),
                field(3)
                    .as_text()
                    .and_then(JsText::as_utf8)
                    .unwrap_or("sdk"),
            )
            .map_err(failure)?,
        ),
        "assertUnique" => {
            public_bridge::assert_unique_data(
                field(0).as_array().map(Vec::as_slice).unwrap_or(&[]),
            )
            .map_err(failure)?;
            JsValue::Undefined
        }
        "handlerFailure" => public_bridge::handler_failure(
            field(0),
            &field(1).as_text().cloned().unwrap_or_else(|| "".into()),
            &halo_core::harness::baseline(),
        ),
        _ => {
            return Err(failure(Error::new(
                "UNKNOWN_MCP_OPERATION",
                format!("Unknown MCP bridge operation: {method}"),
            )))
        }
    };
    Ok(WireDocument::encode(&value).to_json_string())
}

#[napi]
pub fn mcp_bridge_invoke(
    env: Env,
    descriptor: String,
    input: String,
    callback: JsFunction,
) -> Result<JsObject> {
    let descriptor = decode_data(&descriptor)?;
    let input = decode_data(&input)?;
    let bridge = CallbackBridge::new(env, &callback)?;
    let callbacks = bridge.callbacks.clone();
    host_callbacks::start(env, callbacks, callback, async move {
        let result = public_bridge::invoke_data(
            &descriptor,
            input,
            bridge.clone(),
            &CancellationToken::new(),
        )
        .await;
        bridge.abort();
        result.map(|result| WireDocument::encode(&result).to_json())
    })
}

#[derive(Clone, Copy)]
struct BorrowedValue(napi::sys::napi_value);
struct ContentIterator {
    value: BorrowedValue,
    next: BorrowedValue,
}
struct Access<'a> {
    env: &'a Env,
}

fn status(value: napi::sys::napi_status) -> Result<()> {
    if value == napi::sys::Status::napi_ok {
        Ok(())
    } else {
        Err(napi::Error::from_status(Status::from(value)))
    }
}

impl Access<'_> {
    fn kind(&self, value: BorrowedValue) -> Result<ValueType> {
        let mut kind = napi::sys::ValueType::napi_undefined;
        status(unsafe { napi::sys::napi_typeof(self.env.raw(), value.0, &mut kind) })?;
        Ok(ValueType::from(kind))
    }
    fn object(&self, value: BorrowedValue) -> Result<BorrowedValue> {
        let mut object = ptr::null_mut();
        status(unsafe { napi::sys::napi_coerce_to_object(self.env.raw(), value.0, &mut object) })?;
        Ok(BorrowedValue(object))
    }
    fn call(
        &self,
        function: BorrowedValue,
        receiver: BorrowedValue,
        args: &[BorrowedValue],
    ) -> Result<BorrowedValue> {
        let args = args.iter().map(|value| value.0).collect::<Vec<_>>();
        let mut result = ptr::null_mut();
        // Leave a thrown value pending; napi's convenience call would coerce it to text.
        status(unsafe {
            napi::sys::napi_call_function(
                self.env.raw(),
                receiver.0,
                function.0,
                args.len(),
                args.as_ptr(),
                &mut result,
            )
        })?;
        Ok(BorrowedValue(result))
    }
    fn global(&self) -> Result<BorrowedValue> {
        let mut value = ptr::null_mut();
        status(unsafe { napi::sys::napi_get_global(self.env.raw(), &mut value) })?;
        Ok(BorrowedValue(value))
    }
}

impl ResultAccess for Access<'_> {
    type Value = BorrowedValue;
    type Iterator = ContentIterator;
    type Error = napi::Error;

    fn get(&mut self, value: BorrowedValue, name: &str) -> Result<BorrowedValue> {
        let object = self.object(value)?;
        let name = CString::new(name)?;
        let mut result = ptr::null_mut();
        status(unsafe {
            napi::sys::napi_get_named_property(self.env.raw(), object.0, name.as_ptr(), &mut result)
        })?;
        Ok(BorrowedValue(result))
    }
    fn truthy(&self, value: BorrowedValue) -> Result<bool> {
        let mut boolean = ptr::null_mut();
        status(unsafe { napi::sys::napi_coerce_to_bool(self.env.raw(), value.0, &mut boolean) })?;
        let mut result = false;
        status(unsafe { napi::sys::napi_get_value_bool(self.env.raw(), boolean, &mut result) })?;
        Ok(result)
    }
    fn nullish(&self, value: BorrowedValue) -> Result<bool> {
        Ok(matches!(
            self.kind(value)?,
            ValueType::Null | ValueType::Undefined
        ))
    }
    fn is_string(&self, value: BorrowedValue) -> Result<bool> {
        Ok(self.kind(value)? == ValueType::String)
    }
    fn text(&self, value: BorrowedValue) -> Result<JsText> {
        let mut string = ptr::null_mut();
        status(unsafe { napi::sys::napi_coerce_to_string(self.env.raw(), value.0, &mut string) })?;
        let mut length = 0;
        status(unsafe {
            napi::sys::napi_get_value_string_utf16(
                self.env.raw(),
                string,
                ptr::null_mut(),
                0,
                &mut length,
            )
        })?;
        let mut units = vec![0; length + 1];
        status(unsafe {
            napi::sys::napi_get_value_string_utf16(
                self.env.raw(),
                string,
                units.as_mut_ptr(),
                units.len(),
                &mut length,
            )
        })?;
        units.truncate(length);
        Ok(JsText::from_utf16(units))
    }
    fn string_length(&self, value: BorrowedValue) -> Result<usize> {
        let mut length = 0;
        status(unsafe {
            napi::sys::napi_get_value_string_utf16(
                self.env.raw(),
                value.0,
                ptr::null_mut(),
                0,
                &mut length,
            )
        })?;
        Ok(length)
    }
    fn stringify(&mut self, value: Option<BorrowedValue>) -> Result<BorrowedValue> {
        let json = self.get(self.global()?, "JSON")?;
        let stringify = self.get(json, "stringify")?;
        let value = match value {
            Some(value) => value,
            None => BorrowedValue(unsafe { self.env.get_null()?.raw() }),
        };
        self.call(stringify, json, &[value])
    }
    fn iterate(&mut self, value: Option<BorrowedValue>) -> Result<ContentIterator> {
        let value = match value {
            Some(value) => value,
            None => BorrowedValue(unsafe { self.env.create_array_with_length(0)?.raw() }),
        };
        let symbol = self.get(self.global()?, "Symbol")?;
        let iterator = self.get(symbol, "iterator")?;
        let object = self.object(value)?;
        let mut method = ptr::null_mut();
        status(unsafe {
            napi::sys::napi_get_property(self.env.raw(), object.0, iterator.0, &mut method)
        })?;
        let value = self.call(BorrowedValue(method), value, &[])?;
        let next = self.get(value, "next")?;
        Ok(ContentIterator { value, next })
    }
    fn next(&mut self, iterator: &mut ContentIterator) -> Result<Option<BorrowedValue>> {
        let step = self.call(iterator.next, iterator.value, &[])?;
        let done = self.get(step, "done")?;
        if self.truthy(done)? {
            Ok(None)
        } else {
            self.get(step, "value").map(Some)
        }
    }
    fn close_iterator(
        &mut self,
        iterator: &mut ContentIterator,
        error: napi::Error,
    ) -> napi::Error {
        let mut pending = false;
        let mut original = ptr::null_mut();
        unsafe {
            napi::sys::napi_is_exception_pending(self.env.raw(), &mut pending);
            if pending {
                napi::sys::napi_get_and_clear_last_exception(self.env.raw(), &mut original);
            }
        }
        let _ = (|| {
            let close = self.get(iterator.value, "return")?;
            if !self.nullish(close)? {
                self.call(close, iterator.value, &[])?;
            }
            Ok::<_, napi::Error>(())
        })();
        unsafe {
            napi::sys::napi_is_exception_pending(self.env.raw(), &mut pending);
            if pending {
                let mut ignored = ptr::null_mut();
                napi::sys::napi_get_and_clear_last_exception(self.env.raw(), &mut ignored);
            }
            if !original.is_null() {
                napi::sys::napi_throw(self.env.raw(), original);
            }
        }
        error
    }
}

fn create_text(env: &Env, text: &JsText) -> Result<JsString> {
    match text.as_utf8() {
        Some(text) => env.create_string(text),
        None => env.create_string_utf16(&text.units().collect::<Vec<_>>()),
    }
}

#[napi]
pub fn mcp_bridge_format(env: Env, descriptor: String, result: JsUnknown) -> Result<JsObject> {
    let descriptor = decode_data(&descriptor)?;
    let mut access = Access { env: &env };
    let result = public_bridge::format_public_result(
        &descriptor,
        BorrowedValue(unsafe { result.raw() }),
        &mut access,
        &halo_core::harness::baseline(),
    )?;
    let mut output = env.create_object()?;
    output.set_named_property("content", create_text(&env, &result.content)?)?;
    match result.is_error {
        ErrorFlag::Boolean(value) => output.set_named_property("isError", value)?,
        ErrorFlag::Original(value) => output.set_named_property("isError", unsafe {
            JsUnknown::from_raw_unchecked(env.raw(), value.0)
        })?,
    }
    if !result.images.is_empty() {
        let mut images = env.create_array_with_length(result.images.len())?;
        for (index, (mime, data)) in result.images.into_iter().enumerate() {
            let mut image = env.create_object()?;
            image.set_named_property("mimeType", unsafe {
                JsUnknown::from_raw_unchecked(env.raw(), mime.0)
            })?;
            image.set_named_property("data", unsafe {
                JsUnknown::from_raw_unchecked(env.raw(), data.0)
            })?;
            images.set_element(index as u32, image)?;
        }
        output.set_named_property("images", images)?;
    }
    Ok(output)
}
