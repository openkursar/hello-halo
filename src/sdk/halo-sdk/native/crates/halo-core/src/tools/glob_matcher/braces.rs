// Adapted from brace-expansion 2.1.7 and balanced-match; see LICENSE.braces.
const MAX_RESULTS: usize = 100_000;
const MAX_LENGTH: usize = 4_000_000;
fn balanced(text: &str) -> Option<(usize, usize)> {
    let mut opening = text.find('{');
    let mut closing = text
        .get(opening? + 1..)?
        .find('}')
        .map(|index| index + opening.unwrap() + 1);
    closing?;
    let mut stack = Vec::new();
    let mut left = text.len();
    let mut right = 0;
    while let Some(index) = match (opening, closing) {
        (Some(a), Some(b)) if a < b => Some(a),
        (_, Some(b)) => Some(b),
        (Some(a), None) => Some(a),
        _ => None,
    } {
        if Some(index) == opening {
            stack.push(index);
            opening = text[index + 1..].find('{').map(|next| next + index + 1);
        } else if stack.len() == 1 {
            return Some((stack.pop().unwrap(), index));
        } else {
            if let Some(start) = stack.pop() {
                if start < left {
                    left = start;
                    right = index;
                }
            }
            closing = text[index + 1..].find('}').map(|next| next + index + 1);
        }
    }
    (!stack.is_empty() && left < text.len()).then_some((left, right))
}
fn comma_parts(mut text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut carry = String::new();
    loop {
        let Some((start, end)) = balanced(text) else {
            let mut tail: Vec<_> = text.split(',').map(str::to_owned).collect();
            tail[0] = format!("{carry}{}", tail[0]);
            parts.extend(tail);
            return parts;
        };
        let mut current: Vec<_> = text[..start].split(',').map(str::to_owned).collect();
        current[0] = format!("{carry}{}", current[0]);
        current.last_mut().unwrap().push_str(&text[start..=end]);
        if end + 1 == text.len() {
            parts.extend(current);
            return parts;
        }
        carry = current.pop().unwrap();
        parts.extend(current);
        text = &text[end + 1..];
    }
}
fn combine(prefixes: &[String], prefix: &str, values: &[String], drop_empty: bool) -> Vec<String> {
    let mut result = Vec::new();
    let mut length = 0;
    for previous in prefixes {
        for value in values {
            if result.len() >= MAX_RESULTS {
                return result;
            }
            let value = format!("{previous}{prefix}{value}");
            if drop_empty && value.is_empty() {
                continue;
            }
            length += crate::js::utf16_len(&value);
            if length > MAX_LENGTH {
                return result;
            }
            result.push(value);
        }
    }
    result
}
fn numeric(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}
fn sequence(body: &str) -> Option<Vec<String>> {
    let parts: Vec<_> = body.split("..").collect();
    if !(parts.len() == 2 || parts.len() == 3) || (parts.len() == 3 && !numeric(parts[2])) {
        return None;
    }
    let alpha = parts[0].len() == 1
        && parts[1].len() == 1
        && parts[0].as_bytes()[0].is_ascii_alphabetic()
        && parts[1].as_bytes()[0].is_ascii_alphabetic();
    if !alpha && (!numeric(parts[0]) || !numeric(parts[1])) {
        return None;
    }
    let value = |part: &str| {
        if alpha && part.len() == 1 && part.as_bytes()[0].is_ascii_alphabetic() {
            part.as_bytes()[0] as f64
        } else {
            part.parse::<f64>().unwrap_or(f64::NAN)
        }
    };
    let mut current = value(parts[0]);
    let last = value(parts[1]);
    let mut step = if parts.len() == 3 {
        value(parts[2]).abs().max(1.0)
    } else {
        1.0
    };
    let reversed = last < current;
    if reversed {
        step = -step;
    }
    let padded = parts.iter().any(|part| {
        let value = part.strip_prefix('-').unwrap_or(part);
        value.starts_with('0') && value.as_bytes().get(1).is_some_and(u8::is_ascii_digit)
    });
    let width = parts[0].len().max(parts[1].len());
    let mut output = Vec::new();
    let mut length = 0;
    while (if reversed {
        current >= last
    } else {
        current <= last
    }) && output.len() < MAX_RESULTS
    {
        let mut text = if alpha {
            if current == b'\\' as f64 {
                String::new()
            } else {
                char::from_u32(current as u32).unwrap().to_string()
            }
        } else {
            crate::js::to_string(&serde_json::json!(current))
        };
        if padded && !alpha && text.len() < width {
            let zeros = "0".repeat(width - text.len());
            text = if current < 0.0 {
                format!("-{zeros}{}", &text[1..])
            } else {
                format!("{zeros}{text}")
            };
        }
        length += crate::js::utf16_len(&text);
        if length > MAX_LENGTH {
            break;
        }
        output.push(text);
        current += step;
    }
    Some(output)
}
fn rewrite_tail(text: &str) -> bool {
    text.char_indices().any(|(index, character)| {
        character == ','
            && !text[index + 1..].starts_with(',')
            && text[index + 1..]
                .chars()
                .take_while(|character| !matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
                .any(|character| character == '}')
    })
}
fn expand_inner(mut text: String, close: &str, depth: usize, mut top: bool) -> Vec<String> {
    if depth > 1000 {
        return vec![text];
    }
    let mut prefixes = vec![String::new()];
    let mut rewrites = 0;
    let mut drop_empty = false;
    let mut first = true;
    loop {
        let Some((start, end)) = balanced(&text) else {
            return combine(&prefixes, &text, &[String::new()], drop_empty);
        };
        let prefix = &text[..start];
        let body = &text[start + 1..end];
        let tail = &text[end + 1..];
        if prefix.ends_with('$') {
            prefixes = combine(
                &prefixes,
                &text[..=end],
                &[String::new()],
                drop_empty && tail.is_empty(),
            );
            first = false;
            if tail.is_empty() {
                break;
            }
            text = tail.to_owned();
            continue;
        }
        let range = sequence(body);
        if range.is_none() && !body.contains(',') {
            if rewrites < 1000 && rewrite_tail(tail) {
                rewrites += 1;
                text = format!("{prefix}{{{body}{close}{tail}");
                top = true;
                continue;
            }
            return combine(&prefixes, &text, &[String::new()], drop_empty);
        }
        if first {
            drop_empty = top && range.is_none();
            first = false;
        }
        let values = if let Some(range) = range {
            range
        } else {
            let mut members = comma_parts(body);
            if members.len() == 1 {
                members = expand_inner(members.remove(0), close, depth + 1, false)
                    .into_iter()
                    .map(|value| format!("{{{value}}}"))
                    .collect();
                if members.len() == 1 {
                    prefixes = combine(
                        &prefixes,
                        &format!("{prefix}{}", members[0]),
                        &[String::new()],
                        drop_empty && tail.is_empty(),
                    );
                    if tail.is_empty() {
                        break;
                    }
                    text = tail.to_owned();
                    continue;
                }
            }
            let omit = drop_empty
                && tail.is_empty()
                && prefix.is_empty()
                && prefixes.iter().all(String::is_empty);
            let mut values = Vec::new();
            let mut length = 0;
            'members: for member in members {
                for value in expand_inner(member, close, depth + 1, false) {
                    if omit && value.is_empty() {
                        continue;
                    }
                    length += crate::js::utf16_len(&value);
                    if values.len() >= MAX_RESULTS || length > MAX_LENGTH {
                        break 'members;
                    }
                    values.push(value);
                }
            }
            values
        };
        prefixes = combine(&prefixes, prefix, &values, drop_empty && tail.is_empty());
        if tail.is_empty() {
            break;
        }
        text = tail.to_owned();
    }
    prefixes
}
pub(super) fn expand(pattern: &str) -> Vec<String> {
    if pattern.is_empty() {
        return vec![String::new()];
    }
    let close = format!("\0CLOSE{}\0", uuid::Uuid::new_v4());
    let open = format!("\0OPEN{}\0", uuid::Uuid::new_v4());
    let input = if let Some(tail) = pattern.strip_prefix("{}") {
        format!("{open}{close}{tail}")
    } else {
        pattern.to_owned()
    };
    expand_inner(input, &close, 0, true)
        .into_iter()
        .map(|value| value.replace(&close, "}").replace(&open, "{"))
        .collect()
}
