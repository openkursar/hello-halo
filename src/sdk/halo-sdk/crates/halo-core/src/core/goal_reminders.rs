use crate::harness::{ResolvedHarness, TextId};
use serde_json::{json, Value};

pub fn completion_check_text(harness: &ResolvedHarness) -> &str {
    harness.text(TextId::ContextGoalCompletionCheck)
}
pub fn render_goal(goal: &Value) -> String {
    render_goal_with_harness(goal, &crate::harness::baseline())
}
pub fn render_goal_with_harness(goal: &Value, harness: &ResolvedHarness) -> String {
    let mut lines = vec![harness.render(
        TextId::ContextGoalObjective,
        &[("objective", &crate::js::to_string(&goal["objective"]))],
    )];
    if let Some(criteria) = goal["doneWhen"]
        .as_array()
        .filter(|criteria| !criteria.is_empty())
    {
        lines.push(harness.text(TextId::ContextGoalCriteriaHeading).to_owned());
        lines.extend(criteria.iter().map(|criterion| {
            harness.render(
                TextId::ContextGoalCriterion,
                &[("criterion", &crate::js::to_string(criterion))],
            )
        }));
    }
    lines.push(harness.render(
        TextId::ContextGoalStatus,
        &[("status", &crate::js::to_string(&goal["status"]))],
    ));
    lines.join("\n")
}
pub fn goal_recitation_text(goal: &Value, todos: &[Value]) -> String {
    goal_recitation_text_with_harness(goal, todos, &crate::harness::baseline())
}
pub fn goal_recitation_text_with_harness(
    goal: &Value,
    todos: &[Value],
    harness: &ResolvedHarness,
) -> String {
    let mut lines = vec![harness.render(
        TextId::ContextGoalRecitation,
        &[("goal", &render_goal_with_harness(goal, harness))],
    )];
    if !todos.is_empty() {
        let done = todos
            .iter()
            .filter(|todo| todo["status"] == "completed")
            .count()
            .to_string();
        let total = todos.len().to_string();
        lines.push(
            if let Some(current) = todos.iter().find(|todo| todo["status"] == "in_progress") {
                harness.render(
                    TextId::ContextGoalTodoProgressCurrent,
                    &[
                        ("done", &done),
                        ("total", &total),
                        ("current", &crate::js::to_string(&current["content"])),
                    ],
                )
            } else {
                harness.render(
                    TextId::ContextGoalTodoProgress,
                    &[("done", &done), ("total", &total)],
                )
            },
        );
    }
    lines.join("\n")
}
pub fn goal_change_notice_text(previous: &Value, current: &Value) -> String {
    goal_change_notice_text_with_harness(previous, current, &crate::harness::baseline())
}
pub fn goal_change_notice_text_with_harness(
    previous: &Value,
    current: &Value,
    harness: &ResolvedHarness,
) -> String {
    if current.is_null() {
        return if previous.is_null() {
            harness.text(TextId::ContextGoalRemoved).into()
        } else {
            harness.render(
                TextId::ContextGoalRemovedNamed,
                &[("objective", &crate::js::to_string(&previous["objective"]))],
            )
        };
    }
    let mut lines = vec![
        harness
            .text(if previous.is_null() {
                TextId::ContextGoalSet
            } else {
                TextId::ContextGoalUpdated
            })
            .to_owned(),
        render_goal_with_harness(current, harness),
    ];
    if !previous.is_null() && previous["objective"] != current["objective"] {
        lines.push(harness.render(
            TextId::ContextGoalPreviousObjective,
            &[("objective", &crate::js::to_string(&previous["objective"]))],
        ));
    }
    lines.join("\n")
}
pub fn open_work_check_text(goal: &Value, todos: &[Value]) -> Option<String> {
    open_work_check_text_with_harness(goal, todos, &crate::harness::baseline())
}
pub fn open_work_check_text_with_harness(
    goal: &Value,
    todos: &[Value],
    harness: &ResolvedHarness,
) -> Option<String> {
    let active = goal["status"] == "active";
    let open: Vec<_> = todos
        .iter()
        .filter(|todo| todo["status"] == "pending" || todo["status"] == "in_progress")
        .collect();
    if !active && open.is_empty() {
        return None;
    }
    let mut parts = Vec::new();
    if active {
        parts.push(harness.render(
            TextId::ContextGoalOpenGoal,
            &[("objective", &crate::js::to_string(&goal["objective"]))],
        ));
    }
    if !open.is_empty() {
        let next = open
            .iter()
            .find(|todo| todo["status"] == "in_progress")
            .copied()
            .unwrap_or(open[0]);
        parts.push(harness.render(
            TextId::ContextGoalOpenTodos,
            &[
                ("open", &open.len().to_string()),
                ("total", &todos.len().to_string()),
                ("next", &crate::js::to_string(&next["content"])),
            ],
        ));
    }
    Some(harness.render(
        TextId::ContextGoalOpenCheck,
        &[(
            "parts",
            &parts.join(harness.text(TextId::ContextGoalOpenJoin)),
        )],
    ))
}
pub fn todo_reminder_text_with_harness(todos: &[Value], quiet: u32, harness: &ResolvedHarness) -> String {
    let list = todos
        .iter()
        .map(|todo| {
            let marker = match todo["status"].as_str().unwrap_or("") {
                "completed" => "[x]",
                "in_progress" => "[~]",
                _ => "[ ]",
            };
            format!("{marker} {}", crate::js::to_string(&todo["content"]))
        })
        .collect::<Vec<_>>()
        .join("\n");
    harness.render(TextId::ContextTodosStale, &[("count", &quiet.to_string()), ("list", &list)])
}
pub fn open_work_state_key(goal: &Value, todos: &[Value]) -> String {
    crate::js::stringify(
        &json!({"goal":if goal["status"]=="active"{json!([goal["objective"],goal["doneWhen"]])}else{Value::Null},"todos":todos.iter().map(|todo|json!([todo["content"],todo["status"]])).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn goal_and_open_work_contracts_preserve_visible_text_and_state_identity() {
        let goal = serde_json::json!({"objective":"Reconcile all invoices","doneWhen":["Every invoice marked","Summary saved"],"status":"active","updatedBy":"agent","updatedAt":"2026-01-01T00:00:00.000Z"});
        assert_eq!(render_goal(&goal), "Objective: Reconcile all invoices\nDone when:\n- Every invoice marked\n- Summary saved\nStatus: active");
        let mut empty = goal.clone();
        empty["doneWhen"] = serde_json::json!([]);
        assert!(!render_goal(&empty).contains("Done when"));
        let todos = serde_json::json!([{"content":"Match January","status":"completed"},{"content":"Match February","status":"in_progress"},{"content":"Match March","status":"pending"}]);
        let recitation = goal_recitation_text(&goal, todos.as_array().unwrap());
        assert!(recitation.contains("Current goal:"));
        assert!(recitation.contains("Todo: 1 of 3 completed; in progress: \"Match February\"."));
        assert!(!goal_recitation_text(&goal, &[]).contains("Todo:"));
        assert!(goal_change_notice_text(&Value::Null, &goal).starts_with("The user set a goal for this work."));
        let mut previous = goal.clone();
        previous["objective"] = serde_json::json!("Old objective");
        let notice = goal_change_notice_text(&previous, &goal);
        assert!(notice.starts_with("The user updated the goal."));
        assert!(notice.contains("Previous objective: Old objective"));
        assert_eq!(goal_change_notice_text(&goal, &Value::Null), "The user removed the goal \"Reconcile all invoices\". It no longer applies.");
        assert!(open_work_check_text(&Value::Null, &[]).is_none());
        let mut complete = goal.clone();
        complete["status"] = serde_json::json!("complete");
        assert!(open_work_check_text(&complete, &[serde_json::json!({"content":"x","status":"completed"})]).is_none());
        let check = open_work_check_text(&goal, &[serde_json::json!({"content":"Match January","status":"completed"}),serde_json::json!({"content":"Match February","status":"pending"})]).unwrap();
        assert!(check.contains("the goal \"Reconcile all invoices\" is not marked complete"));
        assert!(check.contains("1 of 2 todo items are unfinished (next: \"Match February\")"));
        assert!(check.contains("This is a check, not an instruction to continue."));
        assert!(open_work_check_text(&Value::Null, &[serde_json::json!({"content":"A","status":"pending"}),serde_json::json!({"content":"B","status":"in_progress"})]).unwrap().contains("next: \"B\""));
        let pending = [serde_json::json!({"content":"A","status":"pending"})];
        let key = open_work_state_key(&goal, &pending);
        let mut later = goal.clone();
        later["updatedAt"] = serde_json::json!("later");
        assert_eq!(open_work_state_key(&later, &pending), key);
        assert_ne!(open_work_state_key(&goal, &[serde_json::json!({"content":"A","status":"in_progress"})]), key);
        later["objective"] = serde_json::json!("Other");
        assert_ne!(open_work_state_key(&later, &pending), key);
    }

    #[test]
    fn reminders_match_fixture_text_and_state_keys() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/goal-reminders.json")).unwrap();
        assert_eq!(
            completion_check_text(&crate::harness::baseline()),
            fixture["completion"]
        );
        for case in fixture["cases"].as_array().unwrap() {
            let goal = &case["goal"];
            let todos = case["todos"].as_array().unwrap();
            if !goal.is_null() {
                assert_eq!(
                    render_goal(goal),
                    case["render"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
                assert_eq!(
                    goal_recitation_text(goal, todos),
                    case["recitation"].as_str().unwrap(),
                    "{}",
                    case["name"]
                );
            }
            assert_eq!(
                goal_change_notice_text(&case["previous"], goal),
                case["change"].as_str().unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(
                open_work_check_text(goal, todos)
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                case["check"],
                "{}",
                case["name"]
            );
            assert_eq!(
                open_work_state_key(goal, todos),
                case["key"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
