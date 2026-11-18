use super::*;
use super::working_state::WorkingState;

#[test]
fn goal_actions_preserve_fields_validation_and_terminal_state() {
    let state = WorkingState::new(&json!({"persistSession":false}));
    assert_eq!(state.goal(&json!({"action":"complete"}))["isError"], true);
    assert_eq!(state.goal(&json!({"action":"update","objective":"x"}))["isError"], true);
    assert_eq!(state.goal(&json!({"action":"set","objective":"  "}))["isError"], true);
    assert_eq!(state.goal(&json!({"action":"delete"}))["isError"], true);
    let result = state.goal(&json!({"action":"set","objective":"  Ship ","doneWhen":["a","  ","b"]}));
    assert_eq!(result["isError"], false);
    assert!(result["content"].as_str().unwrap().contains("Objective: Ship"));
    assert_eq!(state.get_goal()["objective"], "Ship");
    assert_eq!(state.get_goal()["doneWhen"], json!(["a","b"]));
    assert_eq!(state.get_goal()["status"], "active");
    assert_eq!(state.get_goal()["updatedBy"], "agent");
    assert!(state.drain_goal_change().is_null());
    state.goal(&json!({"action":"update","doneWhen":["c"]}));
    assert_eq!(state.get_goal()["objective"], "Ship");
    state.goal(&json!({"action":"update","objective":"Ship v2"}));
    assert_eq!(state.get_goal()["doneWhen"], json!(["c"]));
    let replacement = state.goal(&json!({"action":"set","objective":"Second"}));
    assert!(replacement["content"].as_str().unwrap().contains("Replaced the previous goal: Ship v2"));
    state.goal(&json!({"action":"complete","note":"verified"}));
    assert_eq!(state.get_goal()["status"], "complete");
    assert_eq!(state.get_goal()["note"], "verified");
    assert_eq!(state.goal(&json!({"action":"abandon"}))["isError"], true);
    state.goal(&json!({"action":"set","objective":"Again"}));
    state.goal(&json!({"action":"abandon","note":"cancelled"}));
    assert_eq!(state.get_goal()["status"], "abandoned");
}

#[test]
fn host_goal_changes_are_delivered_once_and_reverts_are_quiet() {
    let state = WorkingState::new(&json!({"persistSession":false}));
    state.set_goal(json!({"objective":"Launch","doneWhen":["Headline"]})).unwrap();
    let change = state.drain_goal_change();
    assert!(change["previous"].is_null());
    assert_eq!(change["current"]["objective"], "Launch");
    assert_eq!(change["current"]["updatedBy"], "user");
    assert!(state.drain_goal_change().is_null());
    state.goal(&json!({"action":"set","objective":"Ship","doneWhen":["a"]}));
    state.set_goal(json!({"objective":"Other"})).unwrap();
    state.set_goal(json!({"objective":"Ship","doneWhen":["a"]})).unwrap();
    assert!(state.drain_goal_change().is_null());
    state.set_goal(Value::Null).unwrap();
    let change = state.drain_goal_change();
    assert_eq!(change["previous"]["objective"], "Ship");
    assert!(change["current"].is_null());
    assert!(state.get_goal().is_null());
    assert_eq!(state.set_goal(json!({"objective":"  "})).unwrap_err().details.unwrap()["name"], "TypeError");
}

#[test]
fn goal_persistence_retains_unseen_changes_and_accepts_legacy_files() {
    let directory = std::env::temp_dir().join(format!("halo-goal-owner-{}", uuid::Uuid::new_v4()));
    let options = json!({"sessionId":"goal","env":{"CLAUDE_CONFIG_DIR":directory}});
    let file = directory.join("goals/goal.json");
    let state = WorkingState::new(&options);
    state.goal(&json!({"action":"set","objective":"Ship","doneWhen":["a"]}));
    assert!(file.exists());
    drop(state);
    let state = WorkingState::new(&options);
    assert_eq!(state.get_goal()["objective"], "Ship");
    assert!(state.drain_goal_change().is_null());
    state.set_goal(Value::Null).unwrap();
    assert!(file.exists());
    drop(state);
    let state = WorkingState::new(&options);
    let change = state.drain_goal_change();
    assert_eq!(change["previous"]["objective"], "Ship");
    assert_eq!(change["previous"]["doneWhen"], json!(["a"]));
    assert!(change["current"].is_null());
    assert!(state.drain_goal_change().is_null());
    assert!(!file.exists());
    state.goal(&json!({"action":"set","objective":"Ship"}));
    state.set_goal(json!({"objective":"Ship v2"})).unwrap();
    drop(state);
    let state = WorkingState::new(&options);
    let change = state.drain_goal_change();
    assert_eq!(change["previous"]["objective"], "Ship");
    assert_eq!(change["current"]["objective"], "Ship v2");
    drop(state);
    let state = WorkingState::new(&options);
    assert!(state.drain_goal_change().is_null());
    std::fs::write(&file, r#"{"objective":"Legacy","doneWhen":[],"status":"active","updatedBy":"agent"}"#).unwrap();
    let state = WorkingState::new(&options);
    assert_eq!(state.get_goal()["objective"], "Legacy");
    assert!(state.drain_goal_change().is_null());
    state.discard_persisted();
    assert!(!file.exists());
    assert!(WorkingState::new(&options).get_goal().is_null());
    std::fs::write(&file, r#"{"objective":42}"#).unwrap();
    assert!(WorkingState::new(&options).get_goal().is_null());
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn todos_validate_replace_isolate_persist_clear_and_render_reminders() {
    let directory = std::env::temp_dir().join(format!("halo-todo-owner-{}", uuid::Uuid::new_v4()));
    let options = json!({"sessionId":"todos","env":{"CLAUDE_CONFIG_DIR":directory}});
    let state = WorkingState::new(&options);
    let other = WorkingState::new(&json!({"persistSession":false}));
    assert_eq!(state.todos(), json!([]));
    assert!(state.todo_attachment().is_none());
    for (input, text) in [
        (json!({}), "todos"),
        (json!({"todos":"bad"}), "todos"),
        (json!({"todos":[{"status":"pending"}]}), "content"),
        (json!({"todos":[{"content":"task"}]}), "status"),
        (json!({"todos":[{"content":"task","status":"unknown"}]}), "\"unknown\""),
    ] {
        let result = state.set_todos(&input);
        assert_eq!(result["isError"], true);
        assert!(result["content"].as_str().unwrap().contains(text));
    }
    let result = state.set_todos(&json!({"todos":[
        {"content":"task A","status":"pending","activeForm":"waiting"},
        {"content":"task B","status":"in_progress","activeForm":"working"}
    ]}));
    assert_eq!(result["isError"], false);
    for text in ["Todo list updated:", "[ ] task A", "[~] task B"] {
        assert!(result["content"].as_str().unwrap().contains(text));
    }
    assert_eq!(state.todos().as_array().unwrap().len(), 2);
    assert_eq!(state.todos()[0]["content"], "task A");
    assert_eq!(state.todos()[0]["status"], "pending");
    assert_eq!(other.todos(), json!([]));
    state.set_todos(&json!({"todos":[{"content":"new","status":"pending"}]}));
    assert_eq!(state.todos().as_array().unwrap().len(), 1);
    assert_eq!(state.todos()[0]["content"], "new");
    state.set_todos(&json!({"todos":[]}));
    assert_eq!(state.todos(), json!([]));
    let result = state.set_todos(&json!({"todos":[{"content":"done","status":"completed"}]}));
    assert!(result["content"].as_str().unwrap().contains("All todos completed"));
    assert_eq!(state.todos(), json!([]));
    let many: Vec<Value> = (0..20).map(|i| json!({"content":format!("task {i}"),"status":"pending"})).collect();
    state.set_todos(&json!({"todos":many}));
    assert_eq!(state.todos().as_array().unwrap().len(), 20);
    let content = "Fix bug: <HTML> & \"quotes\" — and em-dash";
    state.set_todos(&json!({"todos":[{"content":content,"status":"in_progress"}]}));
    assert_eq!(state.todos()[0]["content"], content);
    assert_eq!(state.todos()[0]["activeForm"], content);
    let disk: Value = serde_json::from_slice(&std::fs::read(directory.join("todos/todos.json")).unwrap()).unwrap();
    assert_eq!(disk, state.todos());
    assert_eq!(WorkingState::new(&options).todos(), state.todos());
    state.set_todos(&json!({"todos":[{"content":"task A","status":"pending"},{"content":"task B","status":"completed"}]}));
    assert_eq!(state.todos().as_array().unwrap().len(), 2);
    let attachment = state.todo_attachment().unwrap();
    assert_eq!(attachment["role"], "user");
    for text in ["<system-reminder>", "[ ] task A", "[x] task B"] {
        assert!(attachment["content"][0]["text"].as_str().unwrap().contains(text));
    }
    std::fs::remove_dir_all(directory).unwrap();
}
