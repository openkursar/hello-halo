use super::store::ScopeStore;
use crate::error::{Error, Result};
use crate::harness::TextId;
use serde_json::{json, Value};
use std::sync::Arc;

pub trait BlackboardStore: Send + Sync {
    fn insert_task(&self, task: Value) -> Result<()>;
    fn get_task(&self, id: &str) -> Option<Value>;
    fn try_get_task(&self, id: &str) -> Result<Option<Value>> {
        Ok(self.get_task(id))
    }
    fn update_task(&self, id: &str, patch: Value, now: Value) -> Result<()>;
    fn insert_finding(&self, finding: Value) -> Result<()>;
    fn insert_activity(&self, activity: Value) -> Result<()>;
}
impl<T: ScopeStore> BlackboardStore for T {
    fn insert_task(&self, task: Value) -> Result<()> {
        self.record(json!({"kind":"task","value":task}))
    }
    fn get_task(&self, id: &str) -> Option<Value> {
        self.get("task", id)
    }
    fn try_get_task(&self, id: &str) -> Result<Option<Value>> {
        self.try_get("task", id)
    }
    fn update_task(&self, id: &str, patch: Value, now: Value) -> Result<()> {
        ScopeStore::update_task(self, id, patch, now)
    }
    fn insert_finding(&self, finding: Value) -> Result<()> {
        self.record(json!({"kind":"finding","value":finding}))
    }
    fn insert_activity(&self, activity: Value) -> Result<()> {
        self.record(json!({"kind":"activity","value":activity}))
    }
}

pub type BoardObserver = Arc<dyn Fn(Value) -> Result<()> + Send + Sync>;
pub struct BlackboardWriter {
    store: Arc<dyn BlackboardStore>,
    on_change: Option<BoardObserver>,
    on_write: Option<BoardObserver>,
    clock: Arc<dyn Fn() -> Result<Value> + Send + Sync>,
    create_id: Arc<dyn Fn() -> Result<String> + Send + Sync>,
}
impl BlackboardWriter {
    pub fn new(
        store: Arc<dyn BlackboardStore>,
        on_change: Option<BoardObserver>,
        on_write: Option<BoardObserver>,
    ) -> Self {
        Self {
            store,
            on_change,
            on_write,
            clock: Arc::new(|| Ok(super::protocol::now().into())),
            create_id: Arc::new(|| Ok(super::protocol::id())),
        }
    }
    pub fn with_clock_and_ids(
        mut self,
        clock: Arc<dyn Fn() -> u64 + Send + Sync>,
        create_id: Arc<dyn Fn() -> String + Send + Sync>,
    ) -> Self {
        self.clock = Arc::new(move || Ok(clock().into()));
        self.create_id = Arc::new(move || Ok(create_id()));
        self
    }
    pub fn with_fallible_clock_and_ids(
        mut self,
        clock: Option<Arc<dyn Fn() -> Result<Value> + Send + Sync>>,
        create_id: Option<Arc<dyn Fn() -> Result<String> + Send + Sync>>,
    ) -> Self {
        if let Some(clock) = clock {
            self.clock = clock;
        }
        if let Some(create_id) = create_id {
            self.create_id = create_id;
        }
        self
    }
    fn emit(&self, change: Value) {
        if let Some(observer) = &self.on_change {
            let team = change["teamId"].as_str().unwrap_or("").to_owned();
            let epoch = change["epochId"].as_str().unwrap_or("").to_owned();
            let kind = change["kind"].as_str().unwrap_or("").to_owned();
            if let Err(error) = observer(change) {
                tracing::warn!("[Blackboard] Observer failed after write: team={team} epoch={epoch} kind={kind}: {error}");
            }
        }
    }
    fn notify_write(&self, record: Value) {
        if let Some(observer) = &self.on_write {
            let team = record["teamId"].as_str().unwrap_or("").to_owned();
            let epoch = record["epochId"].as_str().unwrap_or("").to_owned();
            let op = record["op"].as_str().unwrap_or("").to_owned();
            if let Err(error) = observer(record) {
                tracing::warn!("[Blackboard] Replication observer failed after write: team={team} epoch={epoch} op={op}: {error}");
            }
        }
    }
    pub fn post_task(&self, input: &Value) -> Result<Value> {
        if let Some(parent_id) = input["parentId"].as_str().filter(|v| !v.is_empty()) {
            if !self
                .store
                .try_get_task(parent_id)?
                .is_some_and(|v| v["teamId"] == input["teamId"] && v["epochId"] == input["epochId"])
            {
                return Err(Error::new("task_parent_scope", "").with_harness(TextId::CollaborationFeedbackTaskParentScope, &[])
                .with_details(
                    json!({"teamId":input["teamId"],"epochId":input["epochId"],"taskId":parent_id}),
                ));
            }
        }
        let now = (self.clock)()?;
        let id = (self.create_id)()?;
        let task = json!({"id":id,"teamId":input["teamId"],"epochId":input["epochId"],"title":input["title"],"assigneeAppId":input["assigneeAppId"],"status":"pending","resultRef":null,"note":null,"parentId":input["parentId"],"createdByAppId":input["callerAppId"],"createdAt":now,"updatedAt":now});
        self.store.insert_task(task.clone())?;
        self.emit(
            json!({"teamId":input["teamId"],"epochId":input["epochId"],"kind":"task","task":task}),
        );
        self.notify_write(json!({"teamId":input["teamId"],"epochId":input["epochId"],"op":"post_task","payload":task,"taskId":id}));
        Ok(json!({"taskId":id}))
    }
    pub fn update_task(&self, input: &Value) -> Result<()> {
        let id = input["taskId"].as_str().unwrap_or("");
        if !self
            .store
            .try_get_task(id)?
            .is_some_and(|v| v["teamId"] == input["teamId"] && v["epochId"] == input["epochId"])
        {
            return Err(Error::new("task_update_scope", "")
                .with_harness(TextId::CollaborationFeedbackTaskUpdateScope, &[])
                .with_details(
                    json!({"teamId":input["teamId"],"epochId":input["epochId"],"taskId":id}),
                ));
        }
        let now = (self.clock)()?;
        let mut patch = json!({"status":input["status"]});
        for key in ["resultRef", "note"] {
            if let Some(value) = input.get(key) {
                patch[key] = value.clone();
            }
        }
        self.store.update_task(id, patch.clone(), now.clone())?;
        if let Some(task) = self.store.try_get_task(id)? {
            self.emit(json!({"teamId":input["teamId"],"epochId":input["epochId"],"kind":"task","task":task}));
        }
        let mut payload = json!({"taskId":id,"status":input["status"]});
        for key in ["resultRef", "note"] {
            if let Some(value) = input.get(key) {
                payload[key] = value.clone();
            }
        }
        payload["updatedAt"] = now;
        self.notify_write(json!({"teamId":input["teamId"],"epochId":input["epochId"],"op":"update_task","payload":payload,"taskId":id}));
        Ok(())
    }
    pub fn post_finding(&self, input: &Value) -> Result<Value> {
        let id = (self.create_id)()?;
        let finding = json!({"id":id,"teamId":input["teamId"],"epochId":input["epochId"],"authorAppId":input["callerAppId"],"body":input["content"],"ref":input["ref"],"createdAt":(self.clock)()?});
        self.store.insert_finding(finding.clone())?;
        self.emit(json!({"teamId":input["teamId"],"epochId":input["epochId"],"kind":"finding","finding":finding}));
        self.notify_write(json!({"teamId":input["teamId"],"epochId":input["epochId"],"op":"post_finding","payload":finding}));
        Ok(json!({"findingId":id}))
    }
    pub fn post_activity(&self, input: &Value) -> Result<Value> {
        let id = match input["id"].as_str() {
            Some(id) => id.to_owned(),
            None => (self.create_id)()?,
        };
        let activity = json!({"id":id,"teamId":input["teamId"],"epochId":input["epochId"],"kind":input["kind"],"actorAppId":input["actorAppId"],"targetAppId":input["targetAppId"],"subject":input["subject"],"body":input["body"],"refId":input["refId"],"correlationId":input["correlationId"],"status":input["status"],"createdAt":(self.clock)()?});
        self.store.insert_activity(activity.clone())?;
        self.emit(json!({"teamId":input["teamId"],"epochId":input["epochId"],"kind":"activity","activity":activity}));
        self.notify_write(json!({"teamId":input["teamId"],"epochId":input["epochId"],"op":"post_activity","payload":activity}));
        Ok(json!({"activityId":id}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collaboration::store::MemoryStore;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };
    #[test]
    fn failed_observer_does_not_roll_back_committed_record_or_skip_replication() {
        let store =
            Arc::new(MemoryStore::new("team".into(), "work".into(), 100, 100000, None).unwrap());
        let changes = Arc::new(AtomicUsize::new(0));
        let writes = Arc::new(Mutex::new(Vec::new()));
        let change_count = changes.clone();
        let recorded = writes.clone();
        let writer = BlackboardWriter::new(
            store.clone(),
            Some(Arc::new(move |_| {
                change_count.fetch_add(1, Ordering::SeqCst);
                Err(Error::new("FIXTURE_FAILURE", "observer unavailable"))
            })),
            Some(Arc::new(move |record| {
                recorded.lock().unwrap().push(record);
                Ok(())
            })),
        )
        .with_clock_and_ids(Arc::new(|| 42), Arc::new(|| "task-id".into()));
        assert_eq!(writer.post_task(&json!({"teamId":"team","epochId":"work","callerAppId":"lead","title":"verify","assigneeAppId":"member"})).unwrap(),json!({"taskId":"task-id"}));
        assert_eq!(store.get("task", "task-id").unwrap()["createdAt"], 42);
        assert_eq!(changes.load(Ordering::SeqCst), 1);
        assert_eq!(writes.lock().unwrap()[0]["op"], "post_task");
        assert!(writer
            .update_task(
                &json!({"teamId":"other","epochId":"work","taskId":"task-id","status":"done"})
            )
            .is_err());
        assert_eq!(store.get("task", "task-id").unwrap()["status"], "pending");
        assert_eq!(changes.load(Ordering::SeqCst), 1);
    }
}
