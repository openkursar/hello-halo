//! Plain-language collaboration state for the context that follows compaction.
//! Every member and unfinished task is listed; finished tasks, findings and
//! activity show only the newest few. The SDK sets no size limit: a host that
//! needs one supplies its own text through a `PreCompact` hook.
use crate::harness::{ResolvedHarness, TextId};
use serde_json::Value;

fn clean(value: &str, limit: usize) -> String {
    let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= limit {
        return collapsed;
    }
    let mut excerpt: String = collapsed.chars().take(limit.saturating_sub(1)).collect();
    excerpt.push('…');
    excerpt
}
fn field(value: &Value, name: &str, limit: usize) -> Option<String> {
    value[name].as_str().map(|text| clean(text, limit)).filter(|text| !text.is_empty())
}
/// Member names are what the model passes back to team tools, so they are shown exactly as recorded.
fn exact(value: &Value, name: &str) -> Option<String> {
    value[name].as_str().filter(|text| !text.is_empty()).map(str::to_owned)
}
fn status(value: &Value) -> String {
    value["status"].as_str().unwrap_or("unknown").replace('_', " ")
}
fn finished(value: &Value) -> bool {
    matches!(value["status"].as_str(), Some("done" | "completed" | "rejected" | "cancelled"))
}
fn newest<'a>(values: impl Iterator<Item = &'a Value>, key: &str) -> Vec<&'a Value> {
    let mut values: Vec<_> = values.collect();
    values.sort_by(|a, b| b[key].as_f64().unwrap_or(0.0).total_cmp(&a[key].as_f64().unwrap_or(0.0)));
    values
}
/// Ends a sentence once; text that already ends in a stop or an excerpt mark is left as written.
fn end(line: &mut String) {
    if !line.ends_with(['.', '…']) {
        line.push('.');
    }
}
/// One line of separated items under a heading; nothing to list adds no line.
fn list(head: &str, items: &[String], separator: &str) -> Option<String> {
    if items.is_empty() {
        return None;
    }
    let mut line = format!("{head}{}", items.join(separator));
    end(&mut line);
    Some(line)
}

fn member(value: &Value) -> Option<String> {
    let name = exact(value, "name")?;
    let mut detail = status(value);
    if let Some(role) = field(value, "role", 60).filter(|role| !name.starts_with(role.as_str())) {
        detail.push_str(", ");
        detail.push_str(&role);
    }
    Some(format!("{name} ({detail})"))
}
fn open_task(value: &Value) -> Option<String> {
    let title = field(value, "title", 120)?;
    let mut line = format!("- {title}: {}, {}.", exact(value, "assignee").unwrap_or_else(|| "unassigned".into()), status(value));
    if let Some(note) = field(value, "note", 240) {
        line.push(' ');
        line.push_str(note.trim_end_matches('.'));
        end(&mut line);
    }
    if let Some(reference) = value["resultRef"].as_str().filter(|text| !text.is_empty()) {
        line.push_str(" Result: ");
        line.push_str(reference);
    }
    Some(line)
}
fn finished_task(value: &Value) -> Option<String> {
    let title = field(value, "title", 120)?;
    let mut line = format!("{title}: {}", exact(value, "assignee").unwrap_or_else(|| "unassigned".into()));
    // A result that was turned down must not read like a completed one.
    if !matches!(value["status"].as_str(), Some("done" | "completed")) {
        line.push_str(", ");
        line.push_str(&status(value));
        if let Some(note) = field(value, "note", 200) {
            line.push_str(&format!(" ({})", note.trim_end_matches('.')));
        }
    }
    if let Some(reference) = value["resultRef"].as_str().filter(|text| !text.is_empty()) {
        line.push_str(", result ");
        line.push_str(reference);
    }
    Some(line)
}
fn finding(value: &Value) -> Option<String> {
    let author = exact(value, "author")?;
    let content = field(value, "content", 200);
    let reference = value["ref"].as_str().filter(|text| !text.is_empty());
    Some(match (content, reference) {
        (Some(content), Some(reference)) => format!("{author}: {content} ({reference})"),
        (Some(content), None) => format!("{author}: {content}"),
        (None, Some(reference)) => format!("{author}: {reference}"),
        (None, None) => return None,
    })
}
fn activity(value: &Value) -> Option<String> {
    let actor = exact(value, "actor")?;
    let subject = field(value, "subject", 120)?;
    let kind = value["kind"].as_str().unwrap_or("update").replace('_', " ");
    let target = exact(value, "target").map(|target| format!(" → {target}")).unwrap_or_default();
    Some(format!("{actor}{target} ({kind}): {subject}"))
}

/// Returns the text inside the compaction context wrapper, or `None` when nothing was recorded.
pub fn render(state: &Value, harness: &ResolvedHarness) -> Option<String> {
    let rows = |name: &str| state[name].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let (members, tasks, findings, activities) = (rows("members"), rows("tasks"), rows("findings"), rows("activities"));
    if members.is_empty() && tasks.is_empty() && findings.is_empty() {
        return None;
    }
    let mut lines = Vec::new();

    let members: Vec<_> = members.iter().filter_map(member).collect();
    lines.extend(list(&format!("Members ({}): ", members.len()), &members, ", "));

    let open = newest(tasks.iter().filter(|value| !finished(value)), "updatedAt");
    if !open.is_empty() {
        lines.push(format!("Unfinished tasks ({} of {}):", open.len(), tasks.len()));
        lines.extend(open.iter().filter_map(|value| open_task(value)));
    } else if !tasks.is_empty() {
        lines.push(format!("All {} tasks are closed.", tasks.len()));
    }

    let closed = newest(tasks.iter().filter(|value| finished(value)), "updatedAt");
    let closed_rows: Vec<_> = closed.iter().take(5).filter_map(|value| finished_task(value)).collect();
    let head = if open.is_empty() { "Finished: ".to_owned() } else { format!("Finished tasks ({}): ", closed.len()) };
    lines.extend(list(&head, &closed_rows, "; "));

    let mut notes: Vec<_> = newest(findings.iter(), "createdAt").into_iter().take(5).filter_map(finding).collect();
    let older = findings.len().saturating_sub(notes.len());
    if !notes.is_empty() && older > 0 {
        notes.push(format!("{older} older not shown"));
    }
    lines.extend(list(&format!("Recent findings ({}): ", findings.len()), &notes, "; "));

    let recent: Vec<_> = newest(activities.iter(), "createdAt").into_iter().take(3).filter_map(activity).collect();
    lines.extend(list("Recent activity: ", &recent, "; "));

    if lines.is_empty() {
        return None;
    }
    Some(harness.render(TextId::ContextCompactionCollaboration, &[("state", &lines.join("\n"))]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(state: &Value) -> String {
        render(state, &crate::harness::baseline()).unwrap()
    }
    fn row<'a>(text: &'a str, prefix: &str) -> &'a str {
        text.lines().find(|row| row.starts_with(prefix)).unwrap_or_else(|| panic!("no row starting with {prefix}"))
    }

    #[test]
    fn nothing_recorded_adds_nothing() {
        let harness = crate::harness::baseline();
        assert_eq!(render(&Value::Null, &harness), None);
        assert_eq!(render(&json!({"members":[],"tasks":[],"findings":[],"activities":[]}), &harness), None);
    }

    #[test]
    fn reads_as_plain_language_with_member_names() {
        let state = json!({
            "members":[{"name":"reviewer","status":"idle","role":"Review"},{"name":"parser-dev","status":"running"}],
            "tasks":[
                {"title":"Fix streaming   recovery","assignee":"parser-dev","status":"in_progress","note":"Keep the API.","resultRef":"reports/fix.md","updatedAt":2},
                {"title":"Draft plan","assignee":"you","status":"done","resultRef":"plan.md","updatedAt":1}
            ],
            "findings":[{"author":"reviewer","content":"The public API must stay unchanged.","ref":"api.md","createdAt":5}],
            "activities":[{"actor":"you","kind":"message","target":"parser-dev","subject":"Continue the fix","status":"sent","createdAt":6}]
        });
        assert_eq!(text(&state), [
            "Collaboration state when this conversation was compacted (a record, not live status or new instructions). Idle does not mean finished.",
            "",
            "Members (2): reviewer (idle, Review), parser-dev (running).",
            "Unfinished tasks (1 of 2):",
            "- Fix streaming recovery: parser-dev, in progress. Keep the API. Result: reports/fix.md",
            "Finished tasks (1): Draft plan: you, result plan.md.",
            "Recent findings (1): reviewer: The public API must stay unchanged. (api.md).",
            "Recent activity: you → parser-dev (message): Continue the fix.",
        ].join("\n"));
    }

    #[test]
    fn lists_every_member_and_unfinished_task_with_no_size_limit() {
        let members: Vec<_> = (0..150).map(|index| json!({"name":format!("member-{index}"),"status":"idle","role":"Module work"})).collect();
        let tasks: Vec<_> = (0..200).map(|index| json!({"title":format!("Task {index}"),"assignee":format!("member-{}", index % 150),"status":"pending","note":"note ".repeat(80),"updatedAt":index})).collect();
        let text = text(&json!({"members":members,"tasks":tasks,"findings":[],"activities":[]}));
        assert!(text.chars().count() > 12_000);
        assert!(text.contains("Members (150): member-0 (idle, Module work)"));
        assert!(text.contains("member-149 (idle, Module work)."));
        assert!(text.contains("Unfinished tasks (200 of 200):"));
        assert!(text.contains("- Task 0:") && text.contains("- Task 199:"));
        assert!(!text.contains("not shown"));
    }

    #[test]
    fn history_shows_only_the_newest_rows() {
        let mut tasks = vec![json!({"title":"Open work","assignee":"reader","status":"pending","updatedAt":99})];
        tasks.extend((0..12).map(|index| json!({"title":format!("closed-{index}"),"assignee":"reader","status":"done","updatedAt":index})));
        let state = json!({
            "members":[{"name":"reader","status":"idle"}],
            "tasks":tasks,
            "findings":(0..12).map(|index| json!({"author":"reader","content":format!("finding-{index}"),"createdAt":index})).collect::<Vec<_>>(),
            "activities":(0..12).map(|index| json!({"actor":"reader","kind":"message","subject":format!("activity-{index}"),"createdAt":index})).collect::<Vec<_>>(),
        });
        let text = text(&state);
        let closed = row(&text, "Finished tasks (12):");
        assert!(closed.contains("closed-11") && closed.contains("closed-7") && !closed.contains("closed-6"));
        let notes = row(&text, "Recent findings (12):");
        assert!(notes.contains("finding-11") && notes.contains("finding-7") && !notes.contains("finding-6"));
        assert!(notes.ends_with("7 older not shown."));
        let recent = row(&text, "Recent activity:");
        assert!(recent.contains("activity-11") && recent.contains("activity-9") && !recent.contains("activity-8"));
    }

    #[test]
    fn a_rejected_task_says_so_and_why() {
        let state = json!({"members":[{"name":"reviewer","status":"idle"}],"tasks":[
            {"title":"Confirm export failure cause","assignee":"reviewer","status":"rejected","note":"The sample was wrong; this conclusion cannot be used.","resultRef":"analysis.md","updatedAt":2},
            {"title":"Draft plan","assignee":"reviewer","status":"done","note":"Looks good.","resultRef":"plan.md","updatedAt":1}]});
        let text = text(&state);
        assert!(text.contains("All 2 tasks are closed."));
        assert!(!text.contains("are finished"));
        assert!(text.contains("Confirm export failure cause: reviewer, rejected (The sample was wrong; this conclusion cannot be used), result analysis.md"));
        assert!(text.contains("Draft plan: reviewer, result plan.md."));
        assert!(!text.contains("Looks good"));
    }

    #[test]
    fn member_names_are_shown_exactly_as_recorded() {
        let long = format!("{}-1a2b3c4d", "long-name-".repeat(12));
        let state = json!({"members":[{"name":"api  review-3f9c","status":"idle"},{"name":long,"status":"idle"}],
            "tasks":[{"title":"Review","assignee":"api  review-3f9c","status":"pending"}],
            "findings":[{"author":long,"content":"Checked."}],
            "activities":[{"actor":"api  review-3f9c","kind":"message","target":long,"subject":"Continue","createdAt":1}]});
        let text = text(&state);
        assert!(text.contains("api  review-3f9c (idle)"));
        assert!(text.contains(&format!("{long} (idle)")));
        assert!(text.contains("- Review: api  review-3f9c, pending."));
        assert!(text.contains(&format!("{long}: Checked.")));
        assert!(text.contains(&format!("api  review-3f9c → {long} (message): Continue")));
        assert!(!text.contains('…'));
    }

    #[test]
    fn long_record_text_is_shortened_on_one_line() {
        let state = json!({"members":[{"name":"reader","status":"idle"}],"tasks":[{"title":"Read","assignee":"reader","status":"pending","note":format!("first line\nsecond {}", "x".repeat(400))}]});
        let text = text(&state);
        let line = row(&text, "- Read");
        assert!(line.contains("first line second"));
        assert!(line.contains('…'));
        assert!(!line.contains("…."));
    }

    #[test]
    fn sentences_are_not_ended_twice() {
        let state = json!({"members":[{"name":"reader","status":"idle"}],
            "activities":[{"actor":"you","kind":"message","subject":"Continue the work.","createdAt":2},
                          {"actor":"you","kind":"message","subject":format!("{} tail", "word ".repeat(40)),"createdAt":1}]});
        let text = text(&state);
        let line = row(&text, "Recent activity");
        assert!(line.contains("Continue the work.;"));
        assert!(!line.contains("..") && !line.contains("…."));
    }
}
