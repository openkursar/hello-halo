pub(crate) fn sniff_bytes(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

pub(crate) fn read_mime(bytes: &[u8]) -> Option<&'static str> {
    let mime = sniff_bytes(bytes)?;
    if mime == "image/png" {
        let mut offset = 8usize;
        let mut pixels = false;
        while offset.checked_add(12)? <= bytes.len() {
            let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().ok()?) as usize;
            let end = offset.checked_add(12)?.checked_add(length)?;
            if end > bytes.len()
                || offset == 8 && (&bytes[offset + 4..offset + 8] != b"IHDR" || length != 13)
            {
                return None;
            }
            match &bytes[offset + 4..offset + 8] {
                b"IDAT" => pixels = true,
                b"IEND" => return (length == 0 && pixels).then_some(mime),
                _ => {}
            }
            offset = end;
        }
        return None;
    }
    if mime == "image/webp" {
        let length = u32::from_le_bytes(bytes[4..8].try_into().ok()?) as usize;
        if length < 12 || length.checked_add(8)? > bytes.len() {
            return None;
        }
    }
    Some(mime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    #[test]
    fn read_rejects_empty_disguised_and_truncated_images() {
        assert_eq!(read_mime(b""), None);
        assert_eq!(read_mime(b"a text file named image.png"), None);
        let png = base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBYkAAAAASUVORK5CYII=").unwrap();
        assert_eq!(read_mime(&png), Some("image/png"));
        assert_eq!(read_mime(&png[..40]), None);
    }
}
