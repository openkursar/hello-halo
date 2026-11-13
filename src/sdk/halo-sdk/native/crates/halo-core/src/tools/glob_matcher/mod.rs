mod ast;
mod braces;
mod case_fold;
mod class;
use std::collections::HashSet;

#[derive(Clone)]
enum Component {
    Globstar,
    Literal(String),
    Regex(regress::Regex, Option<regress::Regex>),
    Star,
    Suffix(String),
    Questions(usize, String),
    DotStar,
    StarDotStar,
}
impl Component {
    fn matches(&self, value: &str) -> bool {
        match self {
            Self::Globstar => false,
            Self::Literal(literal) => value == literal,
            Self::Regex(regex, projected) => {
                if let Some(projected) = projected
                    .as_ref()
                    .filter(|_| value.chars().any(|character| character as u32 > 0xffff))
                {
                    let value: String = value
                        .encode_utf16()
                        .map(|unit| char::from_u32(unit as u32 + 0x10000).unwrap())
                        .collect();
                    regress::backends::find::<regress::backends::PikeVMExecutor>(
                        projected, &value, 0,
                    )
                    .next()
                    .is_some()
                } else {
                    regress::backends::find::<regress::backends::PikeVMExecutor>(regex, value, 0)
                        .next()
                        .is_some()
                }
            }
            Self::Star => !value.is_empty() && value != "." && value != "..",
            Self::Suffix(suffix) => value.to_lowercase().ends_with(suffix),
            Self::Questions(length, suffix) => {
                crate::js::utf16_len(value) == *length
                    && value != "."
                    && value != ".."
                    && value.to_lowercase().ends_with(suffix)
            }
            Self::DotStar => value.starts_with('.') && value != "." && value != "..",
            Self::StarDotStar => value.contains('.') && value != "." && value != "..",
        }
    }
    fn literal(&self) -> Option<&str> {
        if let Self::Literal(value) = self {
            Some(value)
        } else {
            None
        }
    }
}
fn unescape(source: &str) -> String {
    let units: Vec<_> = source.encode_utf16().collect();
    let mut result = Vec::new();
    let mut index = 0;
    while index < units.len() {
        if units[index] == b'\\' as u16 && index + 1 < units.len() {
            if units[index + 1] == b'u' as u16 && index + 5 < units.len() {
                let hex = String::from_utf16_lossy(&units[index + 2..index + 6]);
                if let Ok(unit) = u16::from_str_radix(&hex, 16) {
                    result.push(unit);
                    index += 6;
                    continue;
                }
            }
            index += 1;
        }
        result.push(units[index]);
        index += 1;
    }
    String::from_utf16_lossy(&result)
}
fn component(pattern: &str) -> Result<Component, String> {
    if pattern == "**" {
        return Ok(Component::Globstar);
    }
    if pattern.is_empty() {
        return Ok(Component::Literal(String::new()));
    }
    let source = ast::compile(pattern);
    let magic = source.magic || pattern.to_uppercase() != pattern.to_lowercase();
    if !magic {
        return Ok(Component::Literal(unescape(&source.regex)));
    }
    if pattern.chars().all(|character| character == '*') {
        return Ok(Component::Star);
    }
    if pattern.starts_with('*') {
        let suffix = pattern.trim_start_matches('*');
        if !suffix.contains(['+', '@', '!', '?', '*', '[', '(']) {
            return Ok(Component::Suffix(suffix.to_lowercase()));
        }
        if let Some(rest) = suffix.strip_prefix('.') {
            if !rest.is_empty() && rest.chars().all(|character| character == '*') {
                return Ok(Component::StarDotStar);
            }
        }
    }
    if pattern.starts_with('?') {
        let suffix = pattern.trim_start_matches('?');
        if !suffix.contains(['+', '@', '!', '?', '*', '[', '(']) {
            return Ok(Component::Questions(
                crate::js::utf16_len(pattern),
                suffix.to_lowercase(),
            ));
        }
    }
    if pattern.starts_with('.')
        && pattern.len() > 1
        && pattern[1..].chars().all(|character| character == '*')
    {
        return Ok(Component::DotStar);
    }
    let expression = if source.unicode {
        source.regex.clone()
    } else {
        case_fold::non_unicode_regex(&source.regex)
    };
    let regex = regress::Regex::with_flags(
        &format!("^{expression}$"),
        if source.unicode { "iu" } else { "" },
    )
    .map_err(|error| error.to_string())?;
    let projected = if source.unicode {
        None
    } else {
        Some(
            regress::Regex::with_flags(
                &format!("^{}$", case_fold::projected_regex(&source.regex)),
                "u",
            )
            .map_err(|error| error.to_string())?,
        )
    };
    Ok(Component::Regex(regex, projected))
}
fn split(value: &str, windows: bool) -> Vec<String> {
    let mut parts = Vec::new();
    let mut previous = 0;
    for (index, character) in value.char_indices() {
        if character == '/' {
            if previous != index || index == 0 {
                parts.push(value[previous..index].to_owned());
            }
            previous = index + 1;
        }
    }
    parts.push(value[previous..].to_owned());
    if windows
        && value.starts_with("//")
        && value.as_bytes().get(2).is_some_and(|byte| *byte != b'/')
    {
        parts.insert(0, String::new());
    }
    parts
}
fn drive(value: &str) -> bool {
    value.len() == 2 && value.as_bytes()[0].is_ascii_alphabetic() && value.as_bytes()[1] == b':'
}
fn has_magic(value: &str) -> bool {
    value.contains(['?', '*', '[', ']'])
        || ["+(", "@(", "!("].iter().any(|part| value.contains(part))
}
fn regular(
    file: &[String],
    pattern: &[Component],
    mut file_index: usize,
    mut pattern_index: usize,
) -> bool {
    while file_index < file.len() && pattern_index < pattern.len() {
        if !pattern[pattern_index].matches(&file[file_index]) {
            return false;
        }
        file_index += 1;
        pattern_index += 1;
    }
    if file_index == file.len() && pattern_index == pattern.len() {
        true
    } else if file_index == file.len() {
        false
    } else {
        pattern_index == pattern.len()
            && file_index + 1 == file.len()
            && file[file_index].is_empty()
    }
}
fn globstar_body(
    file: &[String],
    segments: &[(&[Component], isize)],
    mut file_index: usize,
    body_index: usize,
    depth: usize,
    mut saw_tail: bool,
) -> bool {
    let Some((body, after)) = segments.get(body_index) else {
        for part in file.iter().skip(file_index) {
            saw_tail = true;
            if part == "." || part == ".." {
                return false;
            }
        }
        return saw_tail;
    };
    while file_index as isize <= *after {
        let end = (file_index + body.len()).min(file.len());
        if regular(&file[..end], body, file_index, 0)
            && depth < 200
            && globstar_body(
                file,
                segments,
                file_index + body.len(),
                body_index + 1,
                depth + 1,
                saw_tail,
            )
        {
            return true;
        }
        if file
            .get(file_index)
            .is_some_and(|part| part == "." || part == "..")
        {
            return false;
        }
        file_index += 1;
    }
    false
}
fn globstar(
    file: &[String],
    pattern: &[Component],
    mut file_index: usize,
    pattern_index: usize,
) -> bool {
    let first = pattern
        .iter()
        .enumerate()
        .skip(pattern_index)
        .find(|(_, part)| matches!(part, Component::Globstar))
        .unwrap()
        .0;
    let last = pattern
        .iter()
        .rposition(|part| matches!(part, Component::Globstar))
        .unwrap();
    let head = &pattern[pattern_index..first];
    let body = if first < last {
        &pattern[first + 1..last]
    } else {
        &[]
    };
    let tail = &pattern[last + 1..];
    if !head.is_empty() {
        if !regular(
            &file[file_index..(file_index + head.len()).min(file.len())],
            head,
            0,
            0,
        ) {
            return false;
        }
        file_index += head.len();
    }
    let mut tail_match = 0;
    if !tail.is_empty() {
        if tail.len() + file_index > file.len() {
            return false;
        }
        let mut start = file.len() - tail.len();
        if regular(file, tail, start, 0) {
            tail_match = tail.len();
        } else {
            if !file.last().is_some_and(String::is_empty) || file_index + tail.len() == file.len() {
                return false;
            }
            start -= 1;
            if !regular(file, tail, start, 0) {
                return false;
            }
            tail_match = tail.len() + 1;
        }
    }
    if body.is_empty() {
        let mut saw_some = tail_match > 0;
        for part in file.iter().take(file.len() - tail_match).skip(file_index) {
            saw_some = true;
            if part == "." || part == ".." {
                return false;
            }
        }
        return saw_some;
    }
    let mut sums = vec![0];
    let mut count = 0;
    let mut start = 0;
    let mut bodies = Vec::new();
    for (index, part) in body.iter().enumerate() {
        if matches!(part, Component::Globstar) {
            sums.push(count);
            bodies.push(&body[start..index]);
            start = index + 1;
        } else {
            count += 1;
        }
    }
    bodies.push(&body[start..]);
    let sections: Vec<_> = bodies
        .iter()
        .enumerate()
        .map(|(index, body)| {
            (
                *body,
                (file.len() - tail_match) as isize
                    - (sums[bodies.len() - 1 - index] + body.len()) as isize,
            )
        })
        .collect();
    globstar_body(file, &sections, file_index, 0, 0, tail_match > 0)
}

pub(super) struct Matcher {
    patterns: Vec<Vec<Component>>,
    windows: bool,
    empty: bool,
}
impl Matcher {
    pub(super) fn new(pattern: &str, windows: bool) -> Result<Self, String> {
        if crate::js::utf16_len(pattern) > 65536 {
            return Err("pattern is too long".into());
        }
        let pattern = pattern.replace('\\', "/");
        let mut patterns = Vec::new();
        let mut seen = HashSet::new();
        for expanded in braces::expand(&pattern) {
            if !seen.insert(expanded.clone()) {
                continue;
            }
            let mut optimized: Vec<String> = Vec::new();
            for part in split(&expanded, windows) {
                let previous = optimized.last().map(String::as_str);
                if part == "**" && previous == Some("**") {
                    continue;
                }
                if part == ".."
                    && previous.is_some_and(|part| {
                        !part.is_empty() && part != ".." && part != "." && part != "**"
                    })
                {
                    optimized.pop();
                    continue;
                }
                optimized.push(part);
            }
            if optimized.is_empty() {
                optimized.push(String::new());
            }
            let unc = windows
                && optimized.first().is_some_and(String::is_empty)
                && optimized.get(1).is_some_and(String::is_empty)
                && optimized
                    .get(2)
                    .is_none_or(|part| part == "?" || !has_magic(part))
                && optimized.get(3).is_none_or(|part| !has_magic(part));
            let drive_root = windows
                && optimized.first().is_some_and(|part| {
                    part.len() >= 2
                        && part.as_bytes()[0].is_ascii_alphabetic()
                        && part.as_bytes()[1] == b':'
                });
            let components = optimized
                .iter()
                .enumerate()
                .map(|(index, part)| {
                    if (unc && index < 4) || (drive_root && index == 0) {
                        Ok(Component::Literal(part.clone()))
                    } else {
                        component(part)
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            patterns.push(components);
        }
        Ok(Self {
            patterns,
            windows,
            empty: pattern.is_empty(),
        })
    }
    pub(super) fn matches(&self, value: &str) -> bool {
        if self.empty {
            return value.is_empty();
        }
        let portable = if self.windows {
            value.replace('\\', "/")
        } else {
            value.to_owned()
        };
        let file = split(&portable, self.windows);
        for original in &self.patterns {
            let mut replacement = None;
            let mut file_index = 0;
            let mut pattern_index = 0;
            if self.windows {
                let file_drive = if file.first().is_some_and(|part| drive(part)) {
                    Some(0)
                } else if file.first().is_some_and(String::is_empty)
                    && file.get(1).is_some_and(String::is_empty)
                    && file.get(2).is_some_and(|part| part == "?")
                    && file.get(3).is_some_and(|part| drive(part))
                {
                    Some(3)
                } else {
                    None
                };
                let pattern_drive = if original
                    .first()
                    .and_then(Component::literal)
                    .is_some_and(drive)
                {
                    Some(0)
                } else if original.first().and_then(Component::literal) == Some("")
                    && original.get(1).and_then(Component::literal) == Some("")
                    && original.get(2).and_then(Component::literal) == Some("?")
                    && original
                        .get(3)
                        .and_then(Component::literal)
                        .is_some_and(drive)
                {
                    Some(3)
                } else {
                    None
                };
                if let (Some(fi), Some(pi)) = (file_drive, pattern_drive) {
                    if file[fi].eq_ignore_ascii_case(original[pi].literal().unwrap()) {
                        let mut updated = original.clone();
                        updated[pi] = Component::Literal(file[fi].clone());
                        replacement = Some(updated);
                        file_index = fi;
                        pattern_index = pi;
                    }
                }
            }
            let pattern = replacement.as_deref().unwrap_or(original);
            let matched = if pattern
                .iter()
                .any(|part| matches!(part, Component::Globstar))
            {
                globstar(&file, pattern, file_index, pattern_index)
            } else {
                regular(&file, pattern, file_index, pattern_index)
            };
            if matched {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    #[test]
    fn matches_installed_minimatch_flags_across_syntax_and_platforms() {
        let fixture: Value =
            serde_json::from_str(include_str!("../fixtures/glob-matcher.json")).unwrap();
        let mut differences = Vec::new();
        for case in fixture.as_array().unwrap() {
            let pattern = case["pattern"].as_str().unwrap();
            let matcher = Matcher::new(pattern, case["windows"] == true);
            if case.get("error").is_some() {
                if matcher.is_ok() {
                    differences.push(format!("pattern={pattern:?}: expected compilation failure"));
                }
                continue;
            }
            let matcher = match matcher {
                Ok(matcher) => matcher,
                Err(error) => {
                    differences.push(format!("pattern={pattern:?}: {error}"));
                    continue;
                }
            };
            for check in case["checks"].as_array().unwrap() {
                let path = check[0].as_str().unwrap();
                if matcher.matches(path) != (check[1] == true) {
                    differences.push(format!(
                        "pattern={pattern:?} path={path:?} windows={} expected={}",
                        case["windows"], check[1]
                    ));
                }
            }
        }
        assert!(
            differences.is_empty(),
            "{} differences:\n{}",
            differences.len(),
            differences
                .iter()
                .take(100)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
}
