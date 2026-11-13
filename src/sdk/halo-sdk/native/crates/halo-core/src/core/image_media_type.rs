use serde_json::{json, Value};

pub fn sniff(data: &str) -> Option<&'static str> {
    if crate::js::utf16_len(data) < 16 {
        return None;
    }
    let mut bytes = Vec::with_capacity(18);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for code in data.encode_utf16().take(24) {
        let value = match code {
            65..=90 => code - 65,
            97..=122 => code - 97 + 26,
            48..=57 => code - 48 + 52,
            43 | 45 => 62,
            47 | 95 => 63,
            61 => break,
            _ => continue,
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            bytes.push((buffer >> bits) as u8);
        }
    }
    crate::images::sniff_bytes(&bytes)
}
pub fn correct(messages: &mut [Value]) -> usize {
    fn blocks(values: &mut [Value]) -> usize {
        let mut fixed = 0;
        for block in values {
            if block["type"] == "image" && block["source"]["type"] == "base64" {
                if let Some(actual) = block["source"]["data"].as_str().and_then(sniff) {
                    if block["source"]["media_type"] != actual {
                        block["source"]["media_type"] = json!(actual);
                        fixed += 1;
                    }
                }
            } else if block["type"] == "tool_result" {
                if let Some(content) = block["content"].as_array_mut() {
                    fixed += blocks(content);
                }
            }
        }
        fixed
    }
    messages
        .iter_mut()
        .filter_map(|message| message["content"].as_array_mut())
        .map(|content| blocks(content))
        .sum()
}
#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
    #[test]
    fn nested_labels_follow_bytes_and_unknown_images_are_retained() {
        let data = |prefix: &[u8]| {
            base64::engine::general_purpose::STANDARD.encode([prefix, &[0; 32]].concat())
        };
        let formats = [
            (b"\x89PNG\r\n\x1a\n".as_slice(), "image/png"),
            (b"\xff\xd8\xff", "image/jpeg"),
            (b"GIF89a", "image/gif"),
            (b"RIFF\0\0\0\0WEBP", "image/webp"),
        ];
        for (prefix, format) in formats {
            assert_eq!(sniff(&data(prefix)), Some(format));
        }
        assert_eq!(sniff("iVBO"), None);
        let mut messages = vec![
            json!({"role":"user","content":[{"type":"tool_result","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":data(b"\x89PNG\r\n\x1a\n")}}]}]}),
        ];
        assert_eq!(correct(&mut messages), 1);
        assert_eq!(correct(&mut messages), 0);
        assert_eq!(
            messages[0]["content"][0]["content"][0]["source"]["media_type"],
            "image/png"
        );
    }
}
