use std::sync::OnceLock;

fn pairs() -> &'static [(u16, u16)] {
    static PAIRS: OnceLock<Vec<(u16, u16)>> = OnceLock::new();
    PAIRS.get_or_init(|| {
        (0..=u16::MAX)
            .filter_map(|unit| {
                let character = char::from_u32(unit as u32)?;
                let mut uppercase = character.to_uppercase();
                let first = uppercase.next()?;
                if uppercase.next().is_some()
                    || first.len_utf16() != 1
                    || (unit >= 128 && (first as u32) < 128)
                {
                    return None;
                }
                let upper = first as u16;
                (upper != unit).then_some((unit, upper))
            })
            .collect()
    })
}
fn bit(bits: &[u64; 1024], unit: u16) -> bool {
    bits[unit as usize / 64] & (1u64 << (unit as usize % 64)) != 0
}
fn insert(bits: &mut [u64; 1024], unit: u16) {
    bits[unit as usize / 64] |= 1u64 << (unit as usize % 64);
}
fn atom(units: &[u16], index: &mut usize) -> (u16, bool) {
    let unit = units[*index];
    *index += 1;
    if unit != b'\\' as u16 || *index == units.len() {
        return (unit, false);
    }
    let unit = units[*index];
    *index += 1;
    let count = if unit == b'u' as u16 {
        4
    } else if unit == b'x' as u16 {
        2
    } else {
        0
    };
    if count > 0 && *index + count <= units.len() {
        let text = String::from_utf16_lossy(&units[*index..*index + count]);
        if let Ok(value) = u16::from_str_radix(&text, 16) {
            *index += count;
            return (value, true);
        }
    }
    (unit, true)
}
fn class(source: &str, mapped: bool) -> String {
    if source == "^/" {
        return if mapped {
            r"[^\u{1002f}]".into()
        } else {
            "[^/]".into()
        };
    }
    let units: Vec<_> = source.encode_utf16().collect();
    let negated = units.first() == Some(&(b'^' as u16));
    let mut index = usize::from(negated);
    let mut atoms = Vec::new();
    while index < units.len() {
        atoms.push(atom(&units, &mut index));
    }
    let mut bits = [0u64; 1024];
    let mut index = 0;
    while index < atoms.len() {
        let first = atoms[index].0;
        if atoms.get(index + 1) == Some(&(b'-' as u16, false)) && index + 2 < atoms.len() {
            let last = atoms[index + 2].0;
            for unit in first..=last {
                insert(&mut bits, unit);
            }
            index += 3;
        } else {
            insert(&mut bits, first);
            index += 1;
        }
    }
    if atoms.iter().all(|(unit, _)| *unit < 128) {
        for lower in b'a'..=b'z' {
            let upper = lower.to_ascii_uppercase();
            if bit(&bits, lower as u16) || bit(&bits, upper as u16) {
                insert(&mut bits, lower as u16);
                insert(&mut bits, upper as u16);
            }
        }
    } else {
        for &(lower, upper) in pairs() {
            if bit(&bits, lower) {
                insert(&mut bits, upper);
            }
        }
        for &(lower, upper) in pairs() {
            if bit(&bits, upper) {
                insert(&mut bits, lower);
            }
        }
    }
    let mut ranges = String::new();
    let mut index = 0u32;
    while index <= u16::MAX as u32 {
        if !bit(&bits, index as u16) {
            index += 1;
            continue;
        }
        let first = index;
        let mut last = index;
        while last < u16::MAX as u32 && bit(&bits, (last + 1) as u16) {
            last += 1;
        }
        ranges.push_str(&unit_text(first as u16, mapped));
        if last != first {
            ranges.push('-');
            ranges.push_str(&unit_text(last as u16, mapped));
        }
        index = last + 1;
    }
    format!("[{}{ranges}]", if negated { "^" } else { "" })
}

fn unit_text(unit: u16, mapped: bool) -> String {
    if mapped {
        format!(r"\u{{{:x}}}", unit as u32 + 0x10000)
    } else {
        format!(r"\u{unit:04x}")
    }
}
fn literal(unit: u16, mapped: bool) -> Option<String> {
    if unit < 128 {
        let byte = unit as u8;
        return byte.is_ascii_alphabetic().then(|| {
            format!(
                "[{}{}]",
                unit_text(byte.to_ascii_uppercase() as u16, mapped),
                unit_text(byte.to_ascii_lowercase() as u16, mapped)
            )
        });
    }
    let canonical = pairs()
        .iter()
        .find(|(lower, _)| *lower == unit)
        .map(|(_, upper)| *upper)
        .unwrap_or(unit);
    let mut alternatives = vec![canonical];
    alternatives.extend(
        pairs()
            .iter()
            .filter(|(_, upper)| *upper == canonical)
            .map(|(lower, _)| *lower),
    );
    if alternatives.len() == 1 {
        return None;
    }
    alternatives.sort_unstable();
    Some(format!(
        "[{}]",
        alternatives
            .into_iter()
            .map(|value| unit_text(value, mapped))
            .collect::<String>()
    ))
}

// Explicit case closure avoids backend differences in non-Unicode JavaScript folding.
fn transform(source: &str, mapped: bool) -> String {
    let units: Vec<_> = source.encode_utf16().collect();
    let mut result = String::new();
    let mut index = 0;
    while index < units.len() {
        if units[index] == b'[' as u16 {
            let start = index + 1;
            index = start;
            while index < units.len() {
                if units[index] == b'\\' as u16 {
                    index += 2;
                } else if units[index] == b']' as u16 {
                    break;
                } else {
                    index += 1;
                }
            }
            if index >= units.len() {
                result.push_str(&String::from_utf16_lossy(&units[start - 1..]));
                break;
            }
            result.push_str(&class(
                &String::from_utf16_lossy(&units[start..index]),
                mapped,
            ));
            index += 1;
        } else if units[index] == b'\\' as u16 {
            let start = index;
            let (unit, _) = atom(&units, &mut index);
            if let Some(closed) = literal(unit, mapped) {
                result.push_str(&closed);
            } else if mapped {
                result.push_str(&unit_text(unit, true));
            } else {
                result.push_str(&String::from_utf16_lossy(&units[start..index]));
            }
        } else {
            let unit = units[index];
            let syntax = b"()?*+|^$.".iter().any(|value| *value as u16 == unit)
                || (matches!(unit, 33 | 58)
                    && index >= 2
                    && units[index - 1] == b'?' as u16
                    && units[index - 2] == b'(' as u16);
            if mapped && syntax {
                result.push(char::from_u32(unit as u32).unwrap());
                index += 1;
                continue;
            }
            if let Some(closed) = literal(unit, mapped) {
                result.push_str(&closed);
            } else if mapped {
                result.push_str(&unit_text(unit, true));
            } else if (0xd800..=0xdfff).contains(&unit) {
                result.push_str(&format!(r"\u{unit:04x}"));
            } else {
                result.push(char::from_u32(unit as u32).unwrap());
            }
            index += 1;
        }
    }
    result
}

pub(super) fn non_unicode_regex(source: &str) -> String {
    transform(source, false)
}
pub(super) fn projected_regex(source: &str) -> String {
    transform(source, true)
}
