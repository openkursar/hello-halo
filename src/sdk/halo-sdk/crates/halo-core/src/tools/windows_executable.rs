use std::path::PathBuf;

pub(super) fn is_bare_program(program: &str) -> bool {
    !program.is_empty() && !program.contains(['/', '\\', ':', '.', '\0'])
}

pub(super) fn resolve(
    program: &str,
    path: &str,
    extensions: Option<&str>,
    keep_searching: impl Fn() -> bool,
) -> Option<PathBuf> {
    if !is_bare_program(program) {
        return None;
    }
    let extensions: Vec<_> = extensions
        .filter(|value| value.split(';').any(|entry| !entry.trim().is_empty()))
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .filter_map(|entry| {
            let entry = entry.trim();
            let extension = entry.strip_prefix('.').unwrap_or(entry);
            [".COM", ".EXE", ".BAT", ".CMD"]
                .into_iter()
                .find(|candidate| candidate[1..].eq_ignore_ascii_case(extension))
        })
        .collect();
    for directory in std::env::split_paths(path).filter(|path| path.is_absolute()) {
        for extension in &extensions {
            if !keep_searching() {
                return None;
            }
            let candidate = directory.join(format!("{program}{extension}"));
            if candidate.is_file() && keep_searching() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_bare_program_uses_path_and_extension_order() {
        let root = std::env::temp_dir().join(format!("halo-program-{}", uuid::Uuid::new_v4()));
        let first = root.join("with spaces (测试)");
        let second = root.join("other");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        for file in ["runner.CMD", "runner.BAT", "runner.JS"] {
            std::fs::write(first.join(file), "fixture").unwrap();
        }
        std::fs::write(second.join("runner.EXE"), "fixture").unwrap();
        let paths = std::env::join_paths([PathBuf::new(), "relative".into(), first.clone(), second.clone()]).unwrap();
        let paths = paths.to_str().unwrap();
        let lookup = |program, extensions| resolve(program, paths, extensions, || true);
        assert_eq!(lookup("runner", Some(".js;.exe;.cmd;.bat")), Some(first.join("runner.CMD")));
        assert_eq!(lookup("runner", None), Some(first.join("runner.BAT")));
        assert_eq!(lookup("runner", Some(".exe")), Some(second.join("runner.EXE")));
        assert_eq!(lookup("runner", Some("EXE; cmd ;.BAT")), Some(first.join("runner.CMD")));
        assert_eq!(lookup("runner", Some("CMD;EXE")), Some(first.join("runner.CMD")));
        for empty in ["", "   ", "; ;"] {
            assert_eq!(lookup("runner", Some(empty)), Some(first.join("runner.BAT")));
        }
        assert_eq!(lookup("runner", Some("JS")), None);
        for explicit in ["runner.cmd", "C:runner", r".\runner", "somewhere/runner"] {
            assert_eq!(lookup(explicit, None), None, "{explicit}");
        }
        assert!(lookup("not-installed", None).is_none());
        let probes = std::cell::Cell::new(0);
        assert_eq!(resolve("runner", paths, Some("EXE"), || {
            probes.set(probes.get() + 1);
            probes.get() == 1
        }), None);
        assert_eq!(probes.get(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn lookup_never_falls_back_for_empty_or_relative_paths() {
        for path in ["", ".", "bin"] {
            assert_eq!(resolve("rg", path, Some("EXE;CMD"), || true), None);
        }
    }
}
