// The path algorithms below are ported from Node.js v22.18.0 lib/path.js
// (https://github.com/nodejs/node/blob/v22.18.0/lib/path.js); see
// LICENSE.node-path in this directory.
//
// Copyright Node.js contributors. All rights reserved.
// Copyright Joyent, Inc. and other Node contributors. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

//! File tool paths, resolved exactly as the host resolves them before it
//! approves a call (`resolveToolPath` in the Halo host): trimmed, `~` expanded
//! with Node's `os.homedir()` rules, Git Bash drive paths read as Windows
//! drives, then joined and normalized with Node's `path` semantics and NFC.
//! The Node algorithms are ported rather than approximated with `std::path`,
//! whose joining and normalization differ in edge cases such as `~//etc`.

use std::path::PathBuf;
use unicode_normalization::UnicodeNormalization;

/// The home directory as Node's `os.homedir()` finds it: the environment
/// variable when set, even if empty, otherwise the account's profile directory.
pub(crate) fn home_directory() -> String {
    let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(variable)
        .map(PathBuf::from)
        .or_else(std::env::home_dir)
        .map(|home| home.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(crate) fn resolve_tool_path(
    cwd: &str,
    raw: &str,
    home: impl FnOnce() -> String,
    windows: bool,
) -> String {
    let path = crate::js::trim_js(raw);
    let resolved = if path.is_empty() {
        resolve(windows, &[cwd])
    } else if path == "~" {
        home()
    } else if path.starts_with("~/") || (windows && path.starts_with("~\\")) {
        join(windows, &home(), &path[2..])
    } else {
        let bytes = path.as_bytes();
        if windows && bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
            let drive = format!("{}:\\{}", bytes[1].to_ascii_uppercase() as char, &path[3..]);
            resolve(windows, &[cwd, &drive])
        } else {
            resolve(windows, &[cwd, path])
        }
    };
    resolved.nfc().collect()
}

fn is_separator(windows: bool, byte: u8) -> bool {
    byte == b'/' || (windows && byte == b'\\')
}

fn is_drive_letter(byte: u8) -> bool {
    byte.is_ascii_alphabetic()
}

fn process_cwd() -> String {
    std::env::current_dir()
        .map(|cwd| cwd.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Node's `normalizeString`: resolves `.` and `..` segments. Separators and
/// dots are ASCII, so byte offsets select the same segments as UTF-16 offsets.
fn normalize_string(path: &str, allow_above_root: bool, separator: char, windows: bool) -> String {
    let bytes = path.as_bytes();
    let mut result = String::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let mut code = 0u8;
    for index in 0..=bytes.len() {
        if index < bytes.len() {
            code = bytes[index];
        } else if is_separator(windows, code) {
            break;
        } else {
            code = b'/';
        }
        let index = index as isize;
        if is_separator(windows, code) {
            if last_slash == index - 1 || dots == 1 {
            } else if dots == 2 {
                if result.len() < 2 || last_segment_length != 2 || !result.ends_with("..") {
                    if result.len() > 2 {
                        match result.rfind(separator) {
                            None => {
                                result.clear();
                                last_segment_length = 0;
                            }
                            Some(position) => {
                                result.truncate(position);
                                last_segment_length = result.len()
                                    - result.rfind(separator).map_or(0, |found| found + 1);
                            }
                        }
                        last_slash = index;
                        dots = 0;
                        continue;
                    } else if !result.is_empty() {
                        result.clear();
                        last_segment_length = 0;
                        last_slash = index;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !result.is_empty() {
                        result.push(separator);
                    }
                    result.push_str("..");
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..index as usize];
                if !result.is_empty() {
                    result.push(separator);
                }
                result.push_str(segment);
                last_segment_length = (index - last_slash - 1) as usize;
            }
            last_slash = index;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    result
}

fn resolve(windows: bool, paths: &[&str]) -> String {
    if windows {
        win32_resolve(paths)
    } else {
        posix_resolve(paths)
    }
}

fn join(windows: bool, first: &str, second: &str) -> String {
    if windows {
        win32_join(first, second)
    } else {
        posix_join(first, second)
    }
}

fn posix_resolve(paths: &[&str]) -> String {
    let mut resolved = String::new();
    let mut absolute = false;
    for path in paths.iter().rev() {
        if absolute {
            break;
        }
        if path.is_empty() {
            continue;
        }
        resolved = format!("{path}/{resolved}");
        absolute = path.starts_with('/');
    }
    if !absolute {
        let cwd = process_cwd();
        absolute = cwd.starts_with('/');
        resolved = format!("{cwd}/{resolved}");
    }
    let resolved = normalize_string(&resolved, !absolute, '/', false);
    if absolute {
        format!("/{resolved}")
    } else if resolved.is_empty() {
        ".".into()
    } else {
        resolved
    }
}

fn posix_normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".into();
    }
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut normalized = normalize_string(path, !absolute, '/', false);
    if normalized.is_empty() {
        if absolute {
            return "/".into();
        }
        return if trailing { "./".into() } else { ".".into() };
    }
    if trailing {
        normalized.push('/');
    }
    if absolute {
        format!("/{normalized}")
    } else {
        normalized
    }
}

fn posix_join(first: &str, second: &str) -> String {
    let joined = [first, second]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        return ".".into();
    }
    posix_normalize(&joined)
}

/// The root of a Windows path that starts with a separator: its UNC device,
/// where the root ends, and the normalized form when the path is only a UNC
/// root. Shared by Node's `win32.resolve` and `win32.normalize`.
struct Win32Root {
    device: Option<String>,
    end: usize,
    unc_only: Option<String>,
}

fn win32_unc_or_rooted(path: &str) -> Win32Root {
    let bytes = path.as_bytes();
    let length = bytes.len();
    let mut root = Win32Root { device: None, end: 1, unc_only: None };
    if length < 2 || !is_separator(true, bytes[1]) {
        return root;
    }
    root.end = 0;
    let mut cursor = 2;
    let mut last = cursor;
    while cursor < length && !is_separator(true, bytes[cursor]) {
        cursor += 1;
    }
    if cursor < length && cursor != last {
        let server = &path[last..cursor];
        last = cursor;
        while cursor < length && is_separator(true, bytes[cursor]) {
            cursor += 1;
        }
        if cursor < length && cursor != last {
            last = cursor;
            while cursor < length && !is_separator(true, bytes[cursor]) {
                cursor += 1;
            }
            if cursor == length {
                root.unc_only = Some(format!("\\\\{server}\\{}\\", &path[last..]));
            }
            if cursor == length || cursor != last {
                root.device = Some(format!("\\\\{server}\\{}", &path[last..cursor]));
                root.end = cursor;
            }
        }
    }
    root
}

fn win32_resolve(paths: &[&str]) -> String {
    let mut resolved_device = String::new();
    let mut resolved_tail = String::new();
    let mut resolved_absolute = false;
    let mut index = paths.len() as isize - 1;
    while index >= -1 {
        let path = if index >= 0 {
            let path = paths[index as usize].to_owned();
            index -= 1;
            if path.is_empty() {
                continue;
            }
            path
        } else if resolved_device.is_empty() {
            index -= 1;
            process_cwd()
        } else {
            index -= 1;
            let path = std::env::var(format!("={resolved_device}")).unwrap_or_else(|_| process_cwd());
            let bytes = path.as_bytes();
            if bytes.len() > 2
                && !bytes[..2].eq_ignore_ascii_case(resolved_device.as_bytes())
                && bytes[2] == b'\\'
            {
                format!("{resolved_device}\\")
            } else {
                path
            }
        };
        if path.is_empty() {
            continue;
        }
        let bytes = path.as_bytes();
        let length = bytes.len();
        let mut root_end = 0;
        let mut device = String::new();
        let mut absolute = false;
        let code = bytes[0];
        if length == 1 {
            if is_separator(true, code) {
                root_end = 1;
                absolute = true;
            }
        } else if is_separator(true, code) {
            let root = win32_unc_or_rooted(&path);
            absolute = true;
            root_end = root.end;
            if let Some(found) = root.device {
                device = found;
            }
        } else if is_drive_letter(code) && bytes[1] == b':' {
            device = path[..2].to_owned();
            root_end = 2;
            if length > 2 && is_separator(true, bytes[2]) {
                absolute = true;
                root_end = 3;
            }
        }
        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if device.to_lowercase() != resolved_device.to_lowercase() {
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }
        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            resolved_tail = format!("{}\\{resolved_tail}", &path[root_end..]);
            resolved_absolute = absolute;
            if absolute && !resolved_device.is_empty() {
                break;
            }
        }
    }
    let tail = normalize_string(&resolved_tail, !resolved_absolute, '\\', true);
    if resolved_absolute {
        format!("{resolved_device}\\{tail}")
    } else {
        let relative = format!("{resolved_device}{tail}");
        if relative.is_empty() { ".".into() } else { relative }
    }
}

const WINDOWS_RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn is_windows_reserved_name(path: &str, colon: Option<usize>) -> bool {
    // Node slices to the colon; without one (-1) it drops the last UTF-16 unit,
    // which splits an astral character and can then match no reserved name.
    let end = match colon {
        Some(colon) => colon,
        None => match path.char_indices().last() {
            Some((_, last)) if last.len_utf16() == 2 => return false,
            Some((index, _)) => index,
            None => 0,
        },
    };
    WINDOWS_RESERVED_NAMES.contains(&path[..end].to_uppercase().as_str())
}

fn win32_normalize(path: &str) -> String {
    let bytes = path.as_bytes();
    let length = bytes.len();
    if length == 0 {
        return ".".into();
    }
    if path.encode_utf16().count() == 1 {
        return if path == "/" { "\\".into() } else { path.to_owned() };
    }
    let code = bytes[0];
    let mut root_end = 0;
    let mut device: Option<String> = None;
    let mut absolute = false;
    if is_separator(true, code) {
        absolute = true;
        let root = win32_unc_or_rooted(path);
        if let Some(only) = root.unc_only {
            return only;
        }
        root_end = root.end;
        device = root.device;
    } else if let Some(colon) = path.find(':').filter(|colon| *colon > 0) {
        if is_drive_letter(code) && colon == 1 {
            device = Some(path[..2].to_owned());
            root_end = 2;
            if length > 2 && is_separator(true, bytes[2]) {
                absolute = true;
                root_end = 3;
            }
        } else if is_windows_reserved_name(path, Some(colon)) {
            device = Some(path[..=colon].to_owned());
            root_end = colon + 1;
        }
    }
    let mut tail = if root_end < length {
        normalize_string(&path[root_end..], !absolute, '\\', true)
    } else {
        String::new()
    };
    if tail.is_empty() && !absolute {
        tail = ".".into();
    }
    if !tail.is_empty() && is_separator(true, bytes[length - 1]) {
        tail.push('\\');
    }
    if !absolute && device.is_none() && path.contains(':') {
        let tail_bytes = tail.as_bytes();
        if tail_bytes.len() >= 2 && is_drive_letter(tail_bytes[0]) && tail_bytes[1] == b':' {
            return format!(".\\{tail}");
        }
        for (index, _) in path.match_indices(':') {
            if index == length - 1 || is_separator(true, bytes[index + 1]) {
                return format!(".\\{tail}");
            }
        }
    }
    if is_windows_reserved_name(path, path.find(':')) {
        return format!(".\\{}{tail}", device.as_deref().unwrap_or(""));
    }
    match device {
        None if absolute => format!("\\{tail}"),
        None => tail,
        Some(device) if absolute => format!("{device}\\{tail}"),
        Some(device) => format!("{device}{tail}"),
    }
}

fn win32_join(first: &str, second: &str) -> String {
    let parts: Vec<&str> = [first, second].into_iter().filter(|part| !part.is_empty()).collect();
    let Some(first_part) = parts.first().copied() else {
        return ".".into();
    };
    let mut joined = parts.join("\\");
    let first_bytes = first_part.as_bytes();
    let mut needs_replace = true;
    let mut slashes = 0;
    if is_separator(true, first_bytes[0]) {
        slashes += 1;
        if first_bytes.len() > 1 && is_separator(true, first_bytes[1]) {
            slashes += 1;
            if first_bytes.len() > 2 {
                if is_separator(true, first_bytes[2]) {
                    slashes += 1;
                } else {
                    needs_replace = false;
                }
            }
        }
    }
    if needs_replace {
        let bytes = joined.as_bytes();
        while slashes < bytes.len() && is_separator(true, bytes[slashes]) {
            slashes += 1;
        }
        if slashes >= 2 {
            joined = format!("\\{}", &joined[slashes..]);
        }
    }
    win32_normalize(&joined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn resolution_matches_the_host_resolver_fixture() {
        let fixture: Value = serde_json::from_str(include_str!("tool_path_parity.json")).unwrap();
        let cases = fixture["cases"].as_array().unwrap();
        assert!(cases.len() > 100);
        for case in cases {
            let windows = case["platform"] == "win32";
            let home = case["home"].as_str().unwrap().to_owned();
            let actual = resolve_tool_path(
                case["cwd"].as_str().unwrap(),
                case["raw"].as_str().unwrap(),
                || home,
                windows,
            );
            assert_eq!(actual, case["expected"].as_str().unwrap(), "{case}");
        }
    }

    #[test]
    fn home_follows_node_when_the_variable_is_missing() {
        let variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        if std::env::var_os("HALO_FILE_HOME_PROBE").is_some() {
            let expected = std::env::home_dir().unwrap().to_string_lossy().into_owned();
            assert!(std::env::var_os(variable).is_none());
            assert!(!expected.is_empty());
            assert_eq!(home_directory(), expected);
            return;
        }
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tools::file::tool_path::tests::home_follows_node_when_the_variable_is_missing", "--test-threads=1"])
            .env("HALO_FILE_HOME_PROBE", "1")
            .env_remove(variable)
            .status()
            .unwrap();
        assert!(status.success());
        if std::env::var_os(variable).is_some_and(|home| !home.is_empty()) {
            assert_eq!(home_directory(), std::env::var(variable).unwrap());
        }
    }
}
