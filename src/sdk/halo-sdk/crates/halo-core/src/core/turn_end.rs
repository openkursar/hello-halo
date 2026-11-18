use serde_json::Value;

#[derive(Default)]
pub(crate) struct CheckMemory {
    pub(crate) asked: Option<String>,
}

#[derive(Default)]
pub(crate) struct TodoWatch {
    seen: Option<String>,
    quiet: u32,
}

impl TodoWatch {
    /// Call once per model request. Returns the number of quiet requests when a reminder is due.
    pub(crate) fn observe(&mut self, todos: &[Value], interval: u32) -> Option<u32> {
        let key = crate::js::stringify(&Value::Array(
            todos.iter().map(|todo| serde_json::json!([todo["content"], todo["status"]])).collect(),
        ));
        if self.seen.as_deref() != Some(key.as_str()) {
            self.seen = Some(key);
            self.quiet = 0;
            return None;
        }
        self.quiet += 1;
        let unfinished = todos.iter().any(|todo| todo["status"] != "completed");
        if unfinished && interval > 0 && self.quiet >= interval {
            return Some(std::mem::take(&mut self.quiet));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn todo(content: &str, status: &str) -> Value {
        json!({"content":content,"status":status})
    }

    #[test]
    fn a_reminder_is_due_after_a_quiet_interval_and_repeats() {
        let mut watch = TodoWatch::default();
        let list = [todo("a", "in_progress"), todo("b", "pending")];
        assert_eq!(watch.observe(&list, 3), None, "the first sight starts the count");
        assert_eq!(watch.observe(&list, 3), None);
        assert_eq!(watch.observe(&list, 3), None);
        assert_eq!(watch.observe(&list, 3), Some(3));
        assert_eq!(watch.observe(&list, 3), None, "the count starts over after a reminder");
        assert_eq!(watch.observe(&list, 3), None);
        assert_eq!(watch.observe(&list, 3), Some(3));
    }

    #[test]
    fn a_change_to_the_list_restarts_the_count() {
        let mut watch = TodoWatch::default();
        let first = [todo("a", "in_progress")];
        let second = [todo("a", "completed"), todo("b", "in_progress")];
        watch.observe(&first, 2);
        watch.observe(&first, 2);
        assert_eq!(watch.observe(&second, 2), None);
        assert_eq!(watch.observe(&second, 2), None);
        assert_eq!(watch.observe(&second, 2), Some(2));
    }

    #[test]
    fn no_reminder_without_unfinished_items_or_with_a_zero_interval() {
        let mut watch = TodoWatch::default();
        let done = [todo("a", "completed")];
        for _ in 0..5 {
            assert_eq!(watch.observe(&done, 2), None);
            assert_eq!(watch.observe(&[], 2), None);
        }
        let open = [todo("a", "pending")];
        let mut watch = TodoWatch::default();
        for _ in 0..5 {
            assert_eq!(watch.observe(&open, 0), None);
        }
    }
}
