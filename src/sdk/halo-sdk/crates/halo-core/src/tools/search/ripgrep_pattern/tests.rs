use super::*;
use std::{
    future::pending,
    sync::atomic::{AtomicUsize, Ordering},
};

#[test]
fn only_end_line_nodes_are_rewritten() {
    for pattern in [
        "[]$]",
        "[^]$]",
        r"\$",
        "($",
        r"\p{no_such_property}$",
        r"[\x0d]$",
        "(?-R:hello$)",
    ] {
        assert!(rewrite(pattern).is_none(), "{pattern}");
    }
    for (pattern, expected) in [
        ("[]$]$", "[]$](?R:$)"),
        ("[^]$]$", "[^]$](?R:$)"),
        (r"\$a$|b$", r"\$a(?R:$)|b(?R:$)"),
        ("(?x)^abc # ]$ \\r\n $", "(?x)^abc # ]$ \\r\n (?R:$)"),
    ] {
        assert_eq!(rewrite(pattern).as_deref(), Some(expected));
    }
}

#[tokio::test]
async fn probe_distinguishes_the_rg13_diagnostic_from_other_failures() {
    let dir = std::env::temp_dir().join(format!("rg-probe-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    #[cfg(unix)]
    let program = {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("rg");
        std::fs::write(&path, "#!/bin/sh\nIFS= read -r input || exit 9\n/bin/cat diagnostic >&2\n/bin/cat output\nread -r code < status\nexit \"$code\"\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    };
    #[cfg(windows)]
    let program = {
        let path = dir.join("rg.cmd");
        std::fs::write(&path, "@echo off\r\nset /p input=\r\ntype diagnostic 1>&2\r\ntype output\r\nset /p code=<status\r\nexit /b %code%\r\n").unwrap();
        path
    };
    let rg13 = "regex parse error:\n    x(?R:$)\n       ^\nerror: unrecognized flag\n";
    let cases = [
        (2, rg13, "", Ok(false)),
        (
            2,
            "regex parse error:\n    x(?R:$)\nerror: unclosed group\n",
            "",
            Err(()),
        ),
        (
            2,
            "regex parse error:\n    (?Z)\nerror: unrecognized flag\n",
            "",
            Err(()),
        ),
        (2, "temporary I/O error\n", "", Err(())),
        (3, rg13, "", Err(())),
        (0, "", "", Err(())),
        (0, "", "x\n", Ok(true)),
    ];
    let mut results = Vec::new();
    for (code, diagnostic, output, _) in cases {
        std::fs::write(dir.join("status"), format!("{code}\n")).unwrap();
        std::fs::write(dir.join("diagnostic"), diagnostic).unwrap();
        std::fs::write(dir.join("output"), output).unwrap();
        results.push(tokio::time::timeout(Duration::from_secs(5), probe(&program)).await);
    }
    std::fs::remove_dir_all(dir).unwrap();
    for (result, (code, diagnostic, output, expected)) in results.into_iter().zip(cases) {
        assert_eq!(
            result.unwrap(),
            expected,
            "exit={code} stderr={diagnostic:?} stdout={output:?}"
        );
    }
}

#[tokio::test]
async fn concurrent_callers_share_one_probe_and_distinct_file_versions_do_not() {
    let mut id = Executable::identify(std::env::current_exe().unwrap()).unwrap();
    let cell_for = |id: &Executable| cell(id).unwrap();
    let a = cell_for(&id);
    let calls = AtomicUsize::new(0);
    let check = || async {
        calls.fetch_add(1, Ordering::SeqCst);
        tokio::task::yield_now().await;
        Ok(true)
    };
    let queries = (0..8).map(|_| capability(&a, Duration::from_secs(1), check));
    assert!(futures::future::join_all(queries)
        .await
        .into_iter()
        .all(|value| value));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(Arc::ptr_eq(&cell_for(&id), &a));
    id.object.1 = id.object.1.wrapping_add(1);
    assert!(!Arc::ptr_eq(&cell_for(&id), &a));
}

#[tokio::test]
async fn timeout_error_and_dropped_initializer_do_not_persist_a_negative_result() {
    let cell: Cell = Default::default();
    let mut interrupted = Box::pin(capability(&cell, Duration::from_secs(60), pending));
    assert!(futures::poll!(interrupted.as_mut()).is_pending());
    drop(interrupted);
    assert!(!capability(&cell, Duration::from_millis(1), pending).await);
    assert!(!capability(&cell, Duration::from_secs(1), || async { Err(()) }).await);
    assert!(capability(&cell, Duration::from_secs(1), || async { Ok(true) }).await);
    let unsupported: Cell = Default::default();
    assert!(!capability(&unsupported, Duration::from_secs(1), || async { Ok(false) }).await);
    assert!(
        !capability(&unsupported, Duration::from_secs(1), || async {
            panic!("unexpected second probe")
        })
        .await
    );
}
