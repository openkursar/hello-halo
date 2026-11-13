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
pub fn open_work_state_key(goal: &Value, todos: &[Value]) -> String {
    crate::js::stringify(
        &json!({"goal":if goal["status"]=="active"{json!([goal["objective"],goal["doneWhen"]])}else{Value::Null},"todos":todos.iter().map(|todo|json!([todo["content"],todo["status"]])).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
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
