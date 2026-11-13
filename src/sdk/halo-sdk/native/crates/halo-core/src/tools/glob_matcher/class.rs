// Adapted from minimatch 9.0.9; see LICENSE.minimatch.
use super::ast::escape_unit;
pub(super) struct Class {
    pub regex: String,
    pub unicode: bool,
    pub consumed: usize,
    pub magic: bool,
}
fn escaped(unit: u16) -> String {
    if (0xd800..=0xdfff).contains(&unit) {
        return format!(r"\u{unit:04x}");
    }
    let character = char::from_u32(unit as u32).unwrap();
    if "[]\\-".contains(character) {
        format!("\\{character}")
    } else {
        character.to_string()
    }
}
pub(super) fn parse_class(pattern: &[u16], position: usize) -> Class {
    let classes = [
        ("[:alnum:]", r"\p{L}\p{Nl}\p{Nd}", true, false),
        ("[:alpha:]", r"\p{L}\p{Nl}", true, false),
        ("[:ascii:]", r"\x00-\x7f", false, false),
        ("[:blank:]", r"\p{Zs}\t", true, false),
        ("[:cntrl:]", r"\p{Cc}", true, false),
        ("[:digit:]", r"\p{Nd}", true, false),
        ("[:graph:]", r"\p{Z}\p{C}", true, true),
        ("[:lower:]", r"\p{Ll}", true, false),
        ("[:print:]", r"\p{C}", true, false),
        ("[:punct:]", r"\p{P}", true, false),
        ("[:space:]", r"\p{Z}\t\r\n\v\f", true, false),
        ("[:upper:]", r"\p{Lu}", true, false),
        ("[:word:]", r"\p{L}\p{Nl}\p{Nd}\p{Pc}", true, false),
        ("[:xdigit:]", r"A-Fa-f0-9", false, false),
    ];
    let mut ranges = Vec::new();
    let mut negatives = Vec::new();
    let mut index = position + 1;
    let mut saw_start = false;
    let mut unicode = false;
    let mut escaping = false;
    let mut negated = false;
    let mut end = position;
    let mut range_start = None;
    'scan: while index < pattern.len() {
        let unit = pattern[index];
        if matches!(unit, 33 | 94) && index == position + 1 {
            negated = true;
            index += 1;
            continue;
        }
        if unit == b']' as u16 && saw_start && !escaping {
            end = index + 1;
            break;
        }
        saw_start = true;
        if unit == b'\\' as u16 && !escaping {
            escaping = true;
            index += 1;
            continue;
        }
        if unit == b'[' as u16 && !escaping {
            for (name, source, needs_unicode, negative) in classes {
                if pattern[index..].starts_with(&name.encode_utf16().collect::<Vec<_>>()) {
                    if range_start.is_some() {
                        return Class {
                            regex: "$.".into(),
                            unicode: false,
                            consumed: pattern.len() - position,
                            magic: true,
                        };
                    }
                    index += name.len();
                    if negative {
                        negatives.push(source.to_owned());
                    } else {
                        ranges.push(source.to_owned());
                    }
                    unicode |= needs_unicode;
                    continue 'scan;
                }
            }
        }
        escaping = false;
        if let Some(start) = range_start.take() {
            if unit > start {
                ranges.push(format!("{}-{}", escaped(start), escaped(unit)));
            } else if unit == start {
                ranges.push(escaped(unit));
            }
            index += 1;
            continue;
        }
        if pattern.get(index + 1) == Some(&(b'-' as u16))
            && pattern.get(index + 2) == Some(&(b']' as u16))
        {
            ranges.push(format!("{}{}", escaped(unit), escaped(b'-' as u16)));
            index += 2;
            continue;
        }
        if pattern.get(index + 1) == Some(&(b'-' as u16)) {
            range_start = Some(unit);
            index += 2;
            continue;
        }
        ranges.push(escaped(unit));
        index += 1;
    }
    if end < index {
        return Class {
            regex: String::new(),
            unicode: false,
            consumed: 0,
            magic: false,
        };
    }
    if ranges.is_empty() && negatives.is_empty() {
        return Class {
            regex: "$.".into(),
            unicode: false,
            consumed: pattern.len() - position,
            magic: true,
        };
    }
    if negatives.is_empty() && ranges.len() == 1 && !negated {
        let mut literal = ranges[0].encode_utf16().collect::<Vec<_>>();
        if literal.first() == Some(&(b'\\' as u16)) && literal.len() == 2 {
            literal.remove(0);
        }
        if literal.len() == 1 {
            return Class {
                regex: escape_unit(literal[0]),
                unicode: false,
                consumed: end - position,
                magic: false,
            };
        }
    }
    let positive = format!("[{}{}]", if negated { "^" } else { "" }, ranges.join(""));
    let negative = format!("[{}{}]", if negated { "" } else { "^" }, negatives.join(""));
    let regex = if !ranges.is_empty() && !negatives.is_empty() {
        format!("({positive}|{negative})")
    } else if !ranges.is_empty() {
        positive
    } else {
        negative
    };
    Class {
        regex,
        unicode,
        consumed: end - position,
        magic: true,
    }
}
