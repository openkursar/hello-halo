use crate::harness::TextId;
use serde_json::{json, Value};

const MAX_EVENT_BYTES: usize = 32 * 1024 * 1024;

pub(super) enum Record {
    Data(Value),
    Done,
}

#[derive(Default)]
pub(super) struct Decoder {
    buffer: Vec<u8>,
    cursor: usize,
    scanned: usize,
    data: String,
    event: Option<String>,
    started: bool,
    skip_lf: bool,
    ended: bool,
}

impl Decoder {
    pub(super) fn push(&mut self, bytes: &[u8]) -> Result<(), TextId> {
        let retained = self.data.len() + self.buffer.len() - self.cursor;
        if bytes.len() > MAX_EVENT_BYTES.saturating_sub(retained) {
            return Err(TextId::ProvidersStreamEventTooLarge);
        }
        if self.cursor > 0 {
            self.buffer.drain(..self.cursor);
            self.scanned = self.scanned.saturating_sub(self.cursor);
            self.cursor = 0;
        }
        self.buffer.extend_from_slice(bytes);
        Ok(())
    }

    pub(super) fn finish(&mut self) {
        self.ended = true;
    }

    pub(super) fn ended(&self) -> bool {
        self.ended
    }

    pub(super) fn next(&mut self) -> Result<Option<Record>, TextId> {
        loop {
            if self.skip_lf && self.cursor < self.buffer.len() {
                if self.buffer[self.cursor] == b'\n' {
                    self.cursor += 1;
                    self.scanned = self.cursor;
                }
                self.skip_lf = false;
            }
            let end = self.buffer[self.scanned..]
                .iter()
                .position(|byte| matches!(byte, b'\r' | b'\n'))
                .map(|index| self.scanned + index);
            let end = match end {
                Some(end) => end,
                None if self.ended && self.cursor < self.buffer.len() => self.buffer.len(),
                None => {
                    self.scanned = self.buffer.len();
                    return if self.ended { Self::dispatch(&mut self.data, &mut self.event) } else { Ok(None) };
                }
            };
            let start = self.cursor;
            self.skip_lf = self.buffer.get(end) == Some(&b'\r');
            self.cursor = (end + 1).min(self.buffer.len());
            self.scanned = self.cursor;
            let mut line = std::str::from_utf8(&self.buffer[start..end])
                .map_err(|_| TextId::ProvidersStreamInvalidUtf8)?;
            if !self.started {
                self.started = true;
                line = line.strip_prefix('\u{feff}').unwrap_or(line);
            }
            if line.is_empty() {
                if let Some(record) = Self::dispatch(&mut self.data, &mut self.event)? {
                    return Ok(Some(record));
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = crate::js::trim_js(value);
            match field {
                "event" => self.event = (!value.is_empty()).then(|| value.to_owned()),
                "data" if !value.is_empty() => {
                    if self.data.is_empty() {
                        if value == "[DONE]" {
                            return Ok(Some(Record::Done));
                        }
                        // Compatible servers may omit blank separators between complete JSON records.
                        match serde_json::from_str::<Value>(value) {
                            Ok(value) => return Self::record(value, &mut self.event).map(Some),
                            Err(error) if error.is_eof() => self.data.push_str(value),
                            Err(_) => return Err(TextId::ProvidersStreamInvalidJson),
                        }
                    } else {
                        if self.data.len() + value.len() + 1 > MAX_EVENT_BYTES {
                            return Err(TextId::ProvidersStreamEventTooLarge);
                        }
                        self.data.push('\n');
                        self.data.push_str(value);
                    }
                }
                _ => {}
            }
        }
    }

    fn dispatch(data: &mut String, event: &mut Option<String>) -> Result<Option<Record>, TextId> {
        if data.is_empty() {
            *event = None;
            return Ok(None);
        }
        let value = serde_json::from_str(data).map_err(|_| TextId::ProvidersStreamInvalidJson)?;
        data.clear();
        Self::record(value, event).map(Some)
    }

    fn record(mut value: Value, event: &mut Option<String>) -> Result<Record, TextId> {
        if !value.is_object() {
            return Err(TextId::ProvidersStreamInvalidObject);
        }
        if let Some(event) = event.take() {
            value["__event"] = json!(event);
        }
        Ok(Record::Data(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data(record: Record) -> Value {
        match record { Record::Data(value) => value, Record::Done => panic!("unexpected done") }
    }

    #[test]
    fn fragmented_crlf_bom_and_unicode_preserve_records() {
        let mut decoder = Decoder::default();
        let bytes = "\u{feff}: keepalive\r\nevent: chunk\r\ndata: {\"text\":\"中文🙂\"}\r\n\r\ndata: [DONE]\r\n";
        let mut values = Vec::new();
        let mut done = false;
        for byte in bytes.as_bytes() {
            decoder.push(&[*byte]).unwrap();
            while let Some(record) = decoder.next().unwrap() {
                match record { Record::Data(value) => values.push(value), Record::Done => done = true }
            }
        }
        assert_eq!(values, vec![json!({"text":"中文🙂","__event":"chunk"})]);
        assert!(done);
    }

    #[test]
    fn multiline_data_and_legacy_single_lines_keep_event_scope() {
        let mut decoder = Decoder::default();
        decoder.push(b"event: first\rdata: {\rdata: \"value\": 1\rdata: }\r\revent: stale\r\rdata: {\"value\":2}\rdata: {\"value\":3}").unwrap();
        assert_eq!(data(decoder.next().unwrap().unwrap()), json!({"value":1,"__event":"first"}));
        assert_eq!(data(decoder.next().unwrap().unwrap()), json!({"value":2}));
        assert!(decoder.next().unwrap().is_none());
        decoder.finish();
        assert_eq!(data(decoder.next().unwrap().unwrap()), json!({"value":3}));
        assert!(decoder.next().unwrap().is_none());
    }

    #[test]
    fn malformed_data_fails_without_changing_payload_bytes() {
        for (bytes, expected) in [
            (b"data: {broken}\n\n".as_slice(), TextId::ProvidersStreamInvalidJson),
            (b"data: [1,2]\n\n".as_slice(), TextId::ProvidersStreamInvalidObject),
            (b"data: {\"text\":\"\xff\"}\n\n".as_slice(), TextId::ProvidersStreamInvalidUtf8),
            (b"data: {\n\n".as_slice(), TextId::ProvidersStreamInvalidJson),
        ] {
            let mut decoder = Decoder::default();
            decoder.push(bytes).unwrap();
            assert!(matches!(decoder.next(), Err(error) if error == expected));
        }
    }

    #[test]
    fn oversized_unterminated_data_is_refused_before_copying() {
        let mut decoder = Decoder::default();
        decoder.push(b"data: ").unwrap();
        assert!(decoder.next().unwrap().is_none());
        assert_eq!(decoder.push(&vec![b'x'; MAX_EVENT_BYTES]), Err(TextId::ProvidersStreamEventTooLarge));
        assert_eq!(decoder.buffer.len(), 6);
    }
}
