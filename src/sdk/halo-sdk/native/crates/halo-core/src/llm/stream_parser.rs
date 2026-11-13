use crate::{error::Result, js};
use serde::Serialize;
use serde_json::Value;

#[derive(Default)]
pub struct StreamParser {
    buffer: String,
    cursor: usize,
    event: Option<String>,
    done: bool,
}
#[derive(Serialize)]
pub struct Record {
    value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    event: Option<String>,
}
#[derive(Serialize)]
pub struct Batch {
    records: Vec<Record>,
    done: bool,
}
impl StreamParser {
    pub fn feed(&mut self, text: &str) -> Result<Batch> {
        let mut records = Vec::new();
        if self.done {
            return Ok(Batch {
                records,
                done: true,
            });
        }
        if !text.is_empty() {
            if self.cursor > 0 {
                self.buffer.drain(..self.cursor);
                self.cursor = 0;
            }
            self.buffer.push_str(text);
        }
        while let Some(end) = self.buffer[self.cursor..]
            .find('\n')
            .map(|index| self.cursor + index)
        {
            let line = js::trim_end_js(&self.buffer[self.cursor..end]);
            self.cursor = end + 1;
            if let Some(event) = line.strip_prefix("event:") {
                self.event = Some(js::trim_js(event).into());
                continue;
            }
            let Some(data) = line
                .strip_prefix("data:")
                .map(js::trim_js)
                .filter(|text| !text.is_empty())
            else {
                continue;
            };
            if data == "[DONE]" {
                self.done = true;
                break;
            }
            match js::json::parse(data) {
                Ok(mut value) => {
                    let mut array_event = None;
                    if let Some(event) = &self.event {
                        if let Some(object) = value.as_object_mut() {
                            object.insert("__event".into(), Value::String(event.clone()));
                        } else if value.is_array() {
                            array_event = Some(event.clone());
                        } else {
                            tracing::warn!(
                                bytes = data.len(),
                                "SSE data discarded because event metadata requires an object"
                            );
                            continue;
                        }
                        self.event = None;
                    }
                    records.push(Record {
                        value,
                        event: array_event,
                    });
                    break;
                }
                Err(error) if error.code == "JSON_SYNTAX" => tracing::warn!(
                    bytes = data.len(),
                    "SSE data discarded because JSON is malformed"
                ),
                Err(error) => return Err(error),
            }
        }
        if self.done || self.cursor == self.buffer.len() {
            self.buffer.clear();
            self.cursor = 0;
        }
        Ok(Batch {
            records,
            done: self.done,
        })
    }
}
