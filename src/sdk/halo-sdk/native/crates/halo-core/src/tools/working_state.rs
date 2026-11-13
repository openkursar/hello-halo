use super::{failure, success};
use crate::error::{Error, Result};
use crate::harness::{ResolvedHarness, TextId};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Mutex};

pub struct WorkingState {
    goal: Mutex<Value>,
    seen: Mutex<Value>,
    todos: Mutex<Value>,
    directory: Option<PathBuf>,
    session_id: String,
}
fn valid_goal(v: &Value) -> bool {
    v["objective"].is_string()
        && v["doneWhen"].is_array()
        && ["active", "complete", "abandoned"].contains(&v["status"].as_str().unwrap_or(""))
}
fn criteria(v: &Value) -> Value {
    json!(v
        .as_array()
        .map(|a| a
            .iter()
            .filter_map(Value::as_str)
            .map(crate::js::trim_js)
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>())
        .unwrap_or_default())
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub use crate::core::goal_reminders::render_goal;
impl WorkingState {
    pub fn new(options: &Value) -> Self {
        let directory =
            (options["persistSession"] != false).then(|| PathBuf::from(super::config_dir(options)));
        let session_id = options["sessionId"]
            .as_str()
            .or_else(|| options["resume"].as_str())
            .unwrap_or("")
            .to_owned();
        let read = |kind: &str| -> Value {
            let Some(dir) = &directory else {
                return Value::Null;
            };
            let p = dir.join(kind).join(format!("{session_id}.json"));
            match std::fs::read(p) {
                Ok(b) => serde_json::from_slice(&b).unwrap_or_else(|e| {
                    tracing::warn!(error=%e,"Stored tool state could not be read");
                    Value::Null
                }),
                Err(e) => {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(error=%e,"Stored tool state could not be read");
                    }
                    Value::Null
                }
            }
        };
        let saved = read("goals");
        let (goal, seen) = if valid_goal(&saved) {
            (saved.clone(), saved)
        } else {
            (
                if valid_goal(&saved["current"]) {
                    saved["current"].clone()
                } else {
                    Value::Null
                },
                if valid_goal(&saved["seen"]) {
                    saved["seen"].clone()
                } else {
                    Value::Null
                },
            )
        };
        let todos = read("todos");
        Self {
            goal: Mutex::new(goal),
            seen: Mutex::new(seen),
            todos: Mutex::new(if todos.is_array() { todos } else { json!([]) }),
            directory,
            session_id,
        }
    }
    fn persist(&self, kind: &str, value: &Value) {
        let Some(dir) = &self.directory else {
            return;
        };
        let path = dir.join(kind).join(format!("{}.json", self.session_id));
        let result = std::fs::create_dir_all(path.parent().unwrap())
            .and_then(|_| std::fs::write(&path, serde_json::to_vec_pretty(value).unwrap()));
        if let Err(e) = result {
            tracing::warn!(kind,error=%e,"Tool state persistence failed");
        }
    }
    fn persist_goal(&self) {
        if self.get_goal().is_null() && self.seen.lock().unwrap().is_null() {
            if let Some(directory) = &self.directory {
                match std::fs::remove_file(
                    directory
                        .join("goals")
                        .join(format!("{}.json", self.session_id)),
                ) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        tracing::warn!(session_id = self.session_id, error = %error, "Goal persistence failed")
                    }
                }
            }
            return;
        }
        self.persist(
            "goals",
            &json!({"current":self.get_goal(),"seen":self.seen.lock().unwrap().clone()}),
        );
    }
    pub fn capture(&self) -> Value {
        json!({"goal":{"current":self.get_goal(),"seen":self.seen.lock().unwrap().clone()},"todos":self.todos()})
    }
    pub fn discard_persisted(&self) {
        let Some(directory) = &self.directory else {
            return;
        };
        for kind in ["goals", "todos"] {
            match std::fs::remove_file(
                directory
                    .join(kind)
                    .join(format!("{}.json", self.session_id)),
            ) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(kind, session_id = self.session_id, error = %error, "Stored tool state could not be removed")
                }
            }
        }
    }
    pub fn release(&self) {
        *self.goal.lock().unwrap()=Value::Null;
        *self.seen.lock().unwrap()=Value::Null;
        *self.todos.lock().unwrap()=json!([]);
        self.discard_persisted();
    }
    pub fn restore(&self, snapshot: &Value) {
        *self.goal.lock().unwrap() = snapshot["goal"]["current"].clone();
        *self.seen.lock().unwrap() = snapshot["goal"]["seen"].clone();
        *self.todos.lock().unwrap() = snapshot["todos"].clone();
        self.persist_goal();
        self.persist("todos", &snapshot["todos"]);
    }
    pub fn get_goal(&self) -> Value {
        self.goal.lock().unwrap().clone()
    }
    pub fn set_goal(&self, input: Value) -> Result<Value> {
        let goal = if input.is_null() {
            Value::Null
        } else {
            let objective = input["objective"]
                .as_str()
                .map(crate::js::trim_js)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    Error::new("INVALID_GOAL", "")
                        .with_harness(TextId::ToolsGoalInvalidObjective, &[])
                        .with_details(json!({"name":"TypeError"}))
                })?;
            json!({"objective":objective,"doneWhen":criteria(&input["doneWhen"]),"status":"active","updatedBy":"user","updatedAt":now()})
        };
        *self.goal.lock().unwrap() = goal.clone();
        self.persist_goal();
        Ok(goal)
    }
    pub fn drain_goal_change(&self) -> Value {
        let goal = self.get_goal();
        let mut seen = self.seen.lock().unwrap();
        let same = if goal.is_null() || seen.is_null() {
            goal == *seen
        } else {
            ["objective", "status", "doneWhen"]
                .iter()
                .all(|k| goal[*k] == seen[*k])
        };
        if same {
            return Value::Null;
        }
        let change = json!({"previous":*seen,"current":goal});
        *seen = goal;
        drop(seen);
        self.persist_goal();
        change
    }
    pub fn goal(&self, input: &Value) -> Value {
        self.goal_with_harness(input, &crate::harness::baseline())
    }
    pub fn goal_with_harness(&self, input: &Value, harness: &ResolvedHarness) -> Value {
        let active = self.get_goal();
        let active = if active["status"] == "active" {
            active
        } else {
            Value::Null
        };
        let action = input["action"].as_str().unwrap_or("");
        let objective = input["objective"]
            .as_str()
            .map(crate::js::trim_js)
            .filter(|s| !s.is_empty());
        let note = input["note"]
            .as_str()
            .map(crate::js::trim_js)
            .filter(|s| !s.is_empty());
        let mut goal = match action {
            "set" => {
                let Some(objective) = objective else {
                    return failure(harness.text(TextId::ToolsGoalSetRequiresObjective));
                };
                json!({"objective":objective,"doneWhen":criteria(&input["doneWhen"]),"status":"active"})
            }
            "update" | "complete" | "abandon" => {
                if active.is_null() {
                    return failure(harness.text(match action {
                        "update" => TextId::ToolsGoalNoActiveUpdate,
                        "complete" => TextId::ToolsGoalNoActiveComplete,
                        _ => TextId::ToolsGoalNoActiveAbandon,
                    }));
                }
                active.clone()
            }
            _ => return failure(harness.text(TextId::ToolsGoalInvalidAction)),
        };
        if action == "update" {
            if let Some(objective) = objective {
                goal["objective"] = json!(objective);
            }
            if let Some(v) = input
                .get("doneWhen")
                .filter(|value| !crate::js::is_undefined(value))
            {
                goal["doneWhen"] = criteria(v);
            }
        }
        if action == "complete" {
            goal["status"] = json!("complete");
        }
        if action == "abandon" {
            goal["status"] = json!("abandoned");
        }
        if let Some(note) = note {
            goal["note"] = json!(note);
        } else if action != "update" {
            goal.as_object_mut().unwrap().remove("note");
        }
        goal["updatedBy"] = json!("agent");
        goal["updatedAt"] = json!(now());
        *self.goal.lock().unwrap() = goal.clone();
        *self.seen.lock().unwrap() = goal.clone();
        self.persist_goal();
        let prefix = harness.text(match action {
            "set" => TextId::ToolsGoalSet,
            "update" => TextId::ToolsGoalUpdated,
            "complete" => TextId::ToolsGoalCompleted,
            _ => TextId::ToolsGoalAbandoned,
        });
        success(
            format!(
                "{prefix}\n{}{}",
                crate::core::goal_reminders::render_goal_with_harness(&goal, harness),
                if action == "set" && !active.is_null() {
                    harness.render(
                        TextId::ToolsGoalReplaced,
                        &[("objective", active["objective"].as_str().unwrap())],
                    )
                } else {
                    String::new()
                }
            ),
            None,
        )
    }
    pub fn todos(&self) -> Value {
        self.todos.lock().unwrap().clone()
    }
    pub fn todo_attachment(&self) -> Option<Value> {
        self.todo_attachment_with_harness(&crate::harness::baseline())
    }
    pub fn todo_attachment_with_harness(&self, harness: &ResolvedHarness) -> Option<Value> {
        let todos = self.todos();
        let todos = todos.as_array().filter(|todos| !todos.is_empty())?;
        let list = todos
            .iter()
            .map(|todo| {
                format!(
                    "{} {}",
                    match todo["status"].as_str().unwrap_or("") {
                        "completed" => "[x]",
                        "in_progress" => "[~]",
                        "pending" => "[ ]",
                        _ => "undefined",
                    },
                    crate::js::to_string(&todo["content"])
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Some(
            json!({"role":"user","content":[{"type":"text","text":harness.render(TextId::ContextTodosReminder, &[("list", &list)])}]}),
        )
    }
    pub fn set_todos(&self, input: &Value) -> Value {
        self.set_todos_with_harness(input, &crate::harness::baseline())
    }
    pub fn set_todos_with_harness(&self, input: &Value, harness: &ResolvedHarness) -> Value {
        let Some(raw) = input["todos"].as_array() else {
            return failure(harness.text(TextId::ToolsTodosMissing));
        };
        let mut todos = Vec::new();
        for item in raw {
            let content = &item["content"];
            let status = item["status"].as_str().unwrap_or("");
            if !crate::js::truthy(content) || !crate::js::truthy(&item["status"]) {
                return failure(harness.text(TextId::ToolsTodosMissingFields));
            }
            if !["pending", "in_progress", "completed"].contains(&status) {
                return failure(harness.render(
                    TextId::ToolsTodosInvalidStatus,
                    &[("status", &crate::js::to_string(&item["status"]))],
                ));
            }
            todos.push(json!({"content":content,"status":status,"activeForm":if crate::js::truthy(&item["activeForm"]) {&item["activeForm"]}else{content}}));
        }
        let done = todos.iter().all(|v| v["status"] == "completed");
        if done {
            todos.clear();
        }
        let list = todos
            .iter()
            .map(|v| {
                format!(
                    "{} {}",
                    match v["status"].as_str().unwrap() {
                        "completed" => "[x]",
                        "in_progress" => "[~]",
                        _ => "[ ]",
                    },
                    crate::js::to_string(&v["content"])
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let value = Value::Array(todos);
        *self.todos.lock().unwrap() = value.clone();
        self.persist("todos", &value);
        success(
            if done {
                harness.text(TextId::ToolsTodosCompleted).into()
            } else {
                harness.render(TextId::ToolsTodosUpdated, &[("list", &list)])
            },
            None,
        )
    }
}
