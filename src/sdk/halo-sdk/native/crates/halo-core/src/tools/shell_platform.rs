use serde_json::Value;
use std::collections::HashSet;

pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
pub(super) fn windows_to_posix(value: &str) -> String {
    let portable = value.replace('\\', "/");
    let bytes = portable.as_bytes();
    if bytes.first().is_some_and(u8::is_ascii_alphabetic)
        && bytes.get(1) == Some(&b':')
        && bytes.get(2) == Some(&b'/')
    {
        format!("/{}{}", portable[..1].to_lowercase(), &portable[2..])
    } else {
        portable
    }
}
pub(super) fn posix_to_windows(value: &str) -> String {
    let parts: Vec<_> = value.split('/').collect();
    if parts[0].is_empty() {
        let drive = if parts.get(1) == Some(&"cygdrive") {
            2
        } else {
            1
        };
        if let Some(letter) = parts
            .get(drive)
            .filter(|letter| letter.len() == 1 && letter.as_bytes()[0].is_ascii_alphabetic())
        {
            let rest = &parts[drive + 1..];
            return format!("{}:\\{}", letter.to_uppercase(), rest.join("\\"));
        }
    }
    parts.join("\\")
}
pub(super) fn null_redirect(command: &str) -> String {
    let mut output = String::new();
    let mut copied = 0;
    let mut scan = 0;
    while let Some(relative) = command[scan..].find('>') {
        let mut target = scan + relative + 1;
        while let Some(character) = command[target..]
            .chars()
            .next()
            .filter(|character| crate::js::is_whitespace(*character))
        {
            target += character.len_utf8();
        }
        scan = target;
        if command
            .get(target..target + 3)
            .is_none_or(|word| !word.eq_ignore_ascii_case("nul"))
        {
            continue;
        }
        let following = command[target + 3..].chars().next();
        if following.is_none_or(|character| {
            crate::js::is_whitespace(character) || "|&;)".contains(character)
        }) {
            output.push_str(&command[copied..target]);
            output.push_str("/dev/null");
            copied = target + 3;
            scan = copied;
        }
    }
    if copied == 0 {
        return command.into();
    }
    output.push_str(&command[copied..]);
    output
}

pub(super) fn owned_windows_processes(
    root: u32,
    native: &[Value],
    posix: &str,
    current_pid: u32,
) -> Vec<u32> {
    let mut native_ids = vec![root];
    let mut owned: HashSet<_> = [root].into_iter().collect();
    let mut posix_ids = HashSet::new();
    let rows: Vec<_> = posix
        .split('\n')
        .filter_map(|line| {
            let cells: Vec<_> = crate::js::trim_start_js(line)
                .split(crate::js::is_whitespace)
                .filter(|cell| !cell.is_empty())
                .take(4)
                .collect();
            if cells.len() != 4 {
                return None;
            }
            Some((
                cells[0].parse::<u32>().ok()?,
                cells[1].parse::<u32>().ok()?,
                cells[2].parse::<u32>().ok()?,
                cells[3].parse::<u32>().ok()?,
            ))
        })
        .collect();
    loop {
        let mut changed = false;
        for row in native {
            if let (Some(pid), Some(parent)) = (
                crate::js::safe_integer(&row["pid"]),
                crate::js::safe_integer(&row["parent"]),
            ) {
                if pid >= 0
                    && pid <= u32::MAX as i64
                    && parent >= 0
                    && parent <= u32::MAX as i64
                    && owned.contains(&(parent as u32))
                    && owned.insert(pid as u32)
                {
                    native_ids.push(pid as u32);
                    changed = true;
                }
            }
        }
        for (pid, parent, _, native) in &rows {
            if owned.contains(native) || posix_ids.contains(parent) {
                if owned.insert(*native) {
                    native_ids.push(*native);
                    changed = true;
                }
                if posix_ids.insert(*pid) {
                    changed = true;
                }
            }
        }
        if !changed {
            break;
        }
    }
    native_ids
        .into_iter()
        .filter(|pid| *pid > 0 && *pid != current_pid)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_paths_redirections_and_process_ancestry_match_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/shell-platform.json")).unwrap();
        for case in fixture["windowsToPosix"].as_array().unwrap() {
            assert_eq!(
                windows_to_posix(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["posixToWindows"].as_array().unwrap() {
            assert_eq!(
                posix_to_windows(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["nullRedirect"].as_array().unwrap() {
            assert_eq!(
                null_redirect(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["quotes"].as_array().unwrap() {
            assert_eq!(
                quote(case["input"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["ancestry"].as_array().unwrap() {
            assert_eq!(
                serde_json::json!(owned_windows_processes(
                    case["root"].as_u64().unwrap() as u32,
                    case["native"].as_array().unwrap(),
                    case["posix"].as_str().unwrap(),
                    case["self"].as_u64().unwrap() as u32
                )),
                case["expected"]
            );
        }
    }
}
