use super::*;
use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

struct NoHost;
#[async_trait]
impl crate::bridge::HostBridge for NoHost {
    async fn call(&self, method: &str, _: Value, _: &CancellationToken) -> Result<Value> {
        Err(Error::new("UNEXPECTED_CALLBACK", method))
    }
}

struct Fixture {
    root: PathBuf,
    tools: FileTools,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("halo-file-text-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let store = super::super::output::OutputStore::new(
            &json!({"persistSession":false,"nativeTempDirectory":root.join(".outputs")}),
        );
        let tools = FileTools::new(&json!({"cwd":root}), Arc::new(NoHost)).with_output_store(store);
        Self { root, tools }
    }
    fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    fn context(&self) -> ToolContext {
        ToolContext {
            session_id: "file-text".into(),
            cwd: self.root.to_string_lossy().into_owned(),
            env: json!({}),
            current_turn: 0,
            tool_use_id: "call".into(),
            cancellation: CancellationToken::new(),
            harness: crate::harness::baseline(),
        }
    }
    async fn call(&self, name: &str, input: Value) -> Value {
        self.tools.execute_admitted(name, &input, &self.context(), None).await.unwrap()
    }
    async fn read_within(&self, budget: usize, input: Value) -> Value {
        let tools = FileTools::new(&json!({"cwd":self.root,"toolResultBudget":budget}), Arc::new(NoHost));
        tools.execute_admitted("Read", &input, &self.context(), None).await.unwrap()
    }
    async fn read(&self, path: &Path) -> Value {
        let read = self.call("Read", json!({"file_path":path})).await;
        assert_eq!(read["isError"], false, "{read}");
        read
    }
    async fn edit(&self, path: &Path, old: &str, new: &str) -> Value {
        self.call("Edit", json!({"file_path":path,"old_string":old,"new_string":new})).await
    }
    async fn write(&self, path: &Path, content: &str) -> Value {
        self.call("Write", json!({"file_path":path,"content":content})).await
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn content(result: &Value) -> &str {
    result["content"].as_str().unwrap()
}
fn touch(path: &Path, seconds: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(seconds))
        .unwrap();
}

#[tokio::test]
async fn write_handle_rejects_stale_bytes_even_when_metadata_matches() {
    let f = Fixture::new();
    let path = f.path("stale.txt");
    let mut actual = vec![b'a'; 128 * 1024 + 1];
    *actual.last_mut().unwrap() = b'b';
    std::fs::write(&path, &actual).unwrap();
    let mut expected = snapshot(&path).await.unwrap();
    // Simulate the previous bytes with indistinguishable metadata on every filesystem.
    *expected.bytes.last_mut().unwrap() = b'a';
    let mut guard = lock(&path).await;
    let error = write_snapshot(&path, b"updated", Some(&expected), &mut guard)
        .await
        .unwrap_err();
    assert_eq!(error.code, "FILE_CHANGED");
    assert!(!guard.writing);
    assert_eq!(std::fs::read(&path).unwrap(), actual);

    expected.bytes = actual;
    write_snapshot(&path, b"updated", Some(&expected), &mut guard)
        .await
        .unwrap();
    assert!(guard.writing);
    assert_eq!(std::fs::read(&path).unwrap(), b"updated");
}

/// The path a result names after "saved at ".
fn saved_original(result: &Value) -> PathBuf {
    let text = content(result);
    let (_, path) = text.split_once("saved at ").unwrap_or_else(|| panic!("no saved path: {text}"));
    PathBuf::from(path.trim_end_matches('.'))
}

#[tokio::test]
async fn undecodable_text_is_changed_after_its_exact_bytes_are_saved() {
    let f = Fixture::new();
    let harness = crate::harness::baseline();
    let gbk: &[u8] = b"// \xd6\xd0\xce\xc4\xd7\xa2\xca\xcd\nint main() { return 0; }\n";
    let latin1: &[u8] = b"caf\xe9 = 1\r\nx = 2\r\n";
    for (name, bytes, old, new, edited) in [
        ("gbk.c", gbk, "return 0;", "return 1;", &b"// \xd6\xd0\xce\xc4\xd7\xa2\xca\xcd\nint main() { return 1; }\n"[..]),
        ("latin1.txt", latin1, "x = 2", "x = 3", &b"caf\xe9 = 1\r\nx = 3\r\n"[..]),
    ] {
        let path = f.path(name);
        std::fs::write(&path, bytes).unwrap();
        let read = f.read(&path).await;
        assert!(content(&read).contains('\u{fffd}'));
        assert!(content(&read).contains(harness.text(TextId::ToolsFileReadUndecodable)));

        let edit = f.edit(&path, old, new).await;
        assert_eq!(edit["isError"], false, "{edit}");
        assert!(content(&edit).contains("Bytes outside the replaced text are unchanged"), "{edit}");
        assert_eq!(std::fs::read(&path).unwrap(), edited);
        assert_eq!(std::fs::read(saved_original(&edit)).unwrap(), bytes);

        let write = f.write(&path, "replacement\n").await;
        assert_eq!(write["isError"], false, "{write}");
        assert_eq!(std::fs::read(&path).unwrap(), b"replacement\n");
        assert_eq!(std::fs::read(saved_original(&write)).unwrap(), edited);
    }

    // Without a place to keep the original, nothing is written and the result names another way.
    let path = f.path("unsaved.txt");
    std::fs::write(&path, latin1).unwrap();
    let tools = FileTools::new(&json!({"cwd":f.root}), Arc::new(NoHost));
    let call = |name: &'static str, input: Value| {
        let tools = &tools;
        let context = f.context();
        async move { tools.execute_admitted(name, &input, &context, None).await.unwrap() }
    };
    assert_eq!(call("Read", json!({"file_path":path})).await["isError"], false);
    for refused in [
        call("Edit", json!({"file_path":path,"old_string":"x = 2","new_string":"x = 3"})).await,
        call("Write", json!({"file_path":path,"content":"replacement\n"})).await,
    ] {
        assert_eq!(content(&refused), harness.text(TextId::ToolsFileOriginalNotSaved));
    }
    assert_eq!(std::fs::read(&path).unwrap(), latin1);

    // Malformed UTF-16 has no byte-exact text positions; Write still replaces it.
    let path = f.path("broken16.txt");
    let broken: &[u8] = &[0xFF, 0xFE, b'a', 0, b'b'];
    std::fs::write(&path, broken).unwrap();
    f.read(&path).await;
    assert_eq!(content(&f.edit(&path, "a", "c").await), harness.text(TextId::ToolsFileUndecodable));
    assert_eq!(std::fs::read(&path).unwrap(), broken);
    let write = f.write(&path, "c").await;
    assert_eq!(write["isError"], false, "{write}");
    assert_eq!(std::fs::read(saved_original(&write)).unwrap(), broken);
}

#[tokio::test]
async fn crlf_files_are_read_as_lf_and_keep_their_endings_when_edited() {
    let f = Fixture::new();
    let path = f.path("Program.cs");
    std::fs::write(&path, "class A {\r\n    int x = 1;\r\n    int y = 2;\r\n}\r\n").unwrap();
    let read = f.read(&path).await;
    assert_eq!(content(&read), "1\tclass A {\n2\t    int x = 1;\n3\t    int y = 2;\n4\t}\n5\t\n");

    let edit = f.edit(&path, "    int x = 1;\n    int y = 2;", "    int x = 10;\n    int y = 20;").await;
    assert_eq!(edit["isError"], false, "{edit}");
    let edit = f.edit(&path, "    int x = 10;", "    int x = 10;\n    int z = 30;").await;
    assert_eq!(edit["isError"], false, "{edit}");
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        "class A {\r\n    int x = 10;\r\n    int z = 30;\r\n    int y = 20;\r\n}\r\n"
    );

    // A model that echoes CRLF still matches, and bytes outside the edit keep their endings.
    let mixed = f.path("mixed.txt");
    std::fs::write(&mixed, "a\r\nb\nc\r\nd\r\n").unwrap();
    f.read(&mixed).await;
    let edit = f.edit(&mixed, "c\r\nd", "C\nD").await;
    assert_eq!(edit["isError"], false, "{edit}");
    assert_eq!(std::fs::read_to_string(&mixed).unwrap(), "a\r\nb\nC\r\nD\r\n");

    let lf = f.path("unix.txt");
    std::fs::write(&lf, "one\ntwo\n").unwrap();
    f.read(&lf).await;
    assert_eq!(f.edit(&lf, "one\n", "one\r\nhalf\n").await["isError"], false);
    assert_eq!(std::fs::read_to_string(&lf).unwrap(), "one\nhalf\ntwo\n");
}

#[tokio::test]
async fn an_edit_that_changes_nothing_writes_nothing() {
    let f = Fixture::new();
    let harness = crate::harness::baseline();
    let path = f.path("same.txt");
    std::fs::write(&path, "a\r\nb\r\n").unwrap();
    f.read(&path).await;
    let before = std::fs::metadata(&path).unwrap().modified().unwrap();
    let edit = f.edit(&path, "a\nb", "a\r\nb").await;
    assert_eq!(edit["isError"], true);
    assert_eq!(content(&edit), harness.text(TextId::ToolsFileEditNoChange));
    assert_eq!(std::fs::read(&path).unwrap(), b"a\r\nb\r\n");
    assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
}

#[tokio::test]
async fn replace_all_is_sized_before_the_result_is_built() {
    let f = Fixture::new();
    let path = f.path("many.txt");
    let original = "a\n".repeat(100_000);
    std::fs::write(&path, &original).unwrap();
    f.read(&path).await;
    let edit = f
        .call("Edit", json!({"file_path":path,"old_string":"a","new_string":"b".repeat(100),"replace_all":true}))
        .await;
    assert_eq!(edit["isError"], true);
    assert!(content(&edit).contains(&MAX_BYTES.to_string()), "{edit}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
    let edit = f.call("Edit", json!({"file_path":path,"old_string":"a","new_string":"b"})).await;
    assert!(content(&edit).contains("occurs 100000 times"), "{edit}");
}

#[tokio::test]
async fn crlf_read_state_recorded_as_normalized_content_is_accepted() {
    let f = Fixture::new();
    let path = f.path("state.txt");
    std::fs::write(&path, "first\r\nsecond\r\n").unwrap();
    f.tools
        .context_call("readFileState.set", &json!([path, {"content":"first\nsecond\n","timestamp":1}]))
        .unwrap();
    let edit = f.edit(&path, "second", "2nd").await;
    assert_eq!(edit["isError"], false, "{edit}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\r\n2nd\r\n");
}

#[tokio::test]
async fn utf16_files_are_decoded_and_keep_their_encoding() {
    let f = Fixture::new();
    let harness = crate::harness::baseline();
    for encoding in [text::Encoding::Utf16Le, text::Encoding::Utf16Be] {
        let path = f.path(&format!("{}.txt", encoding.label()));
        std::fs::write(&path, text::encode("name=old\r\nvalue=中文\r\n", encoding)).unwrap();
        let read = f.read(&path).await;
        assert!(content(&read).starts_with("1\tname=old\n2\tvalue=中文\n3\t\n"), "{read}");
        assert!(content(&read).contains(&harness.render(TextId::ToolsFileReadEncoding, &[("encoding", encoding.label())])));

        let edit = f.edit(&path, "name=old\nvalue", "name=new\nvalue").await;
        assert_eq!(edit["isError"], false, "{edit}");
        assert_eq!(std::fs::read(&path).unwrap(), text::encode("name=new\r\nvalue=中文\r\n", encoding));

        let write = f.write(&path, "replaced\n").await;
        assert_eq!(write["isError"], false, "{write}");
        assert!(content(&write).ends_with(&harness.render(TextId::ToolsFileKeptEncoding, &[("encoding", encoding.label())])));
        assert_eq!(std::fs::read(&path).unwrap(), text::encode("replaced\n", encoding));
        assert_eq!(write["metadata"]["bytes"], text::encode("replaced\n", encoding).len());
    }

    let path = f.path("bom.txt");
    std::fs::write(&path, b"\xEF\xBB\xBFhello\nworld\n").unwrap();
    assert!(f.read(&path).await["content"].as_str().unwrap().starts_with("1\thello\n"));
    assert_eq!(f.edit(&path, "hello", "hi").await["isError"], false);
    assert_eq!(std::fs::read(&path).unwrap(), b"\xEF\xBB\xBFhi\nworld\n");
    assert_eq!(f.write(&path, "replaced\n").await["isError"], false);
    assert_eq!(std::fs::read(&path).unwrap(), b"\xEF\xBB\xBFreplaced\n");

    // Only the transport BOM is removed; a second U+FEFF is content.
    let doubled: &[u8] = b"\xEF\xBB\xBF\xEF\xBB\xBFx\n";
    std::fs::write(&path, doubled).unwrap();
    let read = f.read(&path).await;
    assert!(content(&read).starts_with("1\t\u{feff}x\n"), "{read}");
    assert_eq!(f.write(&path, "\u{feff}x\n").await["isError"], false);
    assert_eq!(std::fs::read(&path).unwrap(), doubled);

    let created = f.path("new.txt");
    assert_eq!(f.write(&created, "plain\n").await["isError"], false);
    assert_eq!(std::fs::read(&created).unwrap(), b"plain\n");

    let notebook = f.path("legacy.ipynb");
    std::fs::write(&notebook, b"{\"cells\":[{\"cell_type\":\"code\",\"source\":[\"print('caf\xe9')\"]}]}").unwrap();
    let read = f.read(&notebook).await;
    assert!(content(&read).contains(harness.text(TextId::ToolsFileReadUndecodable)), "{read}");
}

#[tokio::test]
async fn changes_to_bytes_alone_are_changes() {
    let f = Fixture::new();
    let path = f.path("bytes.txt");
    let changes: [(&str, Vec<u8>); 3] = [
        ("line endings", b"one\r\ntwo\r\n".to_vec()),
        ("byte order mark", b"\xEF\xBB\xBFone\ntwo\n".to_vec()),
        ("encoding", text::encode("one\ntwo\n", text::Encoding::Utf16Le)),
    ];
    for (name, changed) in changes {
        std::fs::write(&path, "one\ntwo\n").unwrap();
        f.read(&path).await;
        std::fs::write(&path, &changed).unwrap();
        let edit = f.edit(&path, "one", "ONE").await;
        assert_eq!(edit["isError"], true, "{name}: {edit}");
        assert!(content(&edit).contains("changed after your last Read"), "{name}");
        std::fs::write(&path, "one\ntwo\n").unwrap();
        f.read(&path).await;
        std::fs::write(&path, &changed).unwrap();
        let write = f.write(&path, "replacement\n").await;
        assert_eq!(write["isError"], true, "{name}: {write}");
        assert_eq!(std::fs::read(&path).unwrap(), changed, "{name}");
    }
}

#[tokio::test]
async fn full_reads_survive_timestamp_changes_but_partial_views_do_not() {
    let f = Fixture::new();
    let path = f.path("report.txt");
    assert_eq!(f.write(&path, "v1\n").await["isError"], false);
    assert_eq!(f.write(&path, "v2\n").await["isError"], false);
    touch(&path, 2);
    let write = f.write(&path, "v3\n").await;
    assert_eq!(write["isError"], false, "{write}");

    f.read(&path).await;
    touch(&path, 4);
    let edit = f.edit(&path, "v3", "v4").await;
    assert_eq!(edit["isError"], false, "{edit}");

    std::fs::write(&path, "a\nb\nc\n").unwrap();
    f.call("Read", json!({"file_path":path,"limit":1})).await;
    let edit = f.edit(&path, "a\n", "A\n").await;
    assert_eq!(edit["isError"], false, "{edit}");
    f.call("Read", json!({"file_path":path,"limit":1})).await;
    touch(&path, 6);
    let edit = f.edit(&path, "b\n", "B\n").await;
    assert_eq!(edit["isError"], true, "{edit}");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "A\nb\nc\n");

    std::fs::write(&path, "changed by someone else\n").unwrap();
    let write = f.write(&path, "lost\n").await;
    assert_eq!(write["isError"], true);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "changed by someone else\n");
}

#[tokio::test]
async fn write_reports_the_lines_it_wrote() {
    let f = Fixture::new();
    for (content, lines) in [("one\ntwo\n", 2), ("one\ntwo", 2), ("single", 1), ("", 0), ("a\n\nb", 3)] {
        let result = f.write(&f.path(&format!("{}.txt", uuid::Uuid::new_v4())), content).await;
        assert_eq!(result["metadata"]["lines"], lines, "{content:?}");
        assert!(result["content"].as_str().unwrap().contains(&format!("({lines} lines, ")), "{result}");
    }
}

/// Runs under a 4 KiB file-size limit in a child process, so writes fail part-way.
#[cfg(unix)]
#[tokio::test]
async fn failed_writes_restore_existing_files_and_report_partial_new_files() {
    const NAME: &str = "tools::file::tests::failed_writes_restore_existing_files_and_report_partial_new_files";
    if std::env::var_os("HALO_FILE_LIMIT_PROBE").is_none() {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", NAME, "--test-threads=1", "--nocapture"])
            .env("HALO_FILE_LIMIT_PROBE", "1")
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
        return;
    }
    let f = Fixture::new();
    let harness = crate::harness::baseline();
    let existing = f.path("existing.txt");
    std::fs::write(&existing, "original\n").unwrap();
    let large = f.path("large.txt");
    std::fs::write(&large, "L".repeat(8192)).unwrap();
    let edited = f.path("edited.txt");
    std::fs::write(&edited, "keep\n").unwrap();
    f.read(&edited).await;
    unsafe {
        libc::signal(libc::SIGXFSZ, libc::SIG_IGN);
        let mut limit = std::mem::zeroed::<libc::rlimit>();
        assert_eq!(libc::getrlimit(libc::RLIMIT_FSIZE, &mut limit), 0);
        limit.rlim_cur = 4096;
        assert_eq!(libc::setrlimit(libc::RLIMIT_FSIZE, &limit), 0);
    }
    let large_text = "x".repeat(32 * 1024);

    let write = f.write(&existing, &large_text).await;
    assert_eq!(write["isError"], true, "{write}");
    assert_eq!(std::fs::read_to_string(&existing).unwrap(), "original\n");

    let edit = f.edit(&edited, "keep", &large_text).await;
    assert_eq!(edit["isError"], true, "{edit}");
    assert_eq!(std::fs::read_to_string(&edited).unwrap(), "keep\n");

    // A new file is never removed by path: another program may have saved one there.
    let created = f.path("created.txt");
    let write = f.write(&created, &large_text).await;
    assert_eq!(write["isError"], true, "{write}");
    let partial = harness.render(TextId::ToolsFilePartialNewFile, &[("error", "E")]);
    assert!(content(&write).contains(partial.trim_start_matches('E')), "{write}");
    assert!(created.exists());

    // The previous content itself exceeds the limit, so restoring it fails too.
    let write = f.write(&large, &large_text).await;
    assert_eq!(write["isError"], true, "{write}");
    let partial = harness.render(TextId::ToolsFilePartialWrite, &[("error", "E"), ("restore", "R")]);
    let tail = partial.split("(R)").nth(1).unwrap();
    assert!(content(&write).contains(tail), "{write}");
}

#[tokio::test]
async fn read_state_follows_the_file_under_another_spelling() {
    let f = Fixture::new();
    std::fs::create_dir(f.path("real")).unwrap();
    let path = f.path("real/notes.txt");
    std::fs::write(&path, "alpha\n").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(f.path("real"), f.path("link")).unwrap();
        f.read(&f.path("link/notes.txt")).await;
        let edit = f.edit(&path, "alpha", "beta").await;
        assert_eq!(edit["isError"], false, "{edit}");
        let edit = f.edit(&f.path("link/notes.txt"), "beta", "gamma").await;
        assert_eq!(edit["isError"], false, "{edit}");
    }
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        std::fs::write(&path, "alpha\n").unwrap();
        f.read(&f.path("REAL/Notes.TXT")).await;
        let edit = f.edit(&path, "alpha", "delta").await;
        assert_eq!(edit["isError"], false, "{edit}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "delta\n");
    }
}

/// A read made through a link describes the file the link named at that moment.
#[cfg(unix)]
#[tokio::test]
async fn a_retargeted_or_deleted_link_keeps_protecting_the_file_it_was_read_through() {
    let harness = crate::harness::baseline();
    for retarget in [true, false] {
        let f = Fixture::new();
        let (one, two, link) = (f.path("one.txt"), f.path("two.txt"), f.path("link.txt"));
        std::fs::write(&one, "one\n").unwrap();
        std::fs::write(&two, "two\n").unwrap();
        std::os::unix::fs::symlink(&one, &link).unwrap();
        f.read(&link).await;
        std::fs::write(&one, "changed elsewhere\n").unwrap();
        std::fs::remove_file(&link).unwrap();
        if retarget {
            std::os::unix::fs::symlink(&two, &link).unwrap();
            let edit = f.edit(&link, "two", "TWO").await;
            assert_eq!(content(&edit), harness.text(TextId::ToolsFileEditRead), "retarget={retarget}");
        }
        let write = f.write(&one, "overwrite\n").await;
        assert_eq!(content(&write), harness.text(TextId::ToolsFileChanged), "retarget={retarget}");
        assert_eq!(std::fs::read_to_string(&one).unwrap(), "changed elsewhere\n");
        assert_eq!(std::fs::read_to_string(&two).unwrap(), "two\n");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_write_whose_path_was_replaced_is_not_confirmed() {
    let f = Fixture::new();
    let path = f.path("saved.txt");
    std::fs::write(&path, "written\n").unwrap();
    let written = std::fs::metadata(&path).unwrap();
    assert!(confirm_written(&path, &written).await.is_ok());

    // An editor saving atomically puts a new file at the path.
    let replacement = f.path("saved.txt.tmp");
    std::fs::write(&replacement, "theirs\n").unwrap();
    std::fs::rename(&replacement, &path).unwrap();
    let error = confirm_written(&path, &written).await.unwrap_err();
    let harness = crate::harness::baseline();
    assert_eq!(error.render_for(&harness), harness.text(TextId::ToolsFileReplacedDuringWrite));

    std::fs::remove_file(&path).unwrap();
    assert!(confirm_written(&path, &written).await.is_err());
}

#[tokio::test]
async fn an_incomplete_final_character_is_shown_as_a_partial_view_and_kept_by_edits() {
    let f = Fixture::new();
    let harness = crate::harness::baseline();
    let notice = harness.text(TextId::ToolsFileReadIncompleteEnd);
    let state = |path: &Path| f.tools.context_call("readFileState.get", &json!([path])).unwrap();
    let half = &"中".as_bytes()[..2];

    let path = f.path("tail.txt");
    let bytes = [b"h\xc3\xa9llo\nend ", half].concat();
    std::fs::write(&path, &bytes).unwrap();
    let read = f.read(&path).await;
    assert_eq!(content(&read), format!("1\théllo\n2\tend \n{notice}\n"));
    assert_eq!(state(&path)["isPartialView"], true);
    assert_eq!(state(&path)["contentHash"], hash(&bytes));
    let edit = f.edit(&path, "end", "END").await;
    assert_eq!(edit["isError"], false, "{edit}");
    assert_eq!(std::fs::read(&path).unwrap(), [b"h\xc3\xa9llo\nEND ", half].concat());
    assert_eq!(std::fs::read(saved_original(&edit)).unwrap(), bytes);
    std::fs::write(&path, &bytes).unwrap();

    // Once the character is complete, the partial view is stale and a new Read is a full one.
    let mut appended = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
    std::io::Write::write_all(&mut appended, &"中".as_bytes()[2..]).unwrap();
    drop(appended);
    assert_eq!(content(&f.edit(&path, "end", "END").await), harness.text(TextId::ToolsFileChanged));
    assert_eq!(content(&f.read(&path).await), "1\théllo\n2\tend 中\n");
    assert_ne!(state(&path)["isPartialView"], true);
    assert_eq!(f.edit(&path, "end", "END").await["isError"], false);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "héllo\nEND 中");

    // A newer partial view replaces the full read state a Read, Write or Edit left.
    let cut = [b"alpha\nbeta ", half].concat();
    for complete in ["read", "write", "edit"] {
        std::fs::write(&path, "alpha\nbeta 中").unwrap();
        let recorded = match complete {
            "read" => f.read(&path).await,
            "write" => {
                f.read(&path).await;
                f.write(&path, "alpha\nbeta 中").await
            }
            _ => {
                f.read(&path).await;
                f.edit(&path, "beta 中", "beta 中!").await
            }
        };
        assert_eq!(recorded["isError"], false, "{complete}: {recorded}");
        assert_ne!(state(&path)["isPartialView"], true, "{complete}");
        std::fs::write(&path, &cut).unwrap();
        assert_eq!(content(&f.read(&path).await), format!("1\talpha\n2\tbeta \n{notice}\n"));
        assert_eq!(state(&path)["isPartialView"], true, "{complete}");
        assert_eq!(state(&path)["contentHash"], hash(&cut), "{complete}");
        let write = f.write(&path, "replaced\n").await;
        assert_eq!(write["isError"], false, "{complete}: {write}");
        assert_eq!(std::fs::read(saved_original(&write)).unwrap(), cut, "{complete}");
        assert_eq!(std::fs::read(&path).unwrap(), b"replaced\n", "{complete}");
    }

    std::fs::write(&path, half).unwrap();
    assert_eq!(content(&f.read(&path).await), format!("1\t\n{notice}\n"));
    assert_eq!(state(&path)["isPartialView"], true);
    std::fs::write(&path, [b"\xEF\xBB\xBFbom ", half].concat()).unwrap();
    assert_eq!(content(&f.read(&path).await), format!("1\tbom \n{notice}\n"));

    // An incomplete character anywhere but the very end is an invalid byte sequence.
    for middle in [[b"a ", half, b"\nb\n"].concat(), [b"a ", half, b"\r\nb\n"].concat()] {
        std::fs::write(&path, &middle).unwrap();
        let read = f.read(&path).await;
        assert!(content(&read).contains(harness.text(TextId::ToolsFileReadUndecodable)), "{read}");
        assert!(!content(&read).contains(notice), "{read}");
    }

    let large = f.path("large.txt");
    let lines = 9 * 1024 * 1024 / 2;
    std::fs::write(&large, [b"x\n".repeat(lines).as_slice(), b"end ", half].concat()).unwrap();
    let read = f.call("Read", json!({"file_path":large,"offset":lines,"limit":5})).await;
    assert!(content(&read).contains(&format!("{}\tend \n", lines + 1)), "{read}");
    assert!(content(&read).contains(notice) && !content(&read).contains('\u{fffd}'), "{read}");
    assert_eq!(state(&large)["isPartialView"], true);
    assert!(state(&large).get("contentHash").is_none_or(Value::is_null));
    let read = f.call("Read", json!({"file_path":large,"limit":2})).await;
    assert!(!content(&read).contains(notice), "{read}");
}

const HALF: &[u8] = &[0xe4, 0xb8];

/// The final line ends partway through `中`; the note follows only a view that delivered it.
fn end_note() -> String {
    format!("{}\n", crate::harness::baseline().text(TextId::ToolsFileReadIncompleteEnd))
}

#[tokio::test]
async fn the_incomplete_end_note_follows_only_a_page_that_reaches_the_end() {
    let f = Fixture::new();
    let path = f.path("pages.txt");
    std::fs::write(&path, [b"one\ntwo\nend ", HALF].concat()).unwrap();
    let first = f.call("Read", json!({"file_path":path,"limit":1})).await;
    assert!(!content(&first).contains(end_note().trim_end()), "{first}");
    let last = f.call("Read", json!({"file_path":path,"offset":3})).await;
    assert!(content(&last).contains("3\tend \n") && content(&last).ends_with(&end_note()), "{last}");
}

/// The note uses only room the delivered text leaves; it never displaces it.
#[tokio::test]
async fn the_incomplete_end_note_never_takes_room_from_the_text() {
    let f = Fixture::new();
    let length = crate::js::utf16_len;
    let path = f.path("budget.txt");
    std::fs::write(&path, [b"one\ntwo\nend ", "z".repeat(240).as_bytes(), HALF].concat()).unwrap();
    let whole = content(&f.read(&path).await).to_owned();
    let body = whole.strip_suffix(&end_note()).unwrap();
    assert!(length(body) > length(&end_note()));
    assert_eq!(content(&f.read_within(length(&whole), json!({"file_path":path})).await), whole);
    assert_eq!(content(&f.read_within(length(body), json!({"file_path":path})).await), body);
    for budget in [length(body) - 3, 20] {
        let short = f.read_within(budget, json!({"file_path":path})).await;
        assert!(!content(&short).contains(end_note().trim_end()) && length(content(&short)) <= budget, "{short}");
    }
}

#[tokio::test]
async fn a_large_page_shows_the_incomplete_end_note_only_with_its_final_line() {
    let f = Fixture::new();
    let length = crate::js::utf16_len;
    let large = f.path("large.txt");
    let lines = 9 * 1024 * 1024 / 2;
    std::fs::write(&large, [b"x\n".repeat(lines).as_slice(), "a".repeat(190).as_bytes(), b"\nend ", HALF].concat()).unwrap();
    let final_line = format!("{}\tend ", lines + 2);
    let page = f.call("Read", json!({"file_path":large,"offset":lines + 1,"limit":5})).await;
    assert!(content(&page).contains(&final_line) && content(&page).ends_with(&end_note()), "{page}");
    let dropped = f.read_within(200, json!({"file_path":large,"offset":lines + 1,"limit":5})).await;
    assert!(!content(&dropped).contains(&final_line) && !content(&dropped).contains(end_note().trim_end()), "{dropped}");
    let whole = content(&f.call("Read", json!({"file_path":large,"offset":lines + 2})).await).to_owned();
    let body = whole.strip_suffix(&end_note()).unwrap();
    assert_eq!(content(&f.read_within(length(&whole), json!({"file_path":large,"offset":lines + 2})).await), whole);
    assert_eq!(content(&f.read_within(length(body), json!({"file_path":large,"offset":lines + 2})).await), body);
}
